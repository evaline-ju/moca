import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { detachedKey, RedisRecordStore } from '@moca/harness';
import {
  resetSharedStores,
  SandboxAffinityPendingError,
  selectPoolSandbox,
  type SelectedSandbox,
} from '@moca/harness/select-sandbox';
import { createRelay } from '../src/relay.js';
import { detachMarks } from '../src/main.js';

// Unique tier names per run: sh:sandbox:records is one hash shared with every other suite on this
// Redis, and a tier filter is exactly what makes foreign records invisible to this test.
const run = randomUUID().slice(0, 8);
const CT = `ct-${run}`;
const MV = `mv-${run}`;
const IDS: Record<string, string[]> = {
  [CT]: [`c0-${run}`, `c1-${run}`],
  [MV]: [`m0-${run}`, `m1-${run}`],
};
const ALL = [...IDS[CT], ...IDS[MV]];
const tierOf = (id: string) => (IDS[CT].includes(id) ? CT : MV);

const baseEnv = {
  KAGENTI_SANDBOX_POOL_SELECTOR: 'app=it',
  SH_SANDBOX_DISCOVERY: 'records',
  SH_SANDBOX_TIERS: `${CT},${MV}`,
  SH_SANDBOX_DEFAULT_TIER: CT,
  SH_SANDBOX_AFFINITY_TTL_SECONDS: '300', // so this run's keys expire on their own
  SH_SANDBOX_AFFINITY_GRACE_SECONDS: '30',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
} as NodeJS.ProcessEnv;

function fakeAttach() {
  const s = new EventEmitter() as EventEmitter & {
    metadata: { get: (k: string) => string[] };
    write: (f: unknown) => void;
    end: () => void;
    emitData: (f: unknown) => void;
  };
  s.metadata = { get: () => ['Bearer t'] };
  s.write = () => {};
  s.end = () => s.emit('end');
  s.emitData = (f) => s.emit('data', f);
  return s;
}

const records = new RedisRecordStore(baseEnv.REDIS_URL);
const relay = createRelay({
  records,
  detach: detachMarks(records, baseEnv),
  validateToken: () => true,
});
const streams = new Map<string, ReturnType<typeof fakeAttach>>();
const fakeTransport = {
  exec: async () => ({ stdout: Buffer.alloc(0), exitCode: 0, truncated: false }),
  close: async () => {},
};

async function present(ids: string[], want: boolean) {
  await vi.waitFor(
    async () => {
      const listed = new Set((await records.list()).map((r) => r.sandboxId));
      expect(ids.every((id) => listed.has(id) === want)).toBe(true);
    },
    { timeout: 5_000, interval: 50 },
  );
}
async function attach(ids: string[]) {
  for (const id of ids) {
    const s = fakeAttach();
    relay.onAttach(s as never);
    s.emitData({
      hello: {
        sandboxId: id,
        labels: { 'moca.dev/tier': tierOf(id) },
        capabilities: [],
        image: '',
        arch: 'amd64',
        capacityMax: 8,
        trust: 'untrusted',
      },
    });
    streams.set(id, s);
  }
  await present(ids, true);
}
async function detach(ids: string[]) {
  for (const id of ids) streams.get(id)?.emit('end');
  await present(ids, false);
}
const select = (sid: string, tier: string, env = baseEnv) =>
  selectPoolSandbox(
    env,
    '/h',
    sid,
    { cap: 8, ttlMs: 60_000, remoteSandbox: true, tier },
    {
      makeExecClient: () => ({}) as never,
      makeTransport: () => fakeTransport,
    },
  );

describe('tiers and affinity end to end (P6.3 spec §8)', () => {
  const first = new Map<string, string>();
  const sessions = Array.from({ length: 20 }, (_, i) => ({
    sid: `s-${run}-${i}`,
    tier: i % 2 ? MV : CT,
  }));
  // The pending and moved paths warn by design (and a foreign unlabelled record on this shared Redis
  // would too); silenced so the run's output stays clean, and asserted where the warning is the point.
  let warn: ReturnType<typeof vi.spyOn>;
  // A raw client, separate from the relay's store, so the detach mark's TTL is read from Redis itself.
  const raw = createClient({ url: baseEnv.REDIS_URL });

  beforeAll(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await raw.connect();
  });

  afterAll(async () => {
    await detach([...streams.keys()].filter((id) => ALL.includes(id))).catch(() => {});
    resetSharedStores();
    await records.close();
    await raw.close();
    warn.mockRestore();
  });

  it('every turn stays in its tier and on its first sandbox, and new sessions spread by load', async () => {
    await attach(ALL);
    // Turn 1 of every session, leases HELD so load (and so the least-loaded choice) builds up.
    const held: SelectedSandbox[] = [];
    for (const { sid, tier } of sessions) {
      const sel = (await select(sid, tier))!;
      expect(IDS[tier]).toContain(sel.sandboxId);
      first.set(sid, sel.sandboxId!);
      held.push(sel);
    }
    await Promise.all(held.map((h) => h.release()));
    for (const tier of [CT, MV]) {
      const used = new Set(sessions.filter((s) => s.tier === tier).map((s) => first.get(s.sid)));
      expect(used.size).toBe(2);
    }
    // Turns 2 and 3: each session returns to its sandbox, whatever the load now is.
    for (let turn = 0; turn < 2; turn++) {
      for (const { sid, tier } of sessions) {
        const sel = (await select(sid, tier))!;
        expect(sel.sandboxId).toBe(first.get(sid));
        expect(sel.workspaceReset).toBeUndefined();
        await sel.release();
      }
    }
  });

  it('a relay restart (every worker detaches and reattaches) moves no session', async () => {
    await detach(ALL);
    // In the gap, a session with affinity waits for its own sandbox rather than moving.
    await expect(select(sessions[1].sid, sessions[1].tier)).rejects.toBeInstanceOf(
      SandboxAffinityPendingError,
    );
    await attach(ALL);
    for (const { sid, tier } of sessions) {
      const sel = (await select(sid, tier))!;
      expect(sel.sandboxId).toBe(first.get(sid));
      await sel.release();
    }
  });

  it('a sandbox gone past the grace: its sessions move within their tier and report the reset', async () => {
    const gone = IDS[MV][0];
    const onGone = sessions.filter((s) => first.get(s.sid) === gone);
    expect(onGone.length).toBeGreaterThan(0);
    await detach([gone]);
    // The relay's mark carries the affinity TTL (detachMarks wires SH_SANDBOX_AFFINITY_TTL_SECONDS),
    // so a mark for a sandbox that never returns expires with the affinity that could read it.
    const pttl = await raw.pTTL(detachedKey(gone));
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(300_000);
    await expect(select(onGone[0].sid, MV)).rejects.toBeInstanceOf(SandboxAffinityPendingError);
    const zeroGrace = { ...baseEnv, SH_SANDBOX_AFFINITY_GRACE_SECONDS: '0' } as NodeJS.ProcessEnv;
    for (const { sid } of onGone) {
      const sel = (await select(sid, MV, zeroGrace))!;
      expect(sel.sandboxId).toBe(IDS[MV][1]);
      expect(sel.workspaceReset).toEqual({ from: gone, reason: 'detached' });
      await sel.release();
      // ...and the move sticks: the next turn is on the new sandbox, with no further reset.
      const again = (await select(sid, MV))!;
      expect(again.sandboxId).toBe(IDS[MV][1]);
      expect(again.workspaceReset).toBeUndefined();
      await again.release();
    }
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`moved from '${gone}' to '${IDS[MV][1]}'`),
    );
  });
});
