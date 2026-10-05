import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Structural guard: nothing on the per-turn path may construct a Redis client.
 *
 * Every Redis client class in this repo connects EAGERLY in its constructor, so "one per turn" is
 * one live connection per turn. That was latent for years because a turn was served by a Knative
 * container that went away afterwards. The P6 supervisor made it fatal: a worker is process-lived
 * and admits S concurrent turns for hours, so the connections accumulate.
 *
 * Measured on real hardware at 27-54 turns/s:
 *
 *   before: ~3.5 connections per turn, monotonically leaked (RedisSessionBackend per turn in
 *           executeTurnCore, RedisLeaseStore per call in selectPoolSandbox and never closed,
 *           RedisRecordStore per call and closed) -> 35,654 connections over ~10k turns ->
 *           `ERR max number of clients reached` against maxclients 10000 -> node-redis raised an
 *           'error' on clients with no listener -> ALL FOUR WORKERS exited code 1 simultaneously,
 *           mid-rung, ~13 minutes in, stranding every in-flight turn.
 *   after:  0.017 connections per turn across a second warm batch, connected_clients delta 0.
 *
 * No unit test could see this: each construction is individually correct, the leak is only visible
 * as an aggregate over thousands of turns, and a suite that mocks Redis never opens a socket. Hence
 * a source-level assertion — cheap, and it fails the moment someone reintroduces the pattern.
 */
const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

/** Same, for a sibling workspace package. */
const pkgSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../packages/${rel}`, import.meta.url)), 'utf8');

/** Strip block and line comments, so the prose above (and in the sources) cannot satisfy a check. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('no Redis client is constructed per turn', () => {
  it('executeTurnCore does not construct a RedisSessionBackend', () => {
    const body = code(src('run-turn.ts'));
    // Permitted exactly once, inside the process-wide memo. A second occurrence means someone put
    // one back on the turn path.
    const constructions = body.match(/new RedisSessionBackend/g) ?? [];
    expect(constructions).toHaveLength(1);
    expect(body).toMatch(/sessionStoreMemo\s*=\s*\{[^}]*new RedisSessionBackend/s);
    // The turn path must take the shared one.
    expect(body).toMatch(/const store = sharedSessionStore\(redisUrl\)/);
  });

  it('selectPoolSandbox does not construct a lease or record store per call', () => {
    const body = code(src('select-sandbox.ts'));
    expect(body.match(/new RedisLeaseStore/g) ?? []).toHaveLength(1);
    expect(body.match(/new RedisRecordStore/g) ?? []).toHaveLength(1);
    // Both permitted occurrences must be the memo assignments, not call-site constructions.
    expect(body).toMatch(/leaseMemo\s*=\s*\{[^}]*new RedisLeaseStore/s);
    expect(body).toMatch(/recordsMemo\s*=\s*\{[^}]*new RedisRecordStore/s);
    expect(body).toMatch(/deps\.lease \?\? sharedLease\(/);
    expect(body.match(/new RedisAffinityStore/g) ?? []).toHaveLength(1);
    expect(body).toMatch(/affinityMemo\s*=\s*\{[^}]*new RedisAffinityStore/s);
    expect(body).toMatch(/deps\.affinity \?\? sharedAffinity\(/);
  });

  it('the shared stores are dropped on failure rather than cached broken', () => {
    // Caching a client that never connected would convert one transient Redis failure into a
    // permanent one for the life of the process: a permanent "no sandboxes" for records, and a
    // permanent inability to acquire for leases.
    const body = code(src('select-sandbox.ts'));
    expect(body).toMatch(/function guard</);
    expect(body).toMatch(/recordsMemo = null/);
    expect(body).toMatch(/leaseMemo = null/);
    expect(body).toMatch(/affinityMemo = null/);
    // The eviction must be identity-checked, or a rejection arriving after the memo was rebuilt
    // discards a store that never failed (and orphans it, connected and unreferenced).
    expect(body).toMatch(/read\(\)\?\.store !== store/);
  });

  it('the memoised SESSION store cannot cache a client that never connected either', () => {
    // This case used to assert the drop-guard against select-sandbox.ts alone, which exempted the one
    // store built WITHOUT a guard -- run-turn.ts's sharedSessionStore. That store is safe for a
    // different reason, so assert the property where it actually lives or the two drift apart again:
    // RedisSessionBackend re-arms its own connect, which fixes every caller of the class rather than
    // this one memo. The behavioural pin is packages/session-backend/test/redis-backend-rearm.test.ts;
    // this is the structural half, next to the memo whose safety depends on it.
    const memo = code(src('run-turn.ts'));
    expect(memo).toMatch(/const store = sharedSessionStore\(redisUrl\)/);

    const backend = code(pkgSrc('session-backend/src/redis-backend.ts'));
    // A failed attempt clears itself...
    expect(backend).toMatch(/this\.ready = null/);
    // ...and the next caller starts a fresh one rather than awaiting the rejected promise.
    expect(backend).toMatch(/this\.ready \?\?= this\.arm\(\)/);
    // Nothing may reintroduce a once-assigned field that can never be re-armed.
    expect(backend).not.toMatch(/private ready: Promise<void>;/);
  });

  it('proves the guard can fail: the forbidden pattern is detectable', () => {
    // An absence-assertion that has never been shown capable of failing asserts nothing.
    const withRegression = code(`
      async function executeTurnCore() {
        const store = new RedisSessionBackend<FileEntry>(redisUrl);
      }
      let sessionStoreMemo = { url, store: new RedisSessionBackend<FileEntry>(url) };
    `);
    expect(withRegression.match(/new RedisSessionBackend/g) ?? []).toHaveLength(2);
  });
});
