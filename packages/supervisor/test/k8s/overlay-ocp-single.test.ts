import { describe, expect, it } from 'vitest';
import { NO_KUBECTL, container, envVar, find, podSpec, render } from './render.js';

// The single-namespace dev/test target (README §12). Every test renders the checked-in overlay,
// whose namespace is the moca-single placeholder; setup.sh's generated overlay layers the real
// SH_SINGLE_NAMESPACE on top as a namespace transformer, which changes only the names, not the
// structure asserted here.
describe.skipIf(NO_KUBECTL)('deploy/k8s overlays/ocp-single', () => {
  const objs = () => render('overlays/ocp-single');
  const NS = 'moca-single';

  it('puts every object in the one namespace, and creates no namespace or Route', () => {
    expect(objs().filter((o) => o.kind === 'Namespace')).toEqual([]);
    expect(objs().filter((o) => o.kind === 'Route')).toEqual([]);
    // base's three namespaces are gone, so every remaining object is namespaced, and all to one.
    const namespaces = new Set(
      objs().filter((o) => o.metadata.namespace).map((o) => o.metadata.namespace),
    );
    expect(namespaces).toEqual(new Set([NS]));
  });

  it('strips every explicit UID/GID/fsGroup, so restricted-v2 assigns them', () => {
    const workloads = [
      find(objs(), 'Deployment', 'moca-supervisor'),
      find(objs(), 'Deployment', 'sandbox-relay'),
      find(objs(), 'Deployment', 'moca-control-plane'),
      find(objs(), 'StatefulSet', 'redis'),
      find(objs(), 'StatefulSet', 'moca-sandbox'),
    ];
    for (const w of workloads) {
      const sc = podSpec(w).securityContext;
      expect(sc.runAsUser, `${w.metadata.name} runAsUser`).toBeUndefined();
      expect(sc.runAsGroup, `${w.metadata.name} runAsGroup`).toBeUndefined();
      expect(sc.fsGroup, `${w.metadata.name} fsGroup`).toBeUndefined();
      // What restricted-v2 still requires, kept.
      expect(sc.runAsNonRoot).toBe(true);
      expect(sc.seccompProfile).toEqual({ type: 'RuntimeDefault' });
    }
  });

  it('mounts emptyDirs over /workspace and /home/sandbox for the assigned fsGroup', () => {
    const ss = find(objs(), 'StatefulSet', 'moca-sandbox', NS);
    const sbx = container(ss, 'sandbox');
    const mounts = (sbx.volumeMounts ?? []).map((v: { mountPath: string }) => v.mountPath);
    expect(mounts).toEqual(expect.arrayContaining(['/workspace', '/home/sandbox']));
    const vols = podSpec(ss).volumes.filter((v: { emptyDir?: unknown }) => v.emptyDir !== undefined);
    expect(vols.map((v: { name: string }) => v.name)).toEqual(['workspace', 'home']);
  });

  it('rewrites the cross-namespace env strings to the one namespace', () => {
    const sup = container(find(objs(), 'Deployment', 'moca-supervisor', NS), 'supervisor');
    expect(envVar(sup, 'SH_RELAY_ADDR')?.value).toBe(`sandbox-relay-exec.${NS}.svc:9444`);
    expect(envVar(sup, 'SH_CONTROL_PLANE_URL')?.value).toBe(
      `http://moca-control-plane.${NS}.svc:8080`,
    );
    const cp = container(find(objs(), 'Deployment', 'moca-control-plane', NS), 'control-plane');
    expect(envVar(cp, 'SH_CREDENTIAL_NAMESPACE')?.value).toBe(NS);
    expect(envVar(cp, 'SH_SANDBOX_NAMESPACE')?.value).toBe(NS);
    const sbx = container(find(objs(), 'StatefulSet', 'moca-sandbox', NS), 'sandbox');
    expect(envVar(sbx, 'RELAY_ADDR')?.value).toBe(`sandbox-relay-attach.${NS}.svc:9443`);
  });

  it('carries no namespaceSelector between collapsed workloads, and keeps the isolation edges', () => {
    // The relay: attach from sandboxes, exec from the supervisor only, both by pod label now.
    const relay = find(objs(), 'NetworkPolicy', 'sandbox-relay', NS);
    const attach = relay.spec.ingress.find((r: { ports: { port: number }[] }) =>
      r.ports.some((p: { port: number }) => p.port === 9443),
    );
    expect(attach.from).toEqual([{ podSelector: { matchLabels: { app: 'moca-sandbox' } } }]);
    const exec = relay.spec.ingress.find((r: { ports: { port: number }[] }) =>
      r.ports.some((p: { port: number }) => p.port === 9444),
    );
    expect(exec.from).toEqual([{ podSelector: { matchLabels: { app: 'moca-supervisor' } } }]);
    // The sandbox's cluster egress: the relay's attach port, by pod label, never a namespace.
    const sbx = find(objs(), 'NetworkPolicy', 'moca-sandbox', NS);
    const relayEgress = sbx.spec.egress.find((r: { to: { podSelector?: unknown }[] }) =>
      r.to.some((t: { podSelector?: unknown }) => t.podSelector !== undefined),
    );
    expect(relayEgress.to).toEqual([{ podSelector: { matchLabels: { app: 'sandbox-relay' } } }]);
    expect(relayEgress.ports).toEqual([{ protocol: 'TCP', port: 9443 }]);
    // Default-deny both directions for every pod in the namespace.
    const deny = find(objs(), 'NetworkPolicy', 'default-deny', NS);
    expect(deny.spec.podSelector).toEqual({});
    expect(deny.spec.policyTypes).toEqual(['Ingress', 'Egress']);
    // DNS via openshift-dns on 5353, never kube-system/kube-dns.
    const dns = find(objs(), 'NetworkPolicy', 'allow-dns', NS);
    const rule = dns.spec.egress[0];
    expect(rule.to[0].namespaceSelector).toEqual({
      matchLabels: { 'kubernetes.io/metadata.name': 'openshift-dns' },
    });
    expect(rule.ports).toEqual([
      { protocol: 'UDP', port: 5353 },
      { protocol: 'TCP', port: 5353 },
    ]);
  });

  it('keeps the sandbox pool: the StatefulSet with its governing Service and SANDBOX_ID', () => {
    const ss = find(objs(), 'StatefulSet', 'moca-sandbox', NS);
    expect(ss.spec.replicas).toBe(2);
    expect(ss.spec.serviceName).toBe('moca-sandbox');
    // SANDBOX_ID from the pod name, so the pool IDs stay unique and stable.
    expect(envVar(container(ss, 'sandbox'), 'SANDBOX_ID')?.valueFrom.fieldRef.fieldPath).toBe(
      'metadata.name',
    );
    // The attach token still comes from the Secret, now same-namespace.
    expect(envVar(container(ss, 'sandbox'), 'SANDBOX_TOKEN')?.valueFrom.secretKeyRef).toEqual({
      name: 'moca-relay-attach',
      key: 'SH_RELAY_TOKEN',
    });
    // The Role and RoleBinding collapse into the namespace and still bind.
    find(objs(), 'Role', 'moca-control-plane-credentials', NS);
    const rb = find(objs(), 'RoleBinding', 'moca-control-plane-credentials', NS);
    expect(rb.subjects).toEqual([
      { kind: 'ServiceAccount', name: 'moca-control-plane', namespace: NS },
    ]);
  });
});
