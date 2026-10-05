import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createRelay, type DetachMarks } from '../src/relay.js';
import type { RecordStore, SandboxRecord } from '@moca/harness';

function fakeAttach(token?: string) {
  const s = new EventEmitter() as EventEmitter & {
    metadata: { get: (k: string) => string[] };
    write: (f: unknown) => void;
    end: () => void;
    emitData: (f: unknown) => void;
  };
  s.metadata = { get: (k) => (k === 'authorization' && token ? [`Bearer ${token}`] : []) };
  s.write = () => {};
  s.end = () => s.emit('end');
  s.emitData = (f) => s.emit('data', f);
  return s;
}
const hello = (sandboxId: string) => ({
  hello: { sandboxId, labels: { 'moca.dev/tier': 'microvm' }, capabilities: [], image: '', arch: 'amd64', capacityMax: 4, trust: 'untrusted' },
});

/** One ordered log of every Redis-facing call, so ordering across records and marks is assertable. */
function harness() {
  const calls: string[] = [];
  const records: RecordStore = {
    put: vi.fn(async (r: SandboxRecord) => void calls.push(`put:${r.sandboxId}`)),
    remove: vi.fn(async (id: string) => void calls.push(`remove:${id}`)),
    list: async () => [],
  };
  const detach: DetachMarks = {
    mark: vi.fn(async (id: string) => void calls.push(`mark:${id}`)),
    clear: vi.fn(async (id: string) => void calls.push(`clear:${id}`)),
  };
  return { calls, records, detach };
}

describe('relay detach marks (P6.3 spec §3.2)', () => {
  it('clears the mark BEFORE the presence put on Hello, and marks AFTER the remove on teardown', async () => {
    const { calls, records, detach } = harness();
    const relay = createRelay({ records, detach, validateToken: () => true });
    const s = fakeAttach('t');
    relay.onAttach(s as never);
    s.emitData(hello('sbx-1'));
    await vi.waitFor(() => expect(calls).toContain('put:sbx-1'));
    expect(calls.indexOf('clear:sbx-1')).toBeLessThan(calls.indexOf('put:sbx-1'));
    s.emit('end');
    await vi.waitFor(() => expect(calls).toContain('mark:sbx-1'));
    expect(calls.indexOf('remove:sbx-1')).toBeLessThan(calls.indexOf('mark:sbx-1'));
  });

  it('marks once even when both end and error fire', async () => {
    const { records, detach } = harness();
    const relay = createRelay({ records, detach, validateToken: () => true });
    const s = fakeAttach('t');
    relay.onAttach(s as never);
    s.emitData(hello('sbx-2'));
    s.emit('end');
    s.emit('error', new Error('late'));
    await vi.waitFor(() => expect(detach.mark).toHaveBeenCalledTimes(1));
  });

  it('a rejected Hello (bad token) neither clears nor marks', async () => {
    const { records, detach } = harness();
    const relay = createRelay({ records, detach, validateToken: () => false });
    const s = fakeAttach('bad');
    relay.onAttach(s as never);
    s.emitData(hello('sbx-3'));
    await new Promise((r) => setTimeout(r, 10));
    expect(detach.clear).not.toHaveBeenCalled();
    expect(detach.mark).not.toHaveBeenCalled();
  });

  it('a failing mark or clear is logged and changes nothing else', async () => {
    const { records } = harness();
    const detach: DetachMarks = {
      mark: vi.fn(async () => {
        throw new Error('redis down');
      }),
      clear: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const relay = createRelay({ records, detach, validateToken: () => true });
    const s = fakeAttach('t');
    relay.onAttach(s as never);
    s.emitData(hello('sbx-4'));
    await vi.waitFor(() => expect(records.put).toHaveBeenCalled());
    expect(relay.parked()).toContain('sbx-4');
    s.emit('end');
    await vi.waitFor(() => expect(err).toHaveBeenCalledWith(expect.stringContaining('detach mark'), expect.anything()));
    expect(relay.parked()).not.toContain('sbx-4');
    err.mockRestore();
  });

  it('works with no detach dep at all (every existing caller)', async () => {
    const { records } = harness();
    const relay = createRelay({ records, validateToken: () => true });
    const s = fakeAttach('t');
    relay.onAttach(s as never);
    s.emitData(hello('sbx-5'));
    await vi.waitFor(() => expect(records.put).toHaveBeenCalled());
    s.emit('end');
    await vi.waitFor(() => expect(records.remove).toHaveBeenCalled());
  });
});
