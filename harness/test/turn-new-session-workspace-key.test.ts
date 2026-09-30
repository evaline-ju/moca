import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A new session's FIRST turn must lease its sandbox under the id the session was just given.
 *
 * `executeTurn` opens the session before it acquires (turn-session-before-lease.test.ts pins that
 * order), so by the time it leases, a `/turn` that omitted `sessionId` already has one. It used to
 * pass `input.sessionId` — undefined for a new session — so `acquireTurnSandbox` fell back to the
 * per-turn lease holder (`anon:<uuid>`) as the workspace key. Two failures followed:
 *
 *  - On the microVM tier every tool call of that first turn failed: `:` is not legal in a
 *    `workspace_key` (`invalid-workspace-key … must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}`), seen on
 *    the KVM rig (#369).
 *  - On any tier that keys workspaces, turn 1 wrote into a workspace no later turn of the session
 *    would ever see again — turn 2 opened `workspace_key=<session id>`, a different, empty one.
 *
 * Authenticated turns never hit it: the token names an already-created session, so `sessionId` is set.
 */
const { selectCalls, FakeRedisSessionBackend } = vi.hoisted(() => {
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
  return {
    selectCalls: [] as { sessionId: string; holderId: string | undefined }[],
    FakeRedisSessionBackend,
  };
});

vi.mock('@moca/session-backend', () => ({
  RedisSessionBackend: FakeRedisSessionBackend,
  swallowRedisErrors: () => {},
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async () => ({ session: { prompt: async () => {} } }),
  DefaultResourceLoader: class {},
  getAgentDir: () => '/fake/agent-dir',
  SessionManager: {
    create: () => ({ getSessionId: () => 'sess-created' }),
    openFromCheckpoint: async (id: string) => ({ getSessionId: () => id }),
  },
  SettingsManager: { create: () => ({}) },
}));

// Capture what the selection seam is asked for, then stop the turn there.
vi.mock('../src/select-sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/select-sandbox.js')>();
  return {
    ...actual,
    selectPoolSandbox: async (
      _env: unknown,
      _cwd: string,
      sessionId: string,
      opts: { holderId?: string },
    ): Promise<never> => {
      selectCalls.push({ sessionId, holderId: opts.holderId });
      throw new actual.SandboxPoolEmptyError('app=sandbox');
    },
  };
});

const { executeTurn } = await import('../src/run-turn.js');

beforeEach(() => {
  selectCalls.length = 0;
  process.env.KAGENTI_SANDBOX_POOL_SELECTOR = 'app=sandbox';
});

describe('executeTurn: the workspace key is the session id, including on a new session', () => {
  it("keys a new session's first turn by the id it was just given, not the lease holder", async () => {
    await executeTurn({ prompt: 'hi', createIfAbsent: false }).catch(() => {});

    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0].sessionId).toBe('sess-created');
    // The holder stays unique per turn, but is derived from the same session id.
    expect(selectCalls[0].holderId).toMatch(/^sess-created:/);
  });

  it('keys a resumed session by its own id, as before', async () => {
    await executeTurn({ prompt: 'hi', sessionId: 'sess-existing', createIfAbsent: false }).catch(
      () => {},
    );

    expect(selectCalls[0].sessionId).toBe('sess-existing');
    expect(selectCalls[0].holderId).toMatch(/^sess-existing:/);
  });
});
