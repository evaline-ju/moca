import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  buildBundle,
  bundleKey,
  DEFAULT_BUNDLE_TTL_SECONDS,
  MAX_BUNDLE_BYTES,
} from '@moca/config-bundle';
import { statusFor } from '../src/errors.js';
import { HANDLERS } from '../src/handlers.js';
import { buildHandler } from '../src/server.js';
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
  const put = (d: ReturnType<typeof makeDeps>, principal: typeof alice, body: Body) =>
    HANDLERS.putConfigBundle!(ctx({ principal, body }), d);

  it('refuses a new digest that would exceed the per-subject budget, naming it', async () => {
    const a = bundle('a');
    const b = bundle('b');
    const limit = (await storedBytes(a)) + (await storedBytes(b)) - 1;
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
    const limit = (await storedBytes(a)) + (await storedBytes(b)) - 1;
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
    const size = await storedBytes(a);
    const d = makeDeps({ config: { bundleSubjectBytes: size, bundleTotalBytes: size } });
    expect((await put(d, alice, a)).body).toMatchObject({ uploaded: true });
    expect((await put(d, alice, a)).body).toMatchObject({ uploaded: false });
    expect((await put(d, bob, a)).body).toMatchObject({ uploaded: false });
    // Bob was not charged for alice's digest: he still has his whole budget for... nothing else
    // fits globally, which is the global budget's job, not his.
    await expect(put(d, bob, bundle('b'))).rejects.toMatchObject({
      code: 'bundle_quota_exceeded',
      message: expect.stringContaining('deployment'),
    });
  });

  it('stops counting a bundle once its TTL has passed', async () => {
    const a = bundle('a');
    const b = bundle('b');
    const limit = (await storedBytes(a)) + (await storedBytes(b)) - 1;
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
    const limit = (await storedBytes(a)) + (await storedBytes(b)) - 1;
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
