import {
  Metadata,
  ServerCredentials,
  credentials,
  makeGenericClientConstructor,
  status,
  type Client,
  type ClientDuplexStream,
} from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SandboxExecClient,
  SandboxWorkerService,
  type ServerFrame,
  type WorkerFrame,
} from '@sh/k8s-sandbox';
import type { RecordStore } from '@sh/harness';
import { buildServer, makeExecTokenValidator, startRelay } from '../src/main.js';

const records: RecordStore = { put: async () => {}, remove: async () => {}, list: async () => [] };
const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

const deps = {
  records,
  validateToken: () => true,
  validateExecToken: (p: string | undefined) => p === 'right-token', // notsecret
};

async function bindOne(): Promise<string> {
  const { server } = buildServer(deps);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(p),
    ),
  );
  closers.push(() => server.forceShutdown());
  return `127.0.0.1:${port}`;
}

function execCode(addr: string, token?: string): Promise<number> {
  const client = new SandboxExecClient(addr, credentials.createInsecure());
  const md = new Metadata();
  if (token) md.set('authorization', `Bearer ${token}`);
  const call = client.exec(
    {
      sandboxId: 'sbx-x',
      exec: {
        reqId: 1,
        command: 'true',
        stdin: new Uint8Array(),
        timeoutS: 5,
        streaming: true,
        workspaceKey: 'k',
      },
    },
    md,
  );
  return new Promise((resolve) => {
    call.on('data', () => {});
    call.on('error', (err: { code: number }) => resolve(err.code));
    call.on('end', () => resolve(status.OK));
  }).finally(() => client.close()) as Promise<number>;
}

function abortCode(addr: string, token?: string): Promise<number> {
  const client = new SandboxExecClient(addr, credentials.createInsecure());
  const md = new Metadata();
  if (token) md.set('authorization', `Bearer ${token}`);
  return new Promise<number>((resolve) =>
    client.abort({ sandboxId: 'sbx-x', reqId: 1 }, md, (err: { code: number } | null) =>
      resolve(err ? err.code : status.OK),
    ),
  ).finally(() => client.close());
}

const WorkerClient = makeGenericClientConstructor(SandboxWorkerService, 'SandboxWorker');

/**
 * Terminal code of an Attach stream opened against `addr` (a Hello is sent, then we wait). A stream
 * still open after 3s -- the listener serves Attach and parked the session -- resolves to -1.
 */
function attachCode(addr: string): Promise<number> {
  const client = new WorkerClient(addr, credentials.createInsecure()) as unknown as Client & {
    attach: () => ClientDuplexStream<WorkerFrame, ServerFrame>;
  };
  const stream = client.attach();
  stream.write({
    hello: {
      sandboxId: 'sbx-x',
      labels: {},
      capabilities: [],
      image: '',
      arch: 'amd64',
      capacityMax: 1,
      trust: 'trusted',
    },
  } as WorkerFrame);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<number>((resolve) => {
    timer = setTimeout(() => resolve(-1), 3000);
    stream.on('data', () => {});
    stream.on('error', (err: { code: number }) => resolve(err.code));
    stream.on('status', (s: { code: number }) => resolve(s.code));
  }).finally(() => {
    clearTimeout(timer);
    stream.cancel();
    client.close();
  });
}

describe('SandboxExec requires the worker credential (MI1 R5)', () => {
  it('refuses an Exec with no token', async () => {
    expect(await execCode(await bindOne())).toBe(status.UNAUTHENTICATED);
  });

  it('refuses an Exec with the wrong token', async () => {
    expect(await execCode(await bindOne(), 'wrong-token')).toBe(status.UNAUTHENTICATED);
  });

  it('admits the right token (then fails for the ordinary reason: no worker attached)', async () => {
    const code = await execCode(await bindOne(), 'right-token');
    expect(code).not.toBe(status.UNAUTHENTICATED);
    expect(code).not.toBe(status.OK);
  });

  it('refuses an Abort with no token', async () => {
    expect(await abortCode(await bindOne())).toBe(status.UNAUTHENTICATED);
  });
});

describe('makeExecTokenValidator', () => {
  it('refuses to build without MOCA_RELAY_EXEC_TOKEN', () => {
    expect(() => makeExecTokenValidator({})).toThrow(/MOCA_RELAY_EXEC_TOKEN/);
    expect(() => makeExecTokenValidator({ MOCA_RELAY_EXEC_TOKEN: '' })).toThrow(
      /MOCA_RELAY_EXEC_TOKEN/,
    );
  });

  it('accepts exactly the configured token', () => {
    const v = makeExecTokenValidator({ MOCA_RELAY_EXEC_TOKEN: 'abc123' }); // notsecret
    expect(v('abc123')).toBe(true);
    expect(v('abc124')).toBe(false);
    expect(v('abc1234')).toBe(false);
    expect(v(undefined)).toBe(false);
  });
});

describe('startRelay with MOCA_RELAY_EXEC_ADDR serves the two services apart', () => {
  it('the attach listener does not serve Exec, and the exec listener does not serve Attach', async () => {
    const relay = await startRelay({ port: 0, execAddr: '127.0.0.1:0', deps });
    closers.push(relay.shutdown);
    expect(relay.execPort).toBeGreaterThan(0);
    expect(await execCode(`127.0.0.1:${relay.port}`, 'right-token')).toBe(status.UNIMPLEMENTED);
    const execOnExecPort = await execCode(`127.0.0.1:${relay.execPort}`, 'right-token');
    expect(execOnExecPort).not.toBe(status.UNIMPLEMENTED);
    expect(execOnExecPort).not.toBe(status.UNAUTHENTICATED);
    expect(await attachCode(`127.0.0.1:${relay.execPort}`)).toBe(status.UNIMPLEMENTED);
  });

  it('without an exec address, one listener serves both (the Kubernetes shape)', async () => {
    const relay = await startRelay({ port: 0, deps });
    closers.push(relay.shutdown);
    expect(relay.execPort).toBeUndefined();
    expect(await execCode(`127.0.0.1:${relay.port}`)).toBe(status.UNAUTHENTICATED);
  });

  it('refuses to start when no deps are injected and MOCA_RELAY_EXEC_TOKEN is unset', async () => {
    await expect(startRelay({ port: 0, env: { SH_RELAY_TOKEN: 't' } })).rejects.toThrow(
      /MOCA_RELAY_EXEC_TOKEN/,
    );
  });
});
