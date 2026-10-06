import { describe, expect, it, vi, beforeEach } from 'vitest';

const { attachMock, detachMock, FakeRedisSessionBackend } = vi.hoisted(() => {
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
  const detachMock = vi.fn(async () => {});
  const attachMock = vi.fn(async (..._args: unknown[]) => ({
    promotedConfig: { digest: 'd' },
    detach: detachMock,
  }));
  return { attachMock, detachMock, FakeRedisSessionBackend };
});

vi.mock('@moca/session-backend', () => ({
  RedisSessionBackend: FakeRedisSessionBackend,
  swallowRedisErrors: () => {},
  resilientClientOptions: (url: string) => ({ url }),
}));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async () => ({ session: { prompt: async () => {} } }),
  // No reload(): the core fails right after the attach point, which is all these tests need.
  DefaultResourceLoader: class {},
  getAgentDir: () => '/fake/agent-dir',
  SessionManager: {
    create: () => ({ getSessionId: () => 'sess-1' }),
    openFromCheckpoint: async () => ({ getSessionId: () => 'sess-1' }),
  },
  SettingsManager: { create: () => ({}) },
}));
vi.mock('../src/promoted-config.js', () => ({
  attachPromotedConfig: (...args: unknown[]) => attachMock(...args),
}));

const { executeTurn } = await import('../src/run-turn.js');
const digest = 'sha256:' + 'c'.repeat(64);
const sandbox = { config: { pod: 'p', namespace: 'n' } as never };

beforeEach(() => {
  attachMock.mockClear();
  detachMock.mockClear();
});

describe('executeTurn configRef', () => {
  it('attaches the bundle to the turn sandbox and detaches even when the turn throws', async () => {
    await expect(
      executeTurn({
        prompt: 'hi',
        sessionId: 'sess-1',
        createIfAbsent: true,
        sandbox,
        configRef: digest,
      }),
    ).rejects.toThrow();
    expect(attachMock).toHaveBeenCalledWith(
      expect.objectContaining({
        digest,
        sessionId: 'sess-1',
        sandbox: expect.objectContaining({ config: sandbox.config }),
      }),
    );
    expect(detachMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a configRef', async () => {
    await expect(
      executeTurn({ prompt: 'hi', sessionId: 'sess-1', createIfAbsent: true, sandbox }),
    ).rejects.toThrow();
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('leaves a pre-resolved promotedConfig (the /runs path) alone', async () => {
    await expect(
      executeTurn({
        prompt: 'hi',
        sessionId: 'sess-1',
        createIfAbsent: true,
        sandbox,
        configRef: digest,
        promotedConfig: { digest } as never,
      }),
    ).rejects.toThrow();
    expect(attachMock).not.toHaveBeenCalled();
  });
});
