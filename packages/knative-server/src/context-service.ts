export interface WorkloadRequest {
  name?: string;
  sandboxes?: number;
  workspace?: {
    shared?: boolean;
    size?: string;
    storageClass?: string;
    claimName?: string;
    readOnly?: boolean;
  };
}

export interface WorkloadRecord {
  workloadId: string;
  status: string;
  replicas: number;
  readyReplicas: number;
  sandboxSelector: string;
  workspace: {
    size?: string;
    accessMode?: string;
    storageClass?: string;
    claimName?: string;
    readOnly?: boolean;
  };
  /**
   * The authenticated subject that created it, or absent for an unauthenticated create. Set by the
   * server, never by Context Service: only a caller with the same subject (or, for an unowned
   * workload, an unauthenticated caller) may read, delete or run on it.
   */
  owner?: string;
}

interface ContextPool {
  name: string;
  status: string;
  replicas: number;
  readyReplicas: number;
  sandboxSelector: string;
  workspace: WorkloadRecord['workspace'];
}

export function contextServiceConfigured(): boolean {
  return (process.env.CONTEXT_SERVICE_URL?.trim().length ?? 0) > 0;
}

function baseUrl(): string {
  const configured = process.env.CONTEXT_SERVICE_URL?.trim();
  if (!configured) throw new Error('Context Service is not configured');
  return configured.replace(/\/$/, '');
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const configuredTimeout = Number.parseInt(process.env.CONTEXT_SERVICE_TIMEOUT_MS ?? '5000', 10);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 5000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl()}${path}`, { ...init, signal: controller.signal });
    if (response.ok) return response;
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Context Service returned ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

function workload(pool: ContextPool): WorkloadRecord {
  return {
    workloadId: pool.name,
    status: pool.status,
    replicas: pool.replicas,
    readyReplicas: pool.readyReplicas,
    sandboxSelector: pool.sandboxSelector,
    workspace: pool.workspace,
  };
}

export async function createWorkload(
  workloadId: string,
  spec: WorkloadRequest,
): Promise<WorkloadRecord> {
  const shared = spec.workspace?.shared === true;
  const claimName = spec.workspace?.claimName;
  const workspace = claimName
    ? { claimName, readOnly: spec.workspace?.readOnly }
    : {
        size: spec.workspace?.size ?? '1Gi',
        accessMode: shared ? 'ReadWriteMany' : 'ReadWriteOnce',
        ...(spec.workspace?.storageClass ? { storageClass: spec.workspace.storageClass } : {}),
      };
  const response = await request('/v1/sandbox-pools', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: workloadId,
      replicas: spec.sandboxes ?? (shared ? 2 : 1),
      workspace,
    }),
  });
  return workload((await response.json()) as ContextPool);
}

export async function getWorkload(workloadId: string): Promise<WorkloadRecord> {
  const response = await request(`/v1/sandbox-pools/${encodeURIComponent(workloadId)}`);
  return workload((await response.json()) as ContextPool);
}

export async function deleteWorkload(workloadId: string): Promise<void> {
  await request(`/v1/sandbox-pools/${encodeURIComponent(workloadId)}`, { method: 'DELETE' });
}
