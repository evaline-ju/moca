import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApiError } from './api/errors.js';
import type { ControlPlaneApi } from './api/types.js';
import { authLockPath, loadAuth, saveAuth, type CachedAuth, type Paths } from './config.js';
import { toCachedAuth } from './core/auth.js';

/**
 * The only way a mocactl command obtains an API token (B14 spec §5.2). The refresh token is single-use
 * and every use rotates it, so two refreshes at once would look like theft to the control plane: a
 * lock file serialises them -- across processes, and across concurrent calls within one process,
 * since O_EXCL is per file -- and whoever waited re-reads auth.json and uses the winner's result. The
 * new pair is written BEFORE the token is used, so a crash after the server rotated loses nothing the
 * grace window cannot recover.
 */

/** Refresh a token this close to expiry, so no request leaves with one that dies in flight. */
export const REFRESH_MARGIN_MS = 60_000;
/** A lock this old belongs to a process that died; break it. Wall clock (see EnsureDeps.now). */
export const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

export type EnsureResult =
  | { kind: 'ok'; auth: CachedAuth }
  | { kind: 'login_required' }
  | { kind: 'unreachable'; error: unknown };

export interface EnsureDeps {
  paths: Paths;
  controlPlaneUrl: string;
  cp: Pick<ControlPlaneApi, 'refreshAuth'>;
  /**
   * Decides whether the API token is fresh; injectable so a test can jump 12 hours. The LOCK uses the
   * wall clock instead, since other processes share the lock file but not this clock.
   */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  lockWaitMs?: number;
}

const fresh = (a: CachedAuth | null, nowMs: number): a is CachedAuth =>
  !!a && a.expiresAt * 1000 - nowMs > REFRESH_MARGIN_MS;
const valid = (a: CachedAuth | null, nowMs: number): a is CachedAuth =>
  !!a && a.expiresAt * 1000 > nowMs;

export async function ensureAuth(
  deps: EnsureDeps,
  opts: { force?: boolean } = {},
): Promise<EnsureResult> {
  // loadAuth returns null for another control plane's login: a refresh token is only ever sent to
  // the control plane that issued it (spec §4.6 of the mocactl design).
  const before = loadAuth(deps.paths, deps.controlPlaneUrl);
  if (!opts.force && fresh(before, deps.now())) return { kind: 'ok', auth: before };
  if (!before?.refreshToken) {
    // A cache from before B14, or one whose refresh was refused: today's behaviour.
    return !opts.force && valid(before, deps.now())
      ? { kind: 'ok', auth: before }
      : { kind: 'login_required' };
  }

  const lock = await acquireLock(authLockPath(deps.paths), deps);
  if ('error' in lock) return { kind: 'unreachable', error: lock.error };
  try {
    const current = loadAuth(deps.paths, deps.controlPlaneUrl);
    // A peer refreshed while we waited: its result is ours. Compared by token, so a forced refresh
    // whose peer already replaced the rejected token does not spend the new refresh token too.
    if (current && current.apiToken !== before.apiToken && fresh(current, deps.now())) {
      return { kind: 'ok', auth: current };
    }
    if (!current?.refreshToken) return { kind: 'login_required' };
    let next: CachedAuth;
    try {
      next = toCachedAuth(await deps.cp.refreshAuth(current.refreshToken), deps.controlPlaneUrl);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_grant') {
        // Revoked, expired or replayed: it will never work again, so stop presenting it.
        saveAuth(deps.paths, withoutRefresh(current));
        return { kind: 'login_required' };
      }
      return { kind: 'unreachable', error: err };
    }
    saveAuth(deps.paths, next); // before anyone uses it
    return { kind: 'ok', auth: next };
  } finally {
    lock.release();
  }
}

/** The login minus its refresh pair: what is left once the control plane refused the refresh token. */
export function withoutRefresh(auth: CachedAuth): CachedAuth {
  const rest = { ...auth };
  delete rest.refreshToken;
  delete rest.refreshExpiresAt;
  return rest;
}

type Lock = { release: () => void } | { error: unknown };

/**
 * O_EXCL create; a stale lock is broken, a live one waited on up to lockWaitMs. Any other failure
 * (EACCES on the config dir, say) comes back as an error rather than a throw, so a command reports
 * it instead of dying with a stack trace.
 */
async function acquireLock(path: string, deps: EnsureDeps): Promise<Lock> {
  const deadline = Date.now() + (deps.lockWaitMs ?? LOCK_WAIT_MS);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch (error) {
    return { error };
  }
  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, String(process.pid)); // for a human reading the lock; nothing parses it
      } catch {
        // The lock is ours either way.
      } finally {
        closeSync(fd);
      }
      return { release: () => rmSync(path, { force: true }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { error };
    }
    let ageMs: number;
    try {
      ageMs = Date.now() - statSync(path).mtimeMs;
    } catch {
      continue; // released between our open and our stat: try again at once
    }
    if (ageMs > STALE_LOCK_MS) {
      rmSync(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      return { error: new Error('another mocactl is refreshing this login') };
    }
    await deps.sleep(50);
  }
}
