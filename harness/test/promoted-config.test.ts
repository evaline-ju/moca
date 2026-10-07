import { describe, expect, it, vi } from 'vitest';

const { kubectlTransportMock } = vi.hoisted(() => ({
  kubectlTransportMock: vi.fn((..._args: unknown[]) => ({
    exec: vi.fn(async () => ({ stdout: Buffer.from(''), exitCode: 0, truncated: false })),
    close: vi.fn(async () => {}),
  })),
}));
vi.mock('@moca/k8s-sandbox', () => ({
  KubectlTransport: (...args: unknown[]) => kubectlTransportMock(...args),
}));

import { attachPromotedConfig } from '../src/promoted-config.js';

const digest = 'sha256:' + 'c'.repeat(64);
const fakePromoted = {
  digest,
  root: '/tmp/sh-config/x',
  skillsDir: '/tmp/sh-config/x/skills',
  promptsDir: '/tmp/sh-config/x/prompts',
  context: [],
  promptFragments: [],
  entries: [{ path: 'skills/k/SKILL.md', content: Buffer.from('b') }],
};
const paths = {
  skillsDir: '/workspace/leaves/s1/.sh-config/skills',
  memoryDir: '/workspace/leaves/s1/.sh-config/memory',
};
const sandbox = { config: { pod: 'p', namespace: 'n' } as never };
const base = (over: Record<string, unknown> = {}) => ({
  digest,
  sessionId: 's1',
  sandbox,
  deps: {
    bundleRedis: {} as never,
    resolvePromotedConfig: vi.fn(async () => fakePromoted),
    overlayConfig: vi.fn(async () => paths),
  },
  ...over,
});

describe('attachPromotedConfig', () => {
  it('resolves only, and detaches as a no-op, when there is no sandbox', async () => {
    kubectlTransportMock.mockClear();
    const opts = base({ sandbox: null });
    const a = await attachPromotedConfig(opts);
    expect(a.promotedConfig).toBe(fakePromoted);
    expect(opts.deps.overlayConfig).not.toHaveBeenCalled();
    await a.detach();
    expect(kubectlTransportMock).not.toHaveBeenCalled();
  });

  it('overlays, advertises sandbox paths, and closes the transport it built', async () => {
    kubectlTransportMock.mockClear();
    const a = await attachPromotedConfig(base());
    expect(a.promotedConfig.sandboxSkillsDir).toBe(paths.skillsDir);
    expect(a.promotedConfig.promptFragments.at(-1)).toContain(`Skill files: ${paths.skillsDir}`);
    expect(kubectlTransportMock.mock.results[0]!.value.close).toHaveBeenCalledTimes(1);
  });

  it('reuses a leased transport and never closes it', async () => {
    kubectlTransportMock.mockClear();
    const transport = {
      exec: vi.fn(async () => ({ stdout: Buffer.from(''), exitCode: 0 })),
      close: vi.fn(),
    };
    const a = await attachPromotedConfig(base({ sandbox: { ...sandbox, transport } }));
    await a.detach();
    expect(kubectlTransportMock).not.toHaveBeenCalled();
    expect(transport.close).not.toHaveBeenCalled();
    expect(transport.exec).toHaveBeenCalledWith(
      expect.stringContaining('/workspace/leaves/s1/.sh-config'),
      expect.objectContaining({ timeout: 60 }),
    );
  });

  it('keys the ref by refId while the session link stays on sessionId', async () => {
    kubectlTransportMock.mockClear();
    const transport = {
      exec: vi.fn(async () => ({ stdout: Buffer.from(''), exitCode: 0 })),
      close: vi.fn(),
    };
    const opts = base({ refId: 's1.abc123', sandbox: { ...sandbox, transport } });
    const a = await attachPromotedConfig(opts);
    expect(opts.deps.overlayConfig).toHaveBeenCalledWith(
      transport,
      digest,
      's1',
      expect.any(Buffer),
      's1.abc123',
    );
    await a.detach();
    const script = (transport.exec.mock.calls[0] as unknown as [string])[0];
    expect(script).toContain('rm -f "$REFS/s1.abc123"');
    expect(script).not.toContain('rm -f "$REFS/s1"');
    expect(script).toContain("'/workspace/leaves/s1/.sh-config'");
  });

  it('tears the partial overlay down and rethrows when the overlay fails (#216)', async () => {
    kubectlTransportMock.mockClear();
    const opts = base();
    opts.deps.overlayConfig = vi.fn(async () => {
      throw new Error('config overlay failed (exit 1)');
    });
    await expect(attachPromotedConfig(opts)).rejects.toThrow('config overlay failed');
    const cleanup = kubectlTransportMock.mock.results[1]!.value;
    expect(cleanup.exec).toHaveBeenCalledWith(
      expect.stringContaining(`.refs/sha256-${'c'.repeat(64)}`),
      expect.objectContaining({ timeout: 60 }),
    );
  });

  it('detach is idempotent and swallows teardown errors', async () => {
    kubectlTransportMock.mockClear();
    const a = await attachPromotedConfig(base());
    kubectlTransportMock.mockImplementationOnce(() => ({
      exec: vi.fn(async () => {
        throw new Error('boom');
      }),
      close: vi.fn(async () => {}),
    }));
    await expect(a.detach()).resolves.toBeUndefined();
    await a.detach();
    expect(kubectlTransportMock).toHaveBeenCalledTimes(2); // overlay + ONE teardown
  });

  it('propagates a resolve failure without touching the sandbox', async () => {
    kubectlTransportMock.mockClear();
    const opts = base();
    opts.deps.resolvePromotedConfig = vi.fn(async () => {
      throw new Error('config bundle not found: ' + digest);
    });
    await expect(attachPromotedConfig(opts)).rejects.toThrow(digest);
    expect(kubectlTransportMock).not.toHaveBeenCalled();
  });
});
