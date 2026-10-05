import { describe, expect, it, vi } from 'vitest';
import {
  selectPoolSandbox,
  SandboxAffinityPendingError,
  SandboxPoolEmptyError,
  SandboxPoolSaturatedError,
  type SelectDeps,
} from '../src/select-sandbox.js';
import type { LeaseStore } from '../src/sandbox-lease.js';
import type { SandboxRecord } from '../src/pool-records.js';

export const rec = (id: string, tier?: string): SandboxRecord => ({
  sandboxId: id,
  labels: tier === undefined ? {} : { 'moca.dev/tier': tier },
  capabilities: [],
  capacityMax: 4,
  transport: 'grpc',
});

export function fakeLease(loads: Record<string, number> = {}) {
  const counts = { ...loads };
  const acquired: string[] = [];
  const released: string[] = [];
  const lease: LeaseStore = {
    load: async (p) => counts[p] ?? 0,
    acquire: async (p, cap) => {
      if ((counts[p] ?? 0) >= cap) return false;
      counts[p] = (counts[p] ?? 0) + 1;
      acquired.push(p);
      return true;
    },
    heartbeat: async () => {},
    release: async (p) => {
      counts[p] = Math.max(0, (counts[p] ?? 0) - 1);
      released.push(p);
    },
  };
  return { lease, acquired, released, counts };
}

const fakeTransport = {
  exec: async () => ({ stdout: Buffer.alloc(0), exitCode: 0, truncated: false }),
  close: async () => {},
};

export const env = (extra: Record<string, string> = {}) =>
  ({
    KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sbx',
    SH_SANDBOX_DISCOVERY: 'records',
    ...extra,
  }) as NodeJS.ProcessEnv;
export const TIERS = {
  SH_SANDBOX_TIERS: 'container,microvm',
  SH_SANDBOX_DEFAULT_TIER: 'container',
};
export const opts = (o: Record<string, unknown> = {}) => ({
  cap: 2,
  ttlMs: 60_000,
  remoteSandbox: true,
  ...o,
});

/** Every test builds deps here, so Task 5 adds its affinity fake in ONE place. */
export function deps(
  recs: SandboxRecord[],
  lease: LeaseStore,
  extra: Partial<SelectDeps> = {},
): SelectDeps {
  return {
    records: { put: async () => {}, remove: async () => {}, list: async () => recs },
    lease,
    makeExecClient: () => ({}) as never,
    makeTransport: () => fakeTransport,
    ...extra,
  };
}

describe('selectPoolSandbox: tier filter (P6.3 spec §4 step 1)', () => {
  it('no tiers declared: nothing is filtered, an unlabelled record is selected', async () => {
    const { lease } = fakeLease();
    const sel = await selectPoolSandbox(env(), '/h', 's-1', opts(), deps([rec('a')], lease));
    expect(sel?.sandboxId).toBe('a');
    expect(sel?.tier).toBe('');
  });

  it('tiers declared: only the session tier is a candidate, however loaded the others are', async () => {
    const { lease } = fakeLease({ 'c-1': 1 }); // the container sandbox is the more loaded one
    const recs = [rec('c-1', 'container'), rec('m-1', 'microvm')];
    for (const tier of ['container', 'microvm'] as const) {
      const sel = await selectPoolSandbox(
        env(TIERS),
        '/h',
        `s-${tier}`,
        opts({ tier }),
        deps(recs, lease),
      );
      expect(sel?.sandboxId).toBe(tier === 'container' ? 'c-1' : 'm-1');
      expect(sel?.tier).toBe(tier);
    }
  });

  it('an undefined or empty requested tier is the deployment default (Review Focus 2)', async () => {
    const recs = [rec('c-1', 'container'), rec('m-1', 'microvm')];
    for (const tier of [undefined, '']) {
      const { lease } = fakeLease({ 'c-1': 1 });
      const sel = await selectPoolSandbox(
        env(TIERS),
        '/h',
        's-x',
        opts({ tier }),
        deps(recs, lease),
      );
      expect(sel?.sandboxId).toBe('c-1');
      expect(sel?.tier).toBe('container');
    }
  });

  it('an unlabelled record is excluded while tiers are declared, with ONE log line per id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recs = [rec('bare-1'), rec('c-1', 'container')];
    for (let i = 0; i < 3; i++) {
      const { lease } = fakeLease();
      const sel = await selectPoolSandbox(env(TIERS), '/h', `s-${i}`, opts(), deps(recs, lease));
      expect(sel?.sandboxId).toBe('c-1');
    }
    const lines = warn.mock.calls.filter((c) => String(c[0]).includes("'bare-1'"));
    expect(lines).toHaveLength(1);
    expect(String(lines[0][0])).toContain('moca.dev/tier');
    warn.mockRestore();
  });

  it('a tier with no attached sandbox is SandboxPoolEmptyError naming the tier', async () => {
    const { lease } = fakeLease();
    const p = selectPoolSandbox(
      env(TIERS),
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([rec('c-1', 'container')], lease),
    );
    await expect(p).rejects.toBeInstanceOf(SandboxPoolEmptyError);
    await expect(p).rejects.toThrow("sandbox tier 'microvm'");
  });

  it('pods (discovery both) count as the default tier only', async () => {
    const { lease } = fakeLease();
    const e = env({ ...TIERS, SH_SANDBOX_DISCOVERY: 'both' });
    const d = deps([rec('m-1', 'microvm')], lease, { listPods: async () => ['pod-0'] });
    expect(
      (await selectPoolSandbox(e, '/h', 's-c', opts({ tier: 'container' }), d))?.sandboxId,
    ).toBe('pod-0');
    expect((await selectPoolSandbox(e, '/h', 's-m', opts({ tier: 'microvm' }), d))?.sandboxId).toBe(
      'm-1',
    );
  });

  it('a bad SH_SANDBOX_TIERS fails the selection naming the variable', async () => {
    const { lease } = fakeLease();
    const p = selectPoolSandbox(
      env({ SH_SANDBOX_TIERS: 'a,b' }),
      '/h',
      's',
      opts(),
      deps([rec('a', 'a')], lease),
    );
    await expect(p).rejects.toThrow('SH_SANDBOX_DEFAULT_TIER is required');
  });
});

describe('SandboxAffinityPendingError', () => {
  it('is a SandboxPoolSaturatedError, so every leaf path classifies it saturated (retryable)', () => {
    const e = new SandboxAffinityPendingError('m-0', 12_300);
    expect(e).toBeInstanceOf(SandboxPoolSaturatedError);
    expect(e.name).toBe('SandboxAffinityPendingError');
    expect(e.sandboxId).toBe('m-0');
    expect(e.retryInMs).toBe(12_300);
    expect(e.message).toContain("'m-0'");
    expect(e.message).toContain('13s');
  });
});
