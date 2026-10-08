import { EventEmitter } from 'node:events';
import {
  credentials,
  makeGenericClientConstructor,
  type Client,
  type ClientDuplexStream,
} from '@grpc/grpc-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxWorkerService, type ServerFrame, type WorkerFrame } from '@moca/k8s-sandbox';
import type { RecordStore, SandboxRecord } from '@moca/harness';
import { installShutdownSignals, startRelay } from '../src/main.js';
import type { DetachMarks } from '../src/relay.js';

// #453 acceptance: a graceful stop with two attached workers removes both presence records and writes
// both detach marks BEFORE the relay is down. Real grpc-js transport, so tryShutdown's wait on the
// long-lived Attach streams is exercised too: without the drain ending them, shutdown never returns.

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const WorkerClient = makeGenericClientConstructor(SandboxWorkerService, 'SandboxWorker');

function attach(addr: string, sandboxId: string): Promise<{ ended: Promise<void> }> {
  const client = new WorkerClient(addr, credentials.createInsecure()) as unknown as Client & {
    attach: () => ClientDuplexStream<WorkerFrame, ServerFrame>;
  };
  const stream = client.attach();
  const ended = new Promise<void>((r) => {
    stream.on('end', () => r());
    stream.on('error', () => r());
  });
  stream.on('data', () => {});
  stream.write({
    hello: {
      sandboxId,
      labels: {},
      capabilities: [],
      image: '',
      arch: 'amd64',
      capacityMax: 1,
      trust: 'trusted',
    },
  } as WorkerFrame);
  closers.push(() => {
    stream.cancel();
    client.close();
  });
  return Promise.resolve({ ended });
}

function store() {
  const live = new Set<string>();
  const marked = new Set<string>();
  const slow = <T>(fn: () => T) => new Promise<T>((r) => setTimeout(() => r(fn()), 30));
  const records: RecordStore = {
    put: async (r: SandboxRecord) => void live.add(r.sandboxId),
    remove: (id: string) => slow(() => void live.delete(id)),
    list: async () => [],
  };
  const detach: DetachMarks = {
    mark: (id: string) => slow(() => void marked.add(id)),
    clear: async () => {},
  };
  return { live, marked, records, detach };
}

describe('relay graceful shutdown (#453)', () => {
  for (const split of [false, true]) {
    it(`removes both records and writes both marks before shutdown resolves (${split ? 'split' : 'one'} listener)`, async () => {
      const { live, marked, records, detach } = store();
      const relay = await startRelay({
        port: 0,
        execAddr: split ? '127.0.0.1:0' : undefined,
        env: {},
        deps: { records, detach, validateToken: () => true, validateExecToken: () => true },
      });
      const addr = `127.0.0.1:${relay.port}`;
      const w1 = await attach(addr, 'sbx-1');
      const w2 = await attach(addr, 'sbx-2');
      await vi.waitFor(() => expect([...live].sort()).toEqual(['sbx-1', 'sbx-2']));

      await relay.shutdown();

      expect(live.size).toBe(0);
      expect([...marked].sort()).toEqual(['sbx-1', 'sbx-2']);
      // The workers see their streams end, which is what sends them off to re-Hello.
      await w1.ended;
      await w2.ended;
    });
  }
});

describe('relay graceful shutdown with an attach stream that never sent a Hello (#462 review)', () => {
  it('still resolves promptly instead of waiting on the open stream', async () => {
    const { records, detach } = store();
    const relay = await startRelay({
      port: 0,
      env: {},
      deps: { records, detach, validateToken: () => true, validateExecToken: () => true },
    });
    const addr = `127.0.0.1:${relay.port}`;
    const client = new WorkerClient(addr, credentials.createInsecure()) as unknown as Client & {
      attach: () => ClientDuplexStream<WorkerFrame, ServerFrame>;
    };
    const silent = client.attach();
    silent.on('error', () => {});
    silent.on('data', () => {});
    closers.push(() => {
      silent.cancel();
      client.close();
    });
    // Let the call reach the server; a stream that has not arrived yet cannot hold the stop open.
    await new Promise((r) => setTimeout(r, 150));

    const t0 = Date.now();
    await relay.shutdown();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('installShutdownSignals', () => {
  function proc() {
    return new EventEmitter() as EventEmitter & NodeJS.Process;
  }

  it('on SIGTERM runs shutdown once and exits 0 after it settles', async () => {
    const p = proc();
    let finish!: () => void;
    const shutdown = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const exit = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    installShutdownSignals(shutdown, { proc: p, exit, deadlineMs: 1000 });
    p.emit('SIGTERM');
    p.emit('SIGTERM');
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    log.mockRestore();
  });

  it('SIGINT works the same way', async () => {
    const p = proc();
    const exit = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    installShutdownSignals(async () => {}, { proc: p, exit, deadlineMs: 1000 });
    p.emit('SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    log.mockRestore();
  });

  it('exits 1 at the deadline when shutdown hangs', async () => {
    const p = proc();
    const exit = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    installShutdownSignals(() => new Promise(() => {}), { proc: p, exit, deadlineMs: 20 });
    p.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('deadline'));
    log.mockRestore();
    err.mockRestore();
  });
});
