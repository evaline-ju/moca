import { describe, it, expect, vi } from 'vitest';

/**
 * `executeTurn`'s `onPlacement` (P6.3 spec §6): where a leased turn runs, handed to the caller as soon
 * as the lease is taken -- because a turn that then THROWS returns no result, and `result.sandbox`
 * was the only other way the placement reached the runtime report. A session that fell back to a
 * fresh sandbox and then failed its turn would otherwise never show that it lost its workspace.
 *
 * Same fakes as turn-lease-holder.test.ts: an inert session backend and Pi, and selectPoolSandbox
 * intercepted -- here to hand back a leased fallback selection, so executeTurn's real placement and
 * lease handling run, and the core throws at its first await (the resource loader's reload).
 */
const { release, FakeRedisSessionBackend } = vi.hoisted(() => {
  class FakeRedisSessionBackend {
    async read() {
      return [];
    }
    async latestWhere() {
      return null;
    }
    async append() {
      return {};
    }
    async list() {
      return [];
    }
    async close() {}
  }
  return { release: vi.fn(async () => {}), FakeRedisSessionBackend };
});

vi.mock('@moca/session-backend', () => ({
  RedisSessionBackend: FakeRedisSessionBackend,
  swallowRedisErrors: () => {},
}));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async () => ({ session: { prompt: async () => {} } }),
  DefaultResourceLoader: class {
    async reload() {
      throw new Error('boom: the turn failed after its sandbox was leased');
    }
  },
  getAgentDir: () => '/fake/agent-dir',
  SessionManager: {
    create: (_cwd: string, _snapshot: unknown, opts?: { id: string }) => ({
      getSessionId: () => opts?.id ?? 'sess-created',
    }),
    openFromCheckpoint: async (sid: string) => ({ getSessionId: () => sid }),
  },
  SettingsManager: { create: () => ({}) },
}));

vi.mock('../src/select-sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/select-sandbox.js')>();
  return {
    ...actual,
    selectPoolSandbox: async () => ({
      config: { pod: 'm-1', namespace: 'default', context: undefined, podCwd: '/w', headCwd: '/h' },
      leased: true,
      heartbeat: async () => {},
      release,
      sandboxId: 'm-1',
      tier: 'microvm',
      workspaceReset: { from: 'm-0', reason: 'detached' },
    }),
  };
});

const { executeTurn } = await import('../src/run-turn.js');

describe('executeTurn onPlacement', () => {
  it('reports the placement of a leased turn whose core then throws, and still releases', async () => {
    const placements: unknown[] = [];
    // ONE ordered log of both callbacks, so the order between them is asserted, not just each one.
    const log: string[] = [];
    const err = await executeTurn({
      prompt: 'hi',
      sessionId: 'sess-1',
      createIfAbsent: false,
      onPlacement: (p) => {
        placements.push(p);
        log.push('placement');
      },
      onEvent: (f) => log.push(f.type),
    }).catch((e: unknown) => e);

    expect((err as Error).message).toMatch(/^boom/);
    // The shape withPlacement attaches to a result, so a caller can use either interchangeably.
    expect(placements).toEqual([
      { id: 'm-1', tier: 'microvm', workspaceReset: { from: 'm-0', reason: 'detached' } },
    ]);
    // Reported before the workspace_reset frame goes out -- the first thing after the lease is taken.
    expect(log).toEqual(['placement', 'workspace_reset']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('still releases the lease when the callback itself throws', async () => {
    release.mockClear();
    const err = await executeTurn({
      prompt: 'hi',
      sessionId: 'sess-1',
      createIfAbsent: false,
      onPlacement: () => {
        throw new Error('callback failed');
      },
    }).catch((e: unknown) => e);

    expect((err as Error).message).toBe('callback failed');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
