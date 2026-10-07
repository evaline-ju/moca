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
    create: () => ({ getSessionId: () => 'opened-1' }),
    openFromCheckpoint: async () => ({ getSessionId: () => 'opened-1' }),
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
        sessionId: 'opened-1',
        sandbox: expect.objectContaining({ config: sandbox.config }),
      }),
    );
    expect(detachMock).toHaveBeenCalledTimes(1);
  });

  it('gives every turn its own ref on the digest, distinct from the session id', async () => {
    const turn = () =>
      executeTurn({
        prompt: 'hi',
        sessionId: 'sess-1',
        createIfAbsent: true,
        sandbox,
        configRef: digest,
      }).catch(() => {});
    await turn();
    await turn();
    const refIds = attachMock.mock.calls.map((c) => (c[0] as { refId?: string }).refId);
    expect(refIds).toHaveLength(2);
    for (const refId of refIds) expect(refId).toMatch(/^opened-1\.[0-9a-f]{32}$/);
    expect(refIds[0]).not.toBe(refIds[1]);
  });

  it('a failing detach does not replace the turn outcome', async () => {
    detachMock.mockRejectedValueOnce(new Error('detach boom'));
    const err = await executeTurn({
      prompt: 'hi',
      sessionId: 'sess-1',
      createIfAbsent: true,
      sandbox,
      configRef: digest,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toBe('detach boom');
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
