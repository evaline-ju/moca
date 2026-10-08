import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createRelay, type DetachMarks } from '../src/relay.js';
import type { RecordStore, SandboxRecord } from '@moca/harness';

// #453: a graceful relay stop must run every parked session's teardown -- remove its presence
// record and write its detach mark, both awaited -- so turns in the restart gap see an absent affine
// sandbox (503, pending) instead of leasing a stale record and failing inside the turn.

function fakeAttach() {
  const s = new EventEmitter() as EventEmitter & {
    metadata: { get: (k: string) => string[] };
    write: (f: unknown) => void;
    end: ReturnType<typeof vi.fn>;
    emitData: (f: unknown) => void;
  };
  s.metadata = { get: (k) => (k === 'authorization' ? ['Bearer t'] : []) };
  s.write = () => {};
  s.end = vi.fn(() => s.emit('end'));
  s.emitData = (f) => s.emit('data', f);
  return s;
}

const hello = (sandboxId: string) => ({
  hello: {
    sandboxId,
    labels: {},
    capabilities: [],
    image: '',
    arch: 'amd64',
    capacityMax: 1,
    trust: 'trusted',
  },
});

function harness(delayMs = 0) {
  const calls: string[] = [];
  const later = (s: string) =>
    new Promise<void>((r) =>
      setTimeout(() => {
        calls.push(s);
        r();
      }, delayMs),
    );
  const records: RecordStore = {
    put: vi.fn(async (r: SandboxRecord) => void calls.push(`put:${r.sandboxId}`)),
    remove: vi.fn((id: string) => later(`remove:${id}`)),
    list: async () => [],
  };
  const detach: DetachMarks = {
    mark: vi.fn((id: string) => later(`mark:${id}`)),
    clear: vi.fn(async (id: string) => void calls.push(`clear:${id}`)),
  };
  return { calls, records, detach };
}

describe('relay drain (#453)', () => {
  it('removes every record and writes every mark BEFORE it resolves, then ends the streams', async () => {
    const { calls, records, detach } = harness(20);
    const relay = createRelay({ records, detach, validateToken: () => true });
    const a = fakeAttach();
    const b = fakeAttach();
    relay.onAttach(a as never);
    relay.onAttach(b as never);
    a.emitData(hello('sbx-a'));
    b.emitData(hello('sbx-b'));
    await vi.waitFor(() => expect(records.put).toHaveBeenCalledTimes(2));

    await relay.drain();

    expect(calls).toEqual(
      expect.arrayContaining(['remove:sbx-a', 'mark:sbx-a', 'remove:sbx-b', 'mark:sbx-b']),
    );
    expect(calls.indexOf('remove:sbx-a')).toBeLessThan(calls.indexOf('mark:sbx-a'));
    expect(calls.indexOf('remove:sbx-b')).toBeLessThan(calls.indexOf('mark:sbx-b'));
    expect(a.end).toHaveBeenCalled();
    expect(b.end).toHaveBeenCalled();
    expect(relay.parked()).toEqual([]);
    // The 'end' each stream emits re-enters teardown; the identity guard keeps it to one remove.
    expect(records.remove).toHaveBeenCalledTimes(2);
    expect(detach.mark).toHaveBeenCalledTimes(2);
  });

  it('fails in-flight execs instead of leaving them parked', async () => {
    const { records } = harness();
    const relay = createRelay({ records, validateToken: () => true });
    const a = fakeAttach();
    relay.onAttach(a as never);
    a.emitData(hello('sbx-x'));
    const it = relay.routeExec('sbx-x', { reqId: 7 } as never)[Symbol.asyncIterator]();
    const first = it.next();
    await relay.drain();
    const ev = await first;
    expect(ev.value?.error?.message).toBe('worker disconnected');
  });

  it('refuses a Hello once draining, so no record is written after the drain removed them', async () => {
    const { records } = harness();
    const relay = createRelay({ records, validateToken: () => true });
    await relay.drain();
    const late = fakeAttach();
    relay.onAttach(late as never);
    late.emitData(hello('sbx-late'));
    await new Promise((r) => setTimeout(r, 10));
    expect(late.end).toHaveBeenCalled();
    expect(records.put).not.toHaveBeenCalled();
    expect(relay.parked()).toEqual([]);
  });

  it('a failing remove is logged and the drain still resolves', async () => {
    const records: RecordStore = {
      put: async () => {},
      remove: async () => {
        throw new Error('redis down');
      },
      list: async () => [],
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const relay = createRelay({ records, validateToken: () => true });
    const a = fakeAttach();
    relay.onAttach(a as never);
    a.emitData(hello('sbx-f'));
    await relay.drain();
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('presence remove failed'),
      expect.anything(),
    );
    err.mockRestore();
  });
});
