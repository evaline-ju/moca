import type { CredentialConsumer, SessionSummary } from './api/types.js';
import { LoginCancelledError, apiTokenValid, deviceLogin, toCachedAuth } from './core/auth.js';
import {
  credentialProblem,
  credentialRequest,
  descriptionProblem,
  secretFromStdin,
} from './core/credential-checks.js';
import { formatDiagnostics, runDiagnostics } from './core/diagnostics.js';
import { describeError } from './core/messages.js';
import { sanitizeRemote } from './core/sanitize.js';
import { SessionManager, type ActiveSession } from './core/session-manager.js';
import {
  SESSION_OPTION_FIELDS,
  fieldRefusedByServer,
  resolveSessionOptions,
} from './core/session-options.js';
import { sessionManager, setAuth, type Runtime } from './runtime.js';

export interface Io {
  out(s: string): void;
  err(s: string): void;
}

// Only the control plane is required: it says where the harness is (GET /v1/discovery).
const MISSING = {
  controlPlaneUrl:
    'missing control-plane URL — pass --control-plane-url or set SH_CONTROL_PLANE_URL',
};

function missing(rt: Runtime, io: Io, need: Array<keyof typeof MISSING>): boolean {
  const absent = need.filter((k) => !rt.endpoints[k]);
  for (const k of absent) io.err(MISSING[k]);
  return absent.length > 0;
}

export async function cmdLogin(rt: Runtime, io: Io, signal?: AbortSignal): Promise<number> {
  if (missing(rt, io, ['controlPlaneUrl']) || !rt.cp) return 2;
  try {
    const login = await deviceLogin(
      { cp: rt.cp, sleep: rt.sleep, now: rt.now },
      (s) =>
        io.err(
          `Open ${sanitizeRemote(s.verificationUri)} and enter the code ${sanitizeRemote(s.userCode)}`,
        ),
      signal,
    );
    setAuth(rt, toCachedAuth(login, rt.endpoints.controlPlaneUrl!));
    io.err(`logged in as ${login.displayName ?? login.subject}`);
    return 0;
  } catch (err) {
    if (err instanceof LoginCancelledError) return 130;
    io.err(`login failed: ${describeError(err)}`);
    return 1;
  }
}

export async function cmdDoctor(rt: Runtime, io: Io, json: boolean): Promise<number> {
  if (missing(rt, io, ['controlPlaneUrl']) || !rt.cp || !rt.harness) return 2;
  const results = await runDiagnostics({
    cp: rt.cp,
    harness: rt.harness,
    controlPlaneUrl: rt.endpoints.controlPlaneUrl!,
    harnessOverridden: rt.endpoints.harnessUrl !== undefined,
    loggedIn: apiTokenValid(rt.auth, rt.now()),
  });
  io.out((json ? JSON.stringify(results) : formatDiagnostics(results)) + '\n');
  return results.every((r) => r.status === 'pass') ? 0 : 1;
}

export interface RunOptions {
  prompt: string;
  session?: string;
  options: Record<string, string>;
  json: boolean;
  signal?: AbortSignal;
}

/** False (with the reason on stderr) unless there is a control plane and a valid login for it. */
function ready(rt: Runtime, io: Io): rt is Runtime & Required<Pick<Runtime, 'cp' | 'harness'>> {
  if (missing(rt, io, ['controlPlaneUrl']) || !rt.cp || !rt.harness) return false;
  if (!apiTokenValid(rt.auth, rt.now())) {
    io.err('not logged in — run `mocactl login` first');
    return false;
  }
  return true;
}

export async function cmdRun(rt: Runtime, io: Io, opts: RunOptions): Promise<number> {
  if (!ready(rt, io)) return 2;
  const manager = new SessionManager({
    cp: rt.cp,
    harness: rt.harness,
    transcripts: rt.transcripts,
    now: rt.now,
    sleep: rt.sleep,
  });

  let session: ActiveSession;
  try {
    if (opts.session) {
      session = await manager.resume(opts.session);
    } else {
      const r = await resolveSessionOptions(
        rt.cp,
        SESSION_OPTION_FIELDS,
        opts.options,
        rt.config.lastUsed,
      );
      if (r.status === 'blocked') {
        io.err(`cannot start a session: ${r.field.emptyHint}`);
        return 2;
      }
      if (r.status === 'needs-input') {
        io.err(
          `choose the ${r.field.label.toLowerCase()} with --option ${r.field.key}=<value>: ${r.choices.map((c) => c.value).join(', ')}`,
        );
        return 2;
      }
      try {
        session = await manager.create(r.request);
      } catch (err) {
        const refused = fieldRefusedByServer(err, SESSION_OPTION_FIELDS);
        if (!refused) throw err;
        io.err(`cannot start a session: ${refused.emptyHint}`);
        return 2;
      }
    }
  } catch (err) {
    io.err(describeError(err));
    return 1;
  }

  io.err(`session ${session.sessionId}`);
  if (opts.json) io.out(JSON.stringify({ type: 'session', sessionId: session.sessionId }) + '\n');

  // A listener added to an already-aborted signal never fires, so a cancel that lands during
  // setup (resolveSessionOptions / create / resume, all above) would otherwise be missed and the
  // turn would run anyway. Check explicitly before submitting; the session itself stays intact
  // so the user can resume it.
  if (opts.signal?.aborted) return 130;

  type Outcome = 'done' | 'error' | 'cancelled';
  let outcome: Outcome = 'done';
  let failure: Error | undefined;
  session.on((e) => {
    if (e.kind === 'frame') {
      if (opts.json) io.out(JSON.stringify(e.frame) + '\n');
      // Plain text goes straight to a terminal; JSON output escapes control characters itself.
      else if (e.frame.type === 'text') io.out(sanitizeRemote(e.frame.delta));
    } else if (e.kind === 'retrying') {
      io.err(`the harness has no capacity — retrying in ${e.seconds}s`);
    } else if (e.kind === 'turn-end') {
      outcome = e.outcome;
      failure = e.error;
    }
  });
  opts.signal?.addEventListener('abort', () => session.cancel(), { once: true });
  session.submit(opts.prompt);
  await session.idle();

  if (!opts.json) io.out('\n');
  // `outcome` is reassigned inside the `session.on` closure above, which `session.idle()`
  // guarantees has already run by this point. TypeScript's control-flow narrowing can't see
  // through the closure boundary and treats `outcome` as still the literal 'done' here, so we
  // cast back to the declared union to read its real (possibly reassigned) value.
  if ((outcome as Outcome) === 'error') {
    io.err(describeError(failure));
    return 1;
  }
  return (outcome as Outcome) === 'cancelled' ? 130 : 0;
}

// The listing and management commands below share one output convention (README "Headless"):
// stdout carries only the result (an aligned table, or one JSON document with --json), and every
// message, including "nothing to list", goes to stderr. Exit codes are those of `run`.

/** Columns padded to their widest cell; the last column is left ragged. */
function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows
    .map((r) =>
      r
        .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

async function allSessions(rt: Runtime & { cp: NonNullable<Runtime['cp']> }) {
  const sessions: SessionSummary[] = [];
  const seen = new Set<number>();
  let cursor: number | undefined;
  for (;;) {
    const page = await rt.cp.listSessions({ limit: 200, cursor });
    sessions.push(...page.sessions);
    if (page.nextCursor === null) return sessions;
    // A cursor that comes back again would page forever.
    if (seen.has(page.nextCursor)) {
      throw new Error(`the control plane repeated the page cursor ${page.nextCursor}`);
    }
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export async function cmdSessions(rt: Runtime, io: Io, opts: { json: boolean }): Promise<number> {
  if (!ready(rt, io)) return 2;
  let sessions: SessionSummary[];
  try {
    sessions = await allSessions(rt);
  } catch (err) {
    io.err(describeError(err));
    return 1;
  }
  // Titles are local (renamed in the TUI, or the first prompt); the control plane keeps none.
  const rows = sessions.map((s) => ({
    sessionId: s.sessionId,
    title: rt.transcripts?.load(s.sessionId)?.title ?? null,
    state: s.state,
    createdAt: s.createdAt,
    lastTurnAt: s.lastTurnAt,
    turns: s.turns,
  }));
  if (opts.json) {
    io.out(JSON.stringify({ sessions: rows }) + '\n');
    return 0;
  }
  if (rows.length === 0) {
    io.err('no sessions');
    return 0;
  }
  const head = ['ID', 'CREATED (UTC)', 'LAST TURN (UTC)', 'TURNS', 'TITLE'];
  const body = rows.map((r) =>
    [
      r.sessionId,
      utc(r.createdAt),
      r.lastTurnAt === null ? '-' : utc(r.lastTurnAt),
      String(r.turns),
      r.title ?? '',
    ].map(sanitizeRemote),
  );
  io.out(table([head, ...body]) + '\n');
  return 0;
}

export async function cmdSessionDelete(
  rt: Runtime,
  io: Io,
  opts: { id: string; json: boolean },
): Promise<number> {
  if (!ready(rt, io)) return 2;
  let status: 'deleted' | 'accepted';
  try {
    // Through the session manager, so the local history goes too.
    status = await sessionManager(rt).remove(opts.id);
  } catch (err) {
    io.err(describeError(err));
    return 1;
  }
  const id = sanitizeRemote(opts.id);
  io.err(
    status === 'deleted'
      ? `deleted session ${id}`
      : `deleting session ${id}; the control plane finishes in the background`,
  );
  if (opts.json) io.out(JSON.stringify({ sessionId: opts.id, status }) + '\n');
  return 0;
}

export async function cmdCredentials(
  rt: Runtime,
  io: Io,
  opts: { json: boolean },
): Promise<number> {
  if (!ready(rt, io)) return 2;
  let rows;
  try {
    rows = (await rt.cp.listCredentials()).map((c) => ({
      name: c.name,
      kind: c.kind,
      consumer: c.consumer,
      hosts: c.destination.hosts,
      endpoint: c.endpoint ?? null,
    }));
  } catch (err) {
    io.err(describeError(err));
    return 1;
  }
  if (opts.json) {
    io.out(JSON.stringify({ credentials: rows }) + '\n');
    return 0;
  }
  if (rows.length === 0) {
    io.err('no credentials');
    return 0;
  }
  const head = ['NAME', 'KIND', 'CONSUMER', 'HOSTS', 'ENDPOINT'];
  const body = rows.map((r) =>
    [r.name, r.kind, r.consumer, r.hosts.join(','), r.endpoint ?? '-'].map(sanitizeRemote),
  );
  io.out(table([head, ...body]) + '\n');
  return 0;
}

export interface CredentialAddOptions {
  name: string;
  kind: string;
  consumer: CredentialConsumer;
  hosts: string[];
  endpoint?: string;
  json: boolean;
  /** The secret comes only from stdin, never argv, so it stays out of shell history and `ps`. */
  readStdin: () => Promise<string>;
  stdinIsTTY: boolean;
}

export async function cmdCredentialAdd(
  rt: Runtime,
  io: Io,
  opts: CredentialAddOptions,
): Promise<number> {
  if (!ready(rt, io)) return 2;
  const values = {
    name: opts.name,
    kind: opts.kind,
    consumer: opts.consumer,
    hosts: opts.hosts.join(','),
    endpoint: opts.endpoint ?? '',
  };
  // Everything but the secret is checked before stdin is read, so a typo costs no re-piping.
  const early = descriptionProblem(values);
  if (early) {
    io.err(early);
    return 2;
  }
  if (opts.stdinIsTTY) {
    io.err(
      'pipe the secret on stdin, e.g. `printf %s "$KEY" | mocactl credentials add …` (or use /credentials in the TUI)',
    );
    return 2;
  }
  const read = secretFromStdin(opts.kind, await opts.readStdin());
  if ('problem' in read) {
    io.err(read.problem);
    return 2;
  }
  const problem = credentialProblem(values, read.secret);
  if (problem) {
    io.err(problem);
    return 2;
  }
  const { name, req } = credentialRequest(values, read.secret);
  try {
    await rt.cp.putCredential(name, req);
  } catch (err) {
    io.err(describeError(err));
    return 1;
  }
  io.err(`stored credential ${sanitizeRemote(name)}`);
  if (opts.json) io.out(JSON.stringify({ name, status: 'stored' }) + '\n');
  return 0;
}

export async function cmdCredentialDelete(
  rt: Runtime,
  io: Io,
  opts: { name: string; json: boolean },
): Promise<number> {
  if (!ready(rt, io)) return 2;
  try {
    await rt.cp.deleteCredential(opts.name);
  } catch (err) {
    io.err(describeError(err));
    return 1;
  }
  io.err(`deleted credential ${sanitizeRemote(opts.name)}`);
  if (opts.json) io.out(JSON.stringify({ name: opts.name, status: 'deleted' }) + '\n');
  return 0;
}
