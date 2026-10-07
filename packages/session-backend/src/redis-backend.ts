// packages/session-backend/src/redis-backend.ts
import { createClient, type RedisClientType } from 'redis';
import { makeStoredEntry, type StoredEntry } from './entry';
import { resilientClientOptions, swallowRedisErrors } from './redis-errors';
import type { LogStore } from './backend';

const streamKey = (sid: string) => `session:${sid}`;
const seqKey = (sid: string) => `session:${sid}:seq`;

/**
 * Redis Streams implementation of LogStore. Single-writer-per-session: a session is
 * owned by one harness instance at a time (mobility is sequential handoff, never
 * concurrent), so INCR(position) then XADD is safe without a transaction.
 *
 * Stream-id scheme (M5 cutover): each entry is stored with the explicit id
 * `"<position>-0"` (e.g. `"3-0"`), enabling O(tail) seeks in `read(fromPosition)`.
 * Sessions written by pre-M5 code used `"*"` (auto-generated ids) and are NOT
 * back-compatible; treat them as throwaway / reset before use.
 */
export class RedisSessionBackend<E = unknown> implements LogStore<E> {
  private client: RedisClientType;
  private ready: Promise<void> | null;
  constructor(url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379') {
    // Bounded reconnect + listener as a pair: the listener alone would consume the error that makes a
    // failed connect() REJECT, and arm() re-arms precisely by catching that rejection — so without the
    // bound this store would not merely crash less, it would never re-arm. See redis-errors.ts.
    this.client = createClient(resilientClientOptions(url));
    swallowRedisErrors(this.client, 'session store');
    this.ready = this.arm();
  }

  /**
   * Connect, and RE-ARM on failure so a transient outage costs one call rather than the process.
   *
   * `ready` used to be assigned once here and never reassigned, so a single rejected `connect()` left
   * a permanently REJECTED promise that every method awaited. Redis coming back changed nothing; only
   * a restart cleared it.
   *
   * Worth being precise about which failures reach that path, and about what KEEPS them reaching it.
   * Probed against the pinned `redis@6.2.1`: a REFUSED connect rejects with `ECONNREFUSED` and a
   * black-holed SYN rejects with `ConnectionTimeoutError` once the 5s default `connectTimeout` fires.
   * In a cluster the second is the one to expect -- a Service with no ready endpoints, or a
   * NetworkPolicy drop, black-holes the SYN rather than refusing it. (That shape costs ~60 s to
   * reject, against ~5.5 s for a refused port at this bound -- see redis-errors.ts.)
   *
   * Both of those rejections were previously a SIDE EFFECT of having no `'error'` listener, and this
   * class now has one. That is why the client is built with `resilientClientOptions`: its bounded
   * reconnect strategy is what still abandons a hopeless attempt (as `ReconnectStrategyError`) once the
   * listener has consumed the error that used to do it. Without the bound, `connect()` would retry
   * forever, never settle, and this re-arm would never fire -- a wedge in place of a crash.
   *
   * That was survivable while callers built one backend per turn: a blip cost exactly one turn and
   * the next turn built a fresh client that connected. It stops being survivable the moment one is
   * memoised process-wide (run-turn.ts's `sharedSessionStore`), where the same unlucky moment --
   * most likely the FIRST turn after boot, the window the old per-turn leak never mattered in --
   * would poison every remaining turn for the worker's lifetime. The async path makes that worse
   * than a stall: the failure classifies as retryable (classify-outcome.ts), so the queue entry is
   * redelivered to the same poisoned process and fails instantly again -- a hot retry loop with no
   * backoff and no terminal state.
   *
   * Clearing the memo on rejection is what lets the next call retry instead of replaying the
   * original error. The identity check keeps a late failure from clearing a NEWER attempt, and the
   * side `.catch` is bookkeeping only -- callers still see the real rejection through the promise
   * they awaited, while a rejected connect that nobody is awaiting yet can no longer surface as an
   * unhandled rejection.
   *
   * That `.catch` covers the PROMISE channel only. The event channel -- an `'error'` emitted on the
   * client itself -- is what `swallowRedisErrors` is for, and it is the one that killed workers.
   */
  private arm(): Promise<void> {
    const attempt = this.client.connect().then(() => undefined);
    void attempt.catch(() => {
      if (this.ready === attempt) this.ready = null;
    });
    return attempt;
  }

  /**
   * Await the live connect attempt, starting a fresh one if the last one failed OR the socket was
   * permanently closed.
   *
   * Two channels can break the connection and only one of them rejects a promise. `arm()`'s `.catch`
   * covers the promise channel. The event channel is the one past `resilientClientOptions`' reconnect
   * bound: node-redis sets `isOpen` false, swallows its own `ReconnectStrategyError`, and rejects every
   * later command with `ClientClosedError` -- while `ready` stays RESOLVED from the connect that
   * succeeded, so nothing here would notice. See resilientClientOptions for the citations.
   *
   * Re-arming on `!isOpen` is safe: `connect()` throws `Socket already opened` only when `isOpen` is
   * true, which this branch excludes, and the terminal path clears `isOpen` BEFORE returning the error,
   * so the re-attempt genuinely happens.
   *
   * It also means a call after `close()` reconnects rather than rejecting. Deliberate, and not worth a
   * `closed` flag: the only closers are `sharedSessionStore`'s URL-change branch and
   * `resetSharedSessionStore()` (test-only), both of which are discarding the store anyway.
   */
  private open(): Promise<void> {
    if (this.ready && !this.client.isOpen) this.ready = null;
    return (this.ready ??= this.arm());
  }

  async nextPosition(sid: string): Promise<number> {
    await this.open();
    return this.client.incr(seqKey(sid));
  }

  async append(sid: string, entry: E, piType: string): Promise<StoredEntry<E>> {
    await this.open();
    const position = await this.nextPosition(sid);
    const stored = makeStoredEntry({
      position,
      session_id: sid,
      piType,
      entry,
      timestamp: Date.now(),
    });
    await this.client.xAdd(streamKey(sid), `${stored.position}-0`, {
      position: String(stored.position),
      timestamp: String(stored.timestamp),
      piType: stored.piType,
      entry: JSON.stringify(stored.entry),
      content_sha256: stored.content_sha256,
    });
    return stored;
  }

  async read(sid: string, fromPosition = 1): Promise<StoredEntry<E>[]> {
    await this.open();
    const start = fromPosition <= 1 ? '-' : `${fromPosition}-0`;
    const rows = await this.client.xRange(streamKey(sid), start, '+');
    // redis >=6.3 types the XRANGE reply as nullable; a missing stream reads as empty.
    return (rows ?? []).map((r): StoredEntry<E> => ({
      position: Number(r.message.position),
      timestamp: Number(r.message.timestamp),
      session_id: sid,
      piType: r.message.piType,
      entry: JSON.parse(r.message.entry) as E,
      content_sha256: r.message.content_sha256,
    }));
  }

  async latestWhere(sid: string, predicate: (entry: E) => boolean): Promise<StoredEntry<E> | null> {
    const all = await this.read(sid);
    const matches = all.filter((e) => predicate(e.entry));
    return matches.length ? matches[matches.length - 1] : null;
  }

  async positionOfId(sid: string, id: string): Promise<number | null> {
    const rows = await this.read(sid);
    for (const r of rows) {
      if ((r.entry as { id?: unknown } | null)?.id === id) return r.position;
    }
    return null;
  }

  async list(): Promise<string[]> {
    await this.open();
    const keys = await this.client.keys('session:*');
    return keys.filter((k) => !k.endsWith(':seq')).map((k) => k.slice('session:'.length));
  }

  /** Test helper: delete a session's stream + sequence counter. */
  async reset(sid: string): Promise<void> {
    await this.open();
    await this.client.del([streamKey(sid), seqKey(sid)]);
  }

  /**
   * Close the connection (call in test teardown).
   *
   * Deliberately does NOT propagate a failed connect: `await this.ready` meant a client that never
   * connected could not be closed AT ALL -- close() rejected, callers swallowed it with
   * `.catch(() => {})`, and the socket was left dangling. Swallow it here and close what is open.
   */
  async close(): Promise<void> {
    await this.ready?.catch(() => {});
    if (this.client.isOpen) await this.client.quit();
  }
}
