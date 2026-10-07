import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  buildBundle,
  bundleKey,
  DEFAULT_BUNDLE_TTL_SECONDS,
  MAX_BUNDLE_BYTES,
} from '@moca/config-bundle';
import {
  BUNDLES_ALL_KEY,
  BUNDLES_META_KEY,
  bundleOwnerKey,
  MIN_BUNDLE_CHARGE_BYTES,
} from '../src/bundle-budget.js';
import { statusFor } from '../src/errors.js';
import { HANDLERS } from '../src/handlers.js';
import { buildHandler } from '../src/server.js';
import type { fakeBundleRedis } from './helpers/fake-redis.js';
import { alice, bob, codeOf, ctx, makeDeps, NOW_MS } from './helpers/deps.js';

function bundle(text = 'hi') {
  const root = mkdtempSync(join(tmpdir(), 'cp-bundle-'));
  mkdirSync(join(root, 'skills/hello'), { recursive: true });
  writeFileSync(
    join(root, 'skills/hello/SKILL.md'),
    `---\nname: hello\ndescription: d\n---\n${text}\n`,
  );
  const r = buildBundle({
    roots: { userDir: root },
    mode: 'unattended',
    sandboxImage: 'img',
    versions: { pi: '0', harness: '0' },
  });
  return { digest: r.digest, tar: r.tar.toString('base64') };
}

describe('POST /v1/config-bundles', () => {
  it('stores a bundle and reports it uploaded, then unchanged', async () => {
    const d = makeDeps();
    const body = bundle();
    const first = await HANDLERS.putConfigBundle!(ctx({ principal: alice, body }), d);
    expect(first).toEqual({ status: 201, body: { digest: body.digest, uploaded: true } });
    const again = await HANDLERS.putConfigBundle!(ctx({ principal: alice, body }), d);
    expect(again.body).toEqual({ digest: body.digest, uploaded: false });
  });

  it('audits each upload with the subject, digest, byte count and outcome', async () => {
    const d = makeDeps({ withStreams: true });
    const body = bundle();
    await HANDLERS.putConfigBundle!(ctx({ principal: alice, body }), d);
    const rows = d.streams.get('sh:cp:audit') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject: alice.sub,
      decision: 'config_bundle_uploaded',
      configRef: body.digest,
      bytes: String(Buffer.from(body.tar, 'base64').length),
    });
    await HANDLERS.putConfigBundle!(ctx({ principal: alice, body }), d);
    expect((d.streams.get('sh:cp:audit') ?? [])[1]).toMatchObject({
      decision: 'config_bundle_unchanged',
      configRef: body.digest,
    });
  });

  it('refuses a digest that does not match the tar', async () => {
    const body = { ...bundle(), digest: 'sha256:' + 'a'.repeat(64) };
    expect(
      await codeOf(() => HANDLERS.putConfigBundle!(ctx({ principal: alice, body }), makeDeps())),
    ).toBe('digest_mismatch');
  });

  it(
    'refuses a tar with a negative entry size promptly, as digest_mismatch',
    { timeout: 2000 },
    async () => {
      const h = Buffer.alloc(512);
      h.write('evil.md', 0, 100, 'utf8');
      h.write('-1000', 124, 12, 'ascii');
      h.write('0', 156, 1, 'ascii');
      const body = {
        digest: 'sha256:' + 'c'.repeat(64),
        tar: Buffer.concat([h, Buffer.alloc(1024)]).toString('base64'),
      };
      expect(
        await codeOf(() => HANDLERS.putConfigBundle!(ctx({ principal: alice, body }), makeDeps())),
      ).toBe('digest_mismatch');
    },
  );

  it('refuses a tar that is not strict base64 as invalid_request, not digest_mismatch', async () => {
    const good = bundle();
    for (const tar of [good.tar.slice(0, -1) + '!', 'abc', good.tar + '\n', '====']) {
      const body = { digest: good.digest, tar };
      expect(
        await codeOf(() => HANDLERS.putConfigBundle!(ctx({ principal: alice, body }), makeDeps())),
        JSON.stringify(tar.slice(-4)),
      ).toBe('invalid_request');
    }
  });

  it('refuses a malformed digest and a missing tar', async () => {
    const d = makeDeps();
    const good = bundle();
    expect(
      await codeOf(() =>
        HANDLERS.putConfigBundle!(ctx({ principal: alice, body: { ...good, digest: 'x' } }), d),
      ),
    ).toBe('invalid_request');
    expect(
      await codeOf(() =>
        HANDLERS.putConfigBundle!(ctx({ principal: alice, body: { digest: good.digest } }), d),
      ),
    ).toBe('invalid_request');
  });

  it('refuses a tar over MAX_BUNDLE_BYTES, naming the cap', async () => {
    const body = {
      digest: 'sha256:' + 'b'.repeat(64),
      tar: Buffer.alloc(MAX_BUNDLE_BYTES + 1).toString('base64'),
    };
    await expect(
      HANDLERS.putConfigBundle!(ctx({ principal: alice, body }), makeDeps()),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining(String(MAX_BUNDLE_BYTES)),
    });
  });

  it('accepts a body far above the 64 KiB default through the real router', async () => {
    const d = makeDeps();
    const token = d.signer.mint({
      sub: 'github:1234',
      tenant: 'github:1234',
      roles: [],
      scope: ['api'],
      ttlSeconds: 3600,
      now: Math.floor(d.now() / 1000),
    });
    const server = createServer(buildHandler(d)).listen(0);
    onTestFinished(() => void server.close());
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;
    const body = bundle();
    // Padding inside the JSON keeps the request valid while pushing it past 64 KiB.
    const payload = JSON.stringify({ ...body, pad: 'x'.repeat(100 * 1024) });
    const res = await fetch(`http://127.0.0.1:${port}/v1/config-bundles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: payload,
    });
    expect(res.status).toBe(201);
  });
});

describe('POST /v1/config-bundles refusals', () => {
  const refusals = (d: ReturnType<typeof makeDeps>) =>
    (d.streams.get('sh:cp:audit') ?? []).filter((r) => r.decision === 'config_bundle_refused');

  it('audits each refused upload with its reason code', async () => {
    const d = makeDeps({ withStreams: true, config: { bundleSubjectBytes: 1 } });
    const good = bundle();
    const tries = [
      { ...good, digest: 'sha256:' + 'a'.repeat(64) },
      { digest: good.digest, tar: 'ab!=' },
      { digest: good.digest, tar: Buffer.alloc(MAX_BUNDLE_BYTES + 1).toString('base64') },
      good,
    ];
    for (const body of tries) {
      await HANDLERS.putConfigBundle!(ctx({ principal: alice, body }), d).catch(() => undefined);
    }
    expect(refusals(d).map((r) => r.reason)).toEqual([
      'digest_mismatch',
      'invalid_request',
      'invalid_request',
      'bundle_quota_exceeded',
    ]);
    expect(refusals(d)[0]).toMatchObject({ subject: alice.sub, configRef: tries[0]!.digest });
    expect(refusals(d)[2]!.bytes).toBe(String(MAX_BUNDLE_BYTES + 1));
  });

  it('logs a store failure with route context and answers 503 redis_unavailable', async () => {
    const d = makeDeps({ withStreams: true });
    d.bundles.exists = async () => {
      throw new Error('ECONNRESET from the store');
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onTestFinished(() => log.mockRestore());
    const body = bundle();
    expect(await codeOf(() => HANDLERS.putConfigBundle!(ctx({ principal: alice, body }), d))).toBe(
      'redis_unavailable',
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('putConfigBundle'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET from the store'));
    expect(String(log.mock.calls[0]![0])).not.toContain(body.tar.slice(0, 40));
    expect(refusals(d)).toEqual([]);
  });
});

type FakeBundles = ReturnType<typeof fakeBundleRedis>;

describe('POST /v1/config-bundles byte budget', () => {
  type Body = ReturnType<typeof bundle>;
  /** What Redis stores for a bundle -- the unit the budget counts. */
  async function storedBytes(body: Body): Promise<number> {
    const d = makeDeps();
    await HANDLERS.putConfigBundle!(ctx({ principal: alice, body }), d);
    return (d.bundles as unknown as { store: Map<string, string> }).store.get(
      bundleKey(body.digest),
    )!.length;
  }
  /** What the budget charges: the stored length, floored for key and index overhead. */
  const charge = async (body: Body) => Math.max(await storedBytes(body), MIN_BUNDLE_CHARGE_BYTES);
  const put = (d: ReturnType<typeof makeDeps>, principal: typeof alice, body: Body) =>
    HANDLERS.putConfigBundle!(ctx({ principal, body }), d);

  it('charges a tiny bundle the 4 KiB floor, so the subject budget fills after budget/4096', async () => {
    const d = makeDeps({
      config: { bundleSubjectBytes: 5 * MIN_BUNDLE_CHARGE_BYTES, bundleTotalBytes: 1 << 30 },
    });
    for (let i = 0; i < 5; i++) {
      expect((await put(d, alice, bundle(`tiny-${i}`))).body).toMatchObject({ uploaded: true });
    }
    await expect(put(d, alice, bundle('tiny-5'))).rejects.toMatchObject({
      code: 'bundle_quota_exceeded',
    });
  });

  it('serializes concurrent new uploads: exactly the ones that fit succeed', async () => {
    const d = makeDeps({
      config: { bundleSubjectBytes: 3 * MIN_BUNDLE_CHARGE_BYTES, bundleTotalBytes: 1 << 30 },
    });
    const bodies = Array.from({ length: 8 }, (_, i) => bundle(`par-${i}`));
    const results = await Promise.allSettled(bodies.map((b) => put(d, alice, b)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const refused = results.filter((r) => r.status === 'rejected');
    expect(refused).toHaveLength(5);
    for (const r of refused) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'bundle_quota_exceeded' });
    }
    expect((d.bundles as unknown as FakeBundles).store.size).toBe(3);
  });

  it('charges before storing and rolls the charge back when the SET fails', async () => {
    const d = makeDeps();
    const fake = d.bundles as unknown as FakeBundles;
    const seenAtSet: number[] = [];
    d.bundles.set = async () => {
      seenAtSet.push(fake.zsets.get(BUNDLES_ALL_KEY)?.size ?? 0);
      throw new Error('OOM command not allowed');
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onTestFinished(() => log.mockRestore());
    const body = bundle('rollback');
    expect(await codeOf(() => put(d, alice, body))).toBe('redis_unavailable');
    expect(seenAtSet).toEqual([1]);
    expect(fake.zsets.get(BUNDLES_ALL_KEY)?.size ?? 0).toBe(0);
    expect(fake.zsets.get(bundleOwnerKey(alice.sub))?.size ?? 0).toBe(0);
    expect(fake.hashes.get(BUNDLES_META_KEY)?.size ?? 0).toBe(0);
  });

  it('stores nothing when recording the charge fails', async () => {
    const d = makeDeps();
    const fake = d.bundles as unknown as FakeBundles;
    d.bundles.hSet = async () => {
      throw new Error('ECONNRESET');
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onTestFinished(() => log.mockRestore());
    expect(await codeOf(() => put(d, alice, bundle('norecord')))).toBe('redis_unavailable');
    expect(fake.store.size).toBe(0);
  });

  it('leaves no phantom charge when recording fails partway', async () => {
    const d = makeDeps();
    const fake = d.bundles as unknown as FakeBundles;
    const zAdd = d.bundles.zAdd.bind(d.bundles);
    d.bundles.zAdd = async (key, member) => {
      if (key !== BUNDLES_ALL_KEY) throw new Error('ECONNRESET');
      return zAdd(key, member);
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onTestFinished(() => log.mockRestore());
    expect(await codeOf(() => put(d, alice, bundle('partial')))).toBe('redis_unavailable');
    expect(fake.store.size).toBe(0);
    expect(fake.zsets.get(BUNDLES_ALL_KEY)?.size ?? 0).toBe(0);
    expect(fake.hashes.get(BUNDLES_META_KEY)?.size ?? 0).toBe(0);
  });

  it('refuses a new digest that would exceed the per-subject budget, naming it', async () => {
    const a = bundle('a');
    const b = bundle('b');
    const limit = (await charge(a)) + (await charge(b)) - 1;
    const d = makeDeps({ config: { bundleSubjectBytes: limit, bundleTotalBytes: 1 << 30 } });
    await put(d, alice, a);
    await expect(put(d, alice, b)).rejects.toMatchObject({
      code: 'bundle_quota_exceeded',
      message: expect.stringMatching(new RegExp(`your .*${limit} bytes`)),
    });
    // Another subject still has room.
    expect((await put(d, bob, b)).status).toBe(201);
  });

  it('refuses a new digest that would exceed the global budget across subjects', async () => {
    const a = bundle('a');
    const b = bundle('b');
    const limit = (await charge(a)) + (await charge(b)) - 1;
    const d = makeDeps({ config: { bundleSubjectBytes: 1 << 30, bundleTotalBytes: limit } });
    await put(d, alice, a);
    await expect(put(d, bob, b)).rejects.toMatchObject({
      code: 'bundle_quota_exceeded',
      message: expect.stringMatching(new RegExp(`deployment.*${limit} bytes`)),
    });
  });

  it('answers 429 for bundle_quota_exceeded', () => {
    expect(statusFor('bundle_quota_exceeded')).toBe(429);
  });

  it('always accepts a re-upload of a stored digest, at a full budget, by anyone', async () => {
    const a = bundle('a');
    const size = await charge(a);
    const d = makeDeps({ config: { bundleSubjectBytes: size, bundleTotalBytes: size } });
    expect((await put(d, alice, a)).body).toMatchObject({ uploaded: true });
    expect((await put(d, alice, a)).body).toMatchObject({ uploaded: false });
    expect((await put(d, bob, a)).body).toMatchObject({ uploaded: false });
    const owned = (sub: string) => [
      ...((d.bundles as unknown as FakeBundles).zsets.get(bundleOwnerKey(sub))?.keys() ?? []),
    ];
    expect(owned(alice.sub)).toEqual([a.digest]);
    expect(owned(bob.sub)).toEqual([]);
  });

  it('stops counting a bundle once its TTL has passed', async () => {
    const a = bundle('a');
    const b = bundle('b');
    const limit = (await charge(a)) + (await charge(b)) - 1;
    let now = NOW_MS;
    const d = makeDeps({
      config: { bundleSubjectBytes: limit, bundleTotalBytes: limit },
      now: () => now,
    });
    await put(d, alice, a);
    now += DEFAULT_BUNDLE_TTL_SECONDS * 1000 + 1;
    (d.bundles as unknown as { store: Map<string, string> }).store.delete(bundleKey(a.digest));
    expect((await put(d, alice, b)).body).toMatchObject({ uploaded: true });
  });

  it('a re-upload refreshes the budget entry, so it keeps counting', async () => {
    const a = bundle('a');
    const b = bundle('b');
    const limit = (await charge(a)) + (await charge(b)) - 1;
    let now = NOW_MS;
    const d = makeDeps({
      config: { bundleSubjectBytes: limit, bundleTotalBytes: 1 << 30 },
      now: () => now,
    });
    await put(d, alice, a);
    now += DEFAULT_BUNDLE_TTL_SECONDS * 1000 - 1000;
    await put(d, alice, a);
    now += 2000;
    await expect(put(d, alice, b)).rejects.toMatchObject({ code: 'bundle_quota_exceeded' });
  });
});
