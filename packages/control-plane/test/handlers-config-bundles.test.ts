import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { buildBundle, MAX_BUNDLE_BYTES } from '@moca/config-bundle';
import { HANDLERS } from '../src/handlers.js';
import { buildHandler } from '../src/server.js';
import { alice, codeOf, ctx, makeDeps } from './helpers/deps.js';

function bundle() {
  const root = mkdtempSync(join(tmpdir(), 'cp-bundle-'));
  mkdirSync(join(root, 'skills/hello'), { recursive: true });
  writeFileSync(join(root, 'skills/hello/SKILL.md'), '---\nname: hello\ndescription: d\n---\nhi\n');
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

  it('refuses a digest that does not match the tar', async () => {
    const body = { ...bundle(), digest: 'sha256:' + 'a'.repeat(64) };
    expect(
      await codeOf(() => HANDLERS.putConfigBundle!(ctx({ principal: alice, body }), makeDeps())),
    ).toBe('digest_mismatch');
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
