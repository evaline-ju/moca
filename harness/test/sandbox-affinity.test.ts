import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from 'redis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  affinityKey,
  affinityTimings,
  detachedKey,
  parseSandboxTiers,
  RedisAffinityStore,
  TIER_LABEL,
} from '../src/sandbox-affinity.js';

type Case = {
  name: string;
  env: Record<string, string>;
  expect?: { names: string[]; default: string } | null;
  error?: string;
};
const cases = JSON.parse(
  readFileSync(new URL('./fixtures/sandbox-tiers-cases.json', import.meta.url), 'utf8'),
) as Case[];

describe('parseSandboxTiers', () => {
  for (const c of cases) {
    it(c.name, () => {
      const env = c.env as NodeJS.ProcessEnv;
      if (c.error) expect(() => parseSandboxTiers(env)).toThrow(c.error);
      else expect(parseSandboxTiers(env)).toEqual(c.expect);
    });
  }
});

describe('keys and constants', () => {
  it('pins the wire names', () => {
    expect(TIER_LABEL).toBe('moca.dev/tier');
    expect(affinityKey('s-1')).toBe('sh:sandbox:affinity:s-1');
    expect(detachedKey('sbx-1')).toBe('sh:sandbox:detached:sbx-1');
  });
});

describe('affinityTimings', () => {
  it('defaults to 24 h and 60 s', () => {
    expect(affinityTimings({})).toEqual({ ttlMs: 86_400_000, graceMs: 60_000 });
  });
  it('reads seconds, and ignores empty or unparseable values', () => {
    expect(
      affinityTimings({
        SH_SANDBOX_AFFINITY_TTL_SECONDS: '3600',
        SH_SANDBOX_AFFINITY_GRACE_SECONDS: '5',
      }),
    ).toEqual({ ttlMs: 3_600_000, graceMs: 5_000 });
    expect(
      affinityTimings({
        SH_SANDBOX_AFFINITY_TTL_SECONDS: '',
        SH_SANDBOX_AFFINITY_GRACE_SECONDS: 'x',
      }),
    ).toEqual({ ttlMs: 86_400_000, graceMs: 60_000 });
  });
  it('allows a zero grace (fall back at once) but not a zero TTL', () => {
    expect(affinityTimings({ SH_SANDBOX_AFFINITY_GRACE_SECONDS: '0' }).graceMs).toBe(0);
    expect(affinityTimings({ SH_SANDBOX_AFFINITY_TTL_SECONDS: '0' }).ttlMs).toBe(86_400_000);
  });
});

describe('RedisAffinityStore (real Redis)', () => {
  const store = new RedisAffinityStore();
  const raw = createClient({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' });
  const sid = () => `aff-test-${randomUUID()}`;
  afterAll(async () => {
    await store.close();
    if (raw.isOpen) await raw.close();
  });

  it('get is null with no entry; claim sets it and returns it', async () => {
    const s = sid();
    expect(await store.get(s)).toBeNull();
    const won = await store.claim(s, { sandboxId: 'a', tier: 't' }, 60_000);
    expect(won).toEqual({ sandboxId: 'a', tier: 't' });
    expect(await store.get(s)).toEqual({ sandboxId: 'a', tier: 't' });
  });

  it('a second claim returns the FIRST entry and refreshes its TTL', async () => {
    const s = sid();
    await store.claim(s, { sandboxId: 'a', tier: 't' }, 1_000);
    const won = await store.claim(s, { sandboxId: 'b', tier: 't' }, 60_000);
    expect(won.sandboxId).toBe('a');
    if (!raw.isOpen) await raw.connect();
    expect(await raw.pTTL(affinityKey(s))).toBeGreaterThan(1_000);
  });

  it('replace overwrites', async () => {
    const s = sid();
    await store.claim(s, { sandboxId: 'a', tier: 't' }, 60_000);
    await store.replace(s, { sandboxId: 'b', tier: 't' }, 60_000);
    expect((await store.get(s))?.sandboxId).toBe('b');
  });

  // Review Focus 5: a corrupt entry is no affinity, and the next claim repairs it.
  it('a corrupt entry reads as null, logs, and is overwritten by claim', async () => {
    const s = sid();
    if (!raw.isOpen) await raw.connect();
    await raw.set(affinityKey(s), 'not json', { PX: 60_000 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await store.get(s)).toBeNull();
      expect(await store.claim(s, { sandboxId: 'c', tier: 't' }, 60_000)).toEqual({
        sandboxId: 'c',
        tier: 't',
      });
      await raw.set(affinityKey(s), JSON.stringify({ tier: 't' }), { PX: 60_000 }); // no sandboxId
      expect(await store.get(s)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(affinityKey(s)));
    } finally {
      warn.mockRestore();
    }
  });

  it('detachedSince keeps the first mark, and replaces a garbage one with now', async () => {
    const id = `sbx-${randomUUID()}`;
    expect(await store.detachedSince(id, 1_000, 60_000)).toBe(1_000);
    expect(await store.detachedSince(id, 5_000, 60_000)).toBe(1_000); // NX: the first mark stands
    if (!raw.isOpen) await raw.connect();
    await raw.set(detachedKey(id), 'garbage', { PX: 60_000 }); // Review Focus 4
    expect(await store.detachedSince(id, 9_000, 60_000)).toBe(9_000);
    // Lua tonumber accepts 'nan', 'inf', '-inf', etc. so they become NaN/Infinity, but the grace clock must end.
    // Verify that non-integer marks are replaced with the given now.
    const id2 = `sbx-${randomUUID()}`;
    await raw.set(detachedKey(id2), 'nan', { PX: 60_000 });
    expect(await store.detachedSince(id2, 2_000, 60_000)).toBe(2_000);
    const id3 = `sbx-${randomUUID()}`;
    await raw.set(detachedKey(id3), 'inf', { PX: 60_000 });
    expect(await store.detachedSince(id3, 3_000, 60_000)).toBe(3_000);
  });
});
