import { describe, expect, it } from 'vitest';
import { NO_KUBECTL, container, envVar, find, podSpec, render } from './render.js';

describe.skipIf(NO_KUBECTL)('deploy/k8s base: relay', () => {
  const dep = () => find(render('base'), 'Deployment', 'sandbox-relay', 'moca');

  it('is one replica, recreated rather than rolled: a second relay would split the attached sandboxes', () => {
    expect(dep().spec.replicas).toBe(1);
    expect(dep().spec.strategy).toEqual({ type: 'Recreate' });
    expect(podSpec(dep()).terminationGracePeriodSeconds).toBeGreaterThanOrEqual(120);
  });

  it('runs the relay entrypoint from its package dir', () => {
    const c = container(dep(), 'sandbox-relay');
    expect(c.image).toMatch(/moca/);
    expect(c.workingDir).toBe('/app/packages/sandbox-relay');
    expect(c.command).toEqual(['node', '--import', 'tsx', 'src/main.ts']);
  });

  it('splits attach and exec onto two listeners, with both tokens from the Secret', () => {
    const c = container(dep(), 'sandbox-relay');
    expect(envVar(c, 'SH_RELAY_PORT')?.value).toBe('9443');
    expect(envVar(c, 'MOCA_RELAY_EXEC_ADDR')?.value).toBe('0.0.0.0:9444');
    for (const k of ['SH_RELAY_TOKEN', 'MOCA_RELAY_EXEC_TOKEN']) {
      expect(envVar(c, k)).toEqual({
        name: k,
        valueFrom: { secretKeyRef: { name: 'moca-relay', key: k } },
      });
    }
    expect(envVar(c, 'REDIS_URL')).toEqual({
      name: 'REDIS_URL',
      valueFrom: { secretKeyRef: { name: 'moca-redis', key: 'REDIS_URL' } },
    });
  });

  it('has two Services, so the address a sandbox dials has no route to the exec port', () => {
    const attach = find(render('base'), 'Service', 'sandbox-relay-attach', 'moca');
    const exec = find(render('base'), 'Service', 'sandbox-relay-exec', 'moca');
    expect(attach.spec.ports.map((p: { port: number }) => p.port)).toEqual([9443]);
    expect(exec.spec.ports.map((p: { port: number }) => p.port)).toEqual([9444]);
  });

  it('admits 9443 from sandbox pods and 9444 from supervisor pods only', () => {
    const p = find(render('base'), 'NetworkPolicy', 'sandbox-relay', 'moca');
    const byPort = (port: number) =>
      p.spec.ingress.find((r: { ports: { port: number }[] }) =>
        r.ports.some((x) => x.port === port),
      );
    expect(byPort(9443).from).toEqual([
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'moca-sandbox' } },
        podSelector: { matchLabels: { app: 'moca-sandbox' } },
      },
    ]);
    expect(byPort(9444).from).toEqual([
      { podSelector: { matchLabels: { app: 'moca-supervisor' } } },
    ]);
    expect(byPort(9443).ports).toEqual([{ protocol: 'TCP', port: 9443 }]);
    expect(byPort(9444).ports).toEqual([{ protocol: 'TCP', port: 9444 }]);
    expect(p.spec.egress).toEqual([
      {
        to: [{ podSelector: { matchLabels: { app: 'redis' } } }],
        ports: [{ protocol: 'TCP', port: 6379 }],
      },
    ]);
  });

  it('carries the P6.3 detach-mark TTL setting', () => {
    const c = container(dep(), 'sandbox-relay');
    expect(envVar(c, 'SH_SANDBOX_AFFINITY_TTL_SECONDS')?.value).toBe('86400');
  });

  it('reads per-sandbox tokens from an OPTIONAL mounted Secret (P6.2 §2.5)', () => {
    const c = container(dep(), 'sandbox-relay');
    expect(envVar(c, 'SH_RELAY_TOKEN_DIR')?.value).toBe('/run/relay-tokens');
    expect(c.volumeMounts).toContainEqual({
      name: 'relay-tokens',
      mountPath: '/run/relay-tokens',
      readOnly: true,
    });
    const vol = podSpec(dep()).volumes.find((v: { name: string }) => v.name === 'relay-tokens');
    // optional: a stack with no P4 host has no such Secret, and must run exactly as in slice 1.
    expect(vol.secret).toEqual({
      secretName: 'moca-relay-sandbox-tokens',
      optional: true,
      defaultMode: 256,
    });
    // The container tier's global token is untouched.
    expect(envVar(c, 'SH_RELAY_TOKEN')?.valueFrom).toEqual({
      secretKeyRef: { name: 'moca-relay', key: 'SH_RELAY_TOKEN' },
    });
  });
});
