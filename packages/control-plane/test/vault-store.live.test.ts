import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { VaultCredentialStore } from '../src/vault-store.js';
import { cred, newKek } from './helpers/store-contract.js';

/**
 * The Vault store against a REAL Vault, because the fake in vault-store.test.ts encodes this file's
 * own reading of KV v2 (404 shapes, cas semantics, the version numbering). Gated like the other live
 * suites; a dev server is enough:
 *
 *   docker run -d --rm -p 18200:8200 -e VAULT_DEV_ROOT_TOKEN_ID=dev-root hashicorp/vault:1.18
 *   SH_VAULT_LIVE_ADDR=http://127.0.0.1:18200 SH_VAULT_LIVE_TOKEN=dev-root \
 *     ./node_modules/.bin/vitest run test/vault-store.live.test.ts
 *
 * The dev server mounts KV v2 at `secret/`. Each run writes under a fresh prefix, so reruns against
 * one server never see each other's rows.
 */
const addr = process.env.SH_VAULT_LIVE_ADDR;
const token = process.env.SH_VAULT_LIVE_TOKEN;

describe.skipIf(!addr || !token)('VaultCredentialStore against a real Vault', () => {
  const make = (keks: Buffer[], prefix: string) =>
    new VaultCredentialStore({
      addr: addr!,
      token: () => token!,
      mount: 'secret',
      prefix,
      keks,
    });

  it('round-trips, lists, overwrites and deletes through real KV v2 check-and-set', async () => {
    const prefix = `moca-live/${randomUUID()}`;
    const store = make([newKek()], prefix);
    expect(await store.list('github:1')).toEqual([]);
    await store.put('github:1', cred('one'));
    await store.put('github:1', cred('two'));
    await store.put('github:1', cred('one', { secret: { token: 'rotated' } })); // notsecret
    expect((await store.get('github:1', 'one'))?.secret).toEqual({ token: 'rotated' }); // notsecret
    expect((await store.list('github:1')).map((d) => d.name)).toEqual(['one', 'two']);
    await store.delete('github:1', 'one');
    expect((await store.list('github:1')).map((d) => d.name)).toEqual(['two']);
  });

  it('two stores (two replicas) writing one subject concurrently lose nothing', async () => {
    const prefix = `moca-live/${randomUUID()}`;
    const kek = newKek();
    const a = make([kek], prefix);
    const b = make([kek], prefix);
    await Promise.all([
      a.put('github:2', cred('from-a-1')),
      b.put('github:2', cred('from-b-1')),
      a.put('github:2', cred('from-a-2')),
      b.put('github:2', cred('from-b-2')),
    ]);
    expect((await a.list('github:2')).map((d) => d.name)).toEqual([
      'from-a-1',
      'from-a-2',
      'from-b-1',
      'from-b-2',
    ]);
  });

  it('a wrong token is credential_unavailable', async () => {
    const store = new VaultCredentialStore({
      addr: addr!,
      token: () => 'hvs.wrong', // notsecret
      mount: 'secret',
      prefix: 'moca-live/denied',
      keks: [newKek()],
    });
    await expect(store.list('github:3')).rejects.toMatchObject({ code: 'credential_unavailable' });
  });
});
