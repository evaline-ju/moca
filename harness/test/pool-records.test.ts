import { createClient } from 'redis';
import { afterEach, describe, expect, it } from 'vitest';
import { detachedKey } from '../src/sandbox-affinity.js';
import { RedisRecordStore, type SandboxRecord } from '../src/pool-records.js';

const rec: SandboxRecord = {
  sandboxId: 'sbx-remote-1',
  labels: { team: 't1' },
  capabilities: ['python3'],
  capacityMax: 4,
  transport: 'grpc',
};

describe('RedisRecordStore', () => {
  const store = new RedisRecordStore();
  afterEach(async () => {
    await store.remove(rec.sandboxId);
  });

  it('put then list returns the record', async () => {
    await store.put(rec);
    const all = await store.list();
    expect(all.find((r) => r.sandboxId === rec.sandboxId)).toEqual(rec);
  });

  it('remove drops it from list', async () => {
    await store.put(rec);
    await store.remove(rec.sandboxId);
    const all = await store.list();
    expect(all.find((r) => r.sandboxId === rec.sandboxId)).toBeUndefined();
  });

  it('markDetached overwrites (the relay knows the true time); clearDetached deletes', async () => {
    const raw = createClient({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' });
    await raw.connect();
    try {
      await store.markDetached(rec.sandboxId, 1_000, 60_000);
      await store.markDetached(rec.sandboxId, 2_000, 60_000);
      expect(await raw.get(detachedKey(rec.sandboxId))).toBe('2000');
      expect(await raw.pTTL(detachedKey(rec.sandboxId))).toBeGreaterThan(0);
      await store.clearDetached(rec.sandboxId);
      expect(await raw.get(detachedKey(rec.sandboxId))).toBeNull();
    } finally {
      await raw.close();
    }
  });
});
