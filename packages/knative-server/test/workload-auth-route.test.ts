import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyIdFor, makeSigner, publicKeyToBase64 } from '@sh/control-plane';

// The /workloads lifecycle under caller authentication (PR #350 review): every verb authenticates,
// a workload is owned by the subject that created it, and a run can only inherit the pool selector
// of a workload its own caller owns -- the selector /runs strips must not come back through here.

const { records, runLeaf, createWorkload, getWorkload, deleteWorkload } = vi.hoisted(() => ({
  records: new Map<string, string>(),
  runLeaf: vi.fn(),
  createWorkload: vi.fn(),
  getWorkload: vi.fn(),
  deleteWorkload: vi.fn(),
}));
vi.mock('@sh/work-queue', () => ({
  RedisWorkQueue: class {
    ensureGroup = async () => {};
    enqueue = async () => '1-0';
  },
}));
vi.mock('@sh/harness/leaf-result-store', async (orig) => {
  const actual = await orig<typeof import('@sh/harness/leaf-result-store')>();
  class FakeStore {
    async set(key: string, value: string) {
      records.set(key, value);
    }
    async get(key: string) {
      return records.get(key) ?? null;
    }
  }
  return { ...actual, RedisResultStore: FakeStore };
});
vi.mock('@sh/harness/run-leaf', () => ({
  runLeaf: (...args: any[]) => runLeaf(...args),
  validateItem: (item: any) => item,
  leafSessionId: (env: any) => env.sessionId,
}));
vi.mock('../src/context-service.js', () => ({
  contextServiceConfigured: () => true,
  createWorkload,
  getWorkload,
  deleteWorkload,
}));

import { startServer } from '../src/server.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
const tokenFor = (sub: string, sid = 'run/i') =>
  signer.mint({ sub, tenant: sub, roles: [], scope: ['turn:write'], sid, ttlSeconds: 300 });
const ALICE = tokenFor('github:alice');
const BOB = tokenFor('github:bob');

const record = {
  workloadId: 'demo-workload',
  status: 'ready',
  replicas: 2,
  readyReplicas: 2,
  sandboxSelector: 'context.rossoctl.io/pool=demo-workload',
  workspace: { size: '1Gi', accessMode: 'ReadWriteMany', storageClass: 'ibm-scale-csi' },
};

const KEYS = [
  'SH_REQUIRE_AUTH',
  'SH_SESSION_TOKEN_PUBLIC_KEYS',
  'SH_CONTROL_PLANE_URL',
  'SH_EXCHANGE_TOKEN',
];
const saved: Record<string, string | undefined> = {};
let server: ReturnType<typeof startServer>;
let base: string;
let cp: http.Server;

beforeEach(async () => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  cp = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        mode: 'direct',
        anthropicAuthToken: 'sk-caller', // notsecret
        anthropicBaseUrl: 'https://litellm.internal/v1',
      }),
    );
  });
  await new Promise<void>((r) => cp.listen(0, () => r()));
  process.env.SH_SESSION_TOKEN_PUBLIC_KEYS = `${keyIdFor(publicKey)}:${publicKeyToBase64(publicKey)}`;
  process.env.SH_CONTROL_PLANE_URL = `http://127.0.0.1:${(cp.address() as { port: number }).port}`;
  process.env.SH_EXCHANGE_TOKEN = 'shared-abc'; // notsecret
  records.clear();
  runLeaf.mockReset().mockResolvedValue({ status: 'responded', text: 'ok' });
  createWorkload.mockReset().mockResolvedValue(record);
  getWorkload.mockReset().mockResolvedValue(record);
  deleteWorkload.mockReset().mockResolvedValue(undefined);
  server = startServer(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => cp.close(() => r()));
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

const run = (token?: string) =>
  call('POST', '/runs', token, {
    workloadId: 'demo-workload',
    sessionId: 'run/i',
    kind: 'prompt',
    prompt: 'hi',
  });

describe('/workloads under SH_REQUIRE_AUTH=true', () => {
  beforeEach(() => {
    process.env.SH_REQUIRE_AUTH = 'true';
  });

  it('refuses every verb without a token, before Context Service is touched', async () => {
    expect((await call('POST', '/workloads', undefined, { name: 'demo-workload' })).status).toBe(
      401,
    );
    expect((await call('GET', '/workloads/demo-workload')).status).toBe(401);
    expect((await call('DELETE', '/workloads/demo-workload')).status).toBe(401);
    expect(createWorkload).not.toHaveBeenCalled();
    expect(getWorkload).not.toHaveBeenCalled();
    expect(deleteWorkload).not.toHaveBeenCalled();
  });

  it('refuses a present-but-bad token', async () => {
    const res = await call('POST', '/workloads', 'not-a-token', { name: 'demo-workload' });
    expect(res.json.error).toBe('token_invalid');
    expect(createWorkload).not.toHaveBeenCalled();
  });

  it('records the creating subject as the owner, and keeps it across a refresh', async () => {
    expect((await call('POST', '/workloads', ALICE, { name: 'demo-workload' })).json.owner).toBe(
      'github:alice',
    );
    const got = await call('GET', '/workloads/demo-workload', ALICE);
    expect(got).toMatchObject({ status: 200, json: { owner: 'github:alice' } });
    expect(JSON.parse(records.get('sh:workload:demo-workload')!).owner).toBe('github:alice');
  });

  it("hides another subject's workload from GET and DELETE", async () => {
    await call('POST', '/workloads', ALICE, { name: 'demo-workload' });
    expect(await call('GET', '/workloads/demo-workload', BOB)).toEqual({
      status: 404,
      json: { error: 'workload_not_found' },
    });
    expect((await call('DELETE', '/workloads/demo-workload', BOB)).status).toBe(404);
    expect(getWorkload).not.toHaveBeenCalled();
    expect(deleteWorkload).not.toHaveBeenCalled();
    expect((await call('DELETE', '/workloads/demo-workload', ALICE)).status).toBe(204);
  });

  it("refuses to re-create another subject's live workload", async () => {
    await call('POST', '/workloads', ALICE, { name: 'demo-workload' });
    createWorkload.mockClear();
    expect(await call('POST', '/workloads', BOB, { name: 'demo-workload' })).toEqual({
      status: 409,
      json: { error: 'workload_name_taken' },
    });
    expect(createWorkload).not.toHaveBeenCalled();
    expect(JSON.parse(records.get('sh:workload:demo-workload')!).owner).toBe('github:alice');
  });

  it("does not let a run inherit another subject's pool selector", async () => {
    await call('POST', '/workloads', ALICE, { name: 'demo-workload' });
    expect(await run(BOB)).toEqual({ status: 404, json: { error: 'workload_not_found' } });
    expect(runLeaf).not.toHaveBeenCalled();

    // The owner still gets the selector: the check narrows, it does not break the route.
    expect((await run(ALICE)).status).toBe(200);
    expect(runLeaf).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxPoolSelector: 'context.rossoctl.io/pool=demo-workload' }),
      expect.any(Object),
    );
  });
});

describe('/workloads with authentication optional', () => {
  it('keeps unauthenticated callers apart from owned workloads, in both directions', async () => {
    await call('POST', '/workloads', ALICE, { name: 'demo-workload' });
    // An owned workload is not reachable without its owner's token ...
    expect((await call('GET', '/workloads/demo-workload')).status).toBe(404);
    expect((await run()).status).toBe(404);
    expect(runLeaf).not.toHaveBeenCalled();

    // ... and an unowned one is not reachable WITH a token.
    records.clear();
    await call('POST', '/workloads', undefined, { name: 'demo-workload' });
    expect(JSON.parse(records.get('sh:workload:demo-workload')!).owner).toBeUndefined();
    expect((await call('GET', '/workloads/demo-workload', ALICE)).status).toBe(404);
    expect((await call('GET', '/workloads/demo-workload')).status).toBe(200);
  });
});
