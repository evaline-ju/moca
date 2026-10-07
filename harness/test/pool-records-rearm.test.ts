import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisRecordStore, recordsKey, type SandboxRecord } from '../src/pool-records.js';

/**
 * An ESTABLISHED store must survive Redis going away for longer than the reconnect bound (#423).
 *
 * Past the bound node-redis sets `isOpen` false and stops for good: every later command rejects
 * `ClientClosedError`. The connect that preceded the outage SUCCEEDED, so `ready` stays resolved and
 * the failed-connect re-arm cannot see it. The relay holds one store for its whole life
 * (sandbox-relay main.ts), so without a re-arm on `!isOpen` a Redis restart left it unable to write
 * or remove presence ever again.
 *
 * Redis is stood in for by a tiny RESP server so the outage is a deterministic close/reopen of one
 * port rather than a container restart. It answers just the commands this store sends.
 */
const rec: SandboxRecord = {
  sandboxId: 'sbx-rearm-1',
  labels: {},
  capabilities: [],
  capacityMax: 1,
  transport: 'grpc',
};

/** Parse RESP arrays of bulk strings out of `buf`; returns the commands and the unconsumed tail. */
function parse(buf: Buffer): { cmds: string[][]; rest: Buffer } {
  const cmds: string[][] = [];
  let off = 0;
  for (;;) {
    const start = off;
    const line = (): string | undefined => {
      const i = buf.indexOf('\r\n', off);
      if (i < 0) return undefined;
      const s = buf.subarray(off, i).toString();
      off = i + 2;
      return s;
    };
    const head = line();
    if (head === undefined || !head.startsWith('*')) {
      off = start;
      break;
    }
    const n = Number(head.slice(1));
    const args: string[] = [];
    let ok = true;
    for (let k = 0; k < n; k++) {
      const len = line();
      if (len === undefined || off + Number(len.slice(1)) + 2 > buf.length) {
        ok = false;
        break;
      }
      const l = Number(len.slice(1));
      args.push(buf.subarray(off, off + l).toString());
      off += l + 2;
    }
    if (!ok) {
      off = start;
      break;
    }
    cmds.push(args);
  }
  return { cmds, rest: buf.subarray(off) };
}

class FakeRedis {
  private server: net.Server | undefined;
  private readonly sockets = new Set<net.Socket>();
  readonly hash = new Map<string, string>();
  connections = 0;
  constructor(public port = 0) {}
  async start(): Promise<void> {
    const server = net.createServer((sock) => {
      this.connections++;
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
      sock.on('error', () => {});
      let pending: Buffer = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        const { cmds, rest } = parse(Buffer.concat([pending, chunk]));
        pending = rest;
        for (const [name, ...args] of cmds)
          sock.write(this.reply(String(name).toUpperCase(), args));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => resolve());
    });
    this.port = (server.address() as net.AddressInfo).port;
    this.server = server;
  }
  private reply(name: string, args: string[]): string {
    if (name === 'HSET' && args[0] === recordsKey()) {
      this.hash.set(args[1]!, args[2]!);
      return ':1\r\n';
    }
    if (name === 'HDEL') return `:${this.hash.delete(args[1]!) ? 1 : 0}\r\n`;
    if (name === 'HGETALL') {
      const parts = [...this.hash].flat();
      return `*${parts.length}\r\n${parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join('')}`;
    }
    if (name === 'PING') return '+PONG\r\n';
    return '+OK\r\n';
  }
  /** Stop listening AND drop every live connection: what a Redis restart looks like to a client. */
  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    this.server = undefined;
  }
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('RedisRecordStore re-arms after an established connection gives up', () => {
  let redis: FakeRedis | undefined;
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  afterEach(async () => {
    await redis?.stop();
    redis = undefined;
    spy?.mockRestore();
  });

  it('a put after an outage past the reconnect bound succeeds once Redis is back', async () => {
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    redis = new FakeRedis();
    await redis.start();
    const store = new RedisRecordStore(`redis://127.0.0.1:${redis.port}`, 1);
    await store.put(rec);
    expect(redis.hash.has(rec.sandboxId)).toBe(true);

    // The outage: Redis goes away and stays away until node-redis has given up for good.
    const port = redis.port;
    await redis.stop();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (store as any).client as { isOpen: boolean };
    await until(() => !client.isOpen);

    // Redis comes back on the same address.
    redis = new FakeRedis(port);
    await redis.start();

    await expect(store.put(rec)).resolves.toBeUndefined();
    expect(redis.hash.has(rec.sandboxId)).toBe(true);
    await expect(store.remove(rec.sandboxId)).resolves.toBeUndefined();
    expect(redis.hash.has(rec.sandboxId)).toBe(false);
    // The SAME client reconnected: one store, one client, so put-before-remove stays FIFO.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((store as any).client).toBe(client);
    await store.close();
  }, 20_000);

  it('a store closed on purpose is never reopened by a later call', async () => {
    redis = new FakeRedis();
    await redis.start();
    const store = new RedisRecordStore(`redis://127.0.0.1:${redis.port}`, 1);
    await store.put(rec);
    expect(redis.connections).toBe(1);

    await store.close();

    // select-sandbox's dropMemo closes a store precisely so nothing references it again; a call
    // through a stale handle must fail rather than resurrect a connection nothing will ever close.
    await expect(store.put(rec)).rejects.toThrow();
    await expect(store.list()).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    expect(redis.connections).toBe(1);
    await expect(store.close()).resolves.toBeUndefined();
  });
});

/**
 * A failed attempt must clear only ITS OWN memo (#428). node-redis sets `isOpen` false synchronously
 * when an attempt gives up, but the rejection takes several microtasks to reach connectOnce's
 * `.catch`. A call landing in that window sees `!isOpen`, re-arms, and memoises a second attempt;
 * the first `.catch` then used to wipe that newer memo, so a third call started a THIRD connect()
 * on a socket the second had already opened -- node-redis's `Socket already opened`.
 *
 * The client is a stand-in whose connect() the test settles by hand, so the interleaving is exact
 * rather than a timing race: one connect in flight, fail it, and call again before any microtask.
 */
describe('RedisRecordStore re-arm clears only its own memo (#428)', () => {
  function fakeClient() {
    const attempts: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    const client = {
      isOpen: false,
      connect: vi.fn(() => {
        // node-redis: connect() on an open socket rejects; otherwise it opens synchronously.
        if (client.isOpen) return Promise.reject(new Error('Socket already opened'));
        client.isOpen = true;
        return new Promise<void>((resolve, reject) => attempts.push({ resolve, reject }));
      }),
      hSet: vi.fn(async () => 1),
    };
    /** The attempt gives up the way node-redis's does: `isOpen` false first, the rejection after. */
    const fail = (i: number) => {
      client.isOpen = false;
      attempts[i]!.reject(new Error('redis unreachable'));
    };
    return { client, attempts, fail };
  }

  it('a call in a failed attempt`s rejection window keeps its new memo for the next caller', async () => {
    const store = new RedisRecordStore('redis://127.0.0.1:1', 1);
    const { client, attempts, fail } = fakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).client = client;

    const first = store.put(rec);
    expect(client.connect).toHaveBeenCalledTimes(1);

    // The attempt fails, and a second caller lands before its rejection reaches the .catch.
    fail(0);
    const second = store.put(rec);
    expect(client.connect).toHaveBeenCalledTimes(2);
    await expect(first).rejects.toThrow('redis unreachable');
    await new Promise((r) => setImmediate(r)); // every microtask of the first attempt has run

    // A third caller must share the second attempt, not start a connect on its open socket.
    const third = store.put(rec);
    attempts[1]!.resolve();
    await expect(second).resolves.toBeUndefined();
    await expect(third).resolves.toBeUndefined();
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(client.hSet).toHaveBeenCalledTimes(2);
  });
});
