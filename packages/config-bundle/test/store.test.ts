import { describe, it, expect } from 'vitest';
import { buildBundle, canonicalTar, contentDigest, LOCKFILE_PATH, untar } from '../src/index.js';
import {
  bundleKey,
  putBundle,
  getBundle,
  BundleNotFoundError,
  BundleDigestMismatchError,
  DEFAULT_BUNDLE_TTL_SECONDS,
  MAX_BUNDLE_BYTES,
  type BundleRedisLike,
} from '../src/store.js';

/** In-memory fake, mirroring the RedisLike pattern in leaf-result-store.ts. */
function fakeRedis(): BundleRedisLike & {
  store: Map<string, string>;
  sets: number;
  expires: Array<{ key: string; seconds: number }>;
} {
  const store = new Map<string, string>();
  const expires: Array<{ key: string; seconds: number }> = [];
  return {
    store,
    sets: 0,
    expires,
    async set(key, value) {
      this.sets++;
      store.set(key, value);
      return 'OK';
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async exists(key) {
      return store.has(key) ? 1 : 0;
    },
    async expire(key, seconds) {
      expires.push({ key, seconds });
      return 'OK';
    },
  };
}

const tar = canonicalTar([
  { path: 'skills/x/SKILL.md', content: Buffer.from('---\nname: x\n---\nb') },
]);
const digest = contentDigest(untar(tar)); // computed from tar: verification ensures round-trip fidelity

describe('bundleKey', () => {
  it('namespaces by digest', () => {
    expect(bundleKey('sha256:abc')).toBe('config:bundle:sha256:abc');
  });
});

describe('putBundle', () => {
  it('uploads when absent and reports uploaded: true', async () => {
    const r = fakeRedis();
    expect(await putBundle(r, digest, tar)).toEqual({ uploaded: true });
    expect(r.store.has(bundleKey(digest))).toBe(true);
  });

  it('is a no-op when the digest is already present (re-promotion is free)', async () => {
    const r = fakeRedis();
    await putBundle(r, digest, tar);
    const before = r.sets;
    expect(await putBundle(r, digest, tar)).toEqual({ uploaded: false });
    expect(r.sets).toBe(before);
  });

  it('asks admit with the exact stored length, for a new digest only, and a refusal stores nothing', async () => {
    const r = fakeRedis();
    const asked: number[] = [];
    await expect(
      putBundle(r, digest, tar, undefined, async (n) => {
        asked.push(n);
        throw new Error('full');
      }),
    ).rejects.toThrow('full');
    expect(r.store.size).toBe(0);
    await putBundle(r, digest, tar, undefined, async (n) => void asked.push(n));
    expect(asked[1]).toBe(r.store.get(bundleKey(digest))!.length);
    await putBundle(r, digest, tar, undefined, async (n) => void asked.push(n));
    expect(asked).toHaveLength(2);
  });

  it('sets a TTL', async () => {
    const seen: Array<{ EX?: number } | undefined> = [];
    const r = fakeRedis();
    const spy: BundleRedisLike = {
      ...r,
      set: async (k, v, o) => (seen.push(o), r.set(k, v, o)),
    };
    await putBundle(spy, digest, tar);
    expect(seen[0]).toEqual({ EX: DEFAULT_BUNDLE_TTL_SECONDS });
  });

  it('throws BundleDigestMismatchError when digest does not match tar', async () => {
    const r = fakeRedis();
    const badDigest = 'sha256:' + '0'.repeat(64);
    await expect(putBundle(r, badDigest, tar)).rejects.toThrow(BundleDigestMismatchError);
    expect(r.sets).toBe(0);
    expect(r.store.size).toBe(0);
  });

  it('refreshes TTL on skip (re-promotion does not age out active bundles)', async () => {
    const r = fakeRedis();
    await putBundle(r, digest, tar);
    expect(r.sets).toBe(1);
    const before = r.expires.length;
    expect(await putBundle(r, digest, tar)).toEqual({ uploaded: false });
    expect(r.sets).toBe(1);
    expect(r.expires.length).toBe(before + 1);
    expect(r.expires[before]).toEqual({
      key: bundleKey(digest),
      seconds: DEFAULT_BUNDLE_TTL_SECONDS,
    });
  });
});

describe('getBundle', () => {
  it('round-trips the exact bytes', async () => {
    const r = fakeRedis();
    await putBundle(r, digest, tar);
    expect((await getBundle(r, digest)).equals(tar)).toBe(true);
  });

  it('throws BundleNotFoundError with the digest in the message', async () => {
    await expect(getBundle(fakeRedis(), digest)).rejects.toThrow(BundleNotFoundError);
    await expect(getBundle(fakeRedis(), digest)).rejects.toThrow(digest);
  });

  it('throws BundleDigestMismatchError on corrupted stored bytes', async () => {
    const r = fakeRedis();
    const real = buildBundle({
      roots: {},
      entry: 'e',
      mode: 'unattended',
      sandboxImage: 'i',
      versions: { pi: '1', harness: '1' },
    });
    await putBundle(r, real.digest, real.tar);
    // corrupt the stored payload
    r.store.set(bundleKey(real.digest), Buffer.from('not a tar').toString('base64'));
    await expect(getBundle(r, real.digest)).rejects.toThrow(BundleDigestMismatchError);
  });

  it('accepts a bundle whose recomputed content digest matches', async () => {
    const r = fakeRedis();
    const real = buildBundle({
      roots: {},
      entry: 'e',
      mode: 'unattended',
      sandboxImage: 'i',
      versions: { pi: '1', harness: '1' },
    });
    await putBundle(r, real.digest, real.tar);
    const got = untar(await getBundle(r, real.digest));
    expect(contentDigest(got)).toBe(real.digest);
  });

  it('stores the canonical tar of the verified entries, without lockfile.json', async () => {
    const r = fakeRedis();
    const real = buildBundle({
      roots: {},
      entry: 'e',
      mode: 'unattended',
      sandboxImage: 'i',
      versions: { pi: '1', harness: '1' },
    });
    expect(untar(real.tar).map((e) => e.path)).toContain(LOCKFILE_PATH);
    await putBundle(r, real.digest, real.tar);
    const stored = await getBundle(r, real.digest);
    const content = untar(real.tar).filter((e) => e.path !== LOCKFILE_PATH);
    expect(stored.equals(canonicalTar(content))).toBe(true);
  });

  it('stores bytes that depend on the digest alone, not on the first uploader', async () => {
    const content = [{ path: 'skills/x/SKILL.md', content: Buffer.from('---\nname: x\n---\nb') }];
    const forged = canonicalTar([
      ...content,
      { path: LOCKFILE_PATH, content: Buffer.from('{"forged":true}') },
    ]);
    const withJunk = Buffer.concat([canonicalTar(content), Buffer.from('trailing junk')]);
    const d = contentDigest(content);
    const a = fakeRedis();
    const b = fakeRedis();
    await putBundle(a, d, forged);
    await putBundle(b, d, withJunk);
    expect(await getBundle(a, d)).toEqual(await getBundle(b, d));
    expect((await getBundle(a, d)).equals(canonicalTar(content))).toBe(true);
  });

  it('rejects valid bytes stored under the wrong digest (digest comparison path)', async () => {
    const r = fakeRedis();
    // Create two distinct valid tars
    const tarA = canonicalTar([
      { path: 'skills/a/SKILL.md', content: Buffer.from('---\nname: a\n---\naaa') },
    ]);
    const tarB = canonicalTar([
      { path: 'skills/b/SKILL.md', content: Buffer.from('---\nname: b\n---\nbbb') },
    ]);
    const digestA = contentDigest(untar(tarA));
    const digestB = contentDigest(untar(tarB));
    // Store B correctly
    await putBundle(r, digestB, tarB);
    // Swap B's bytes under A's key
    r.store.set(bundleKey(digestA), r.store.get(bundleKey(digestB))!);
    // Attempt to retrieve A should fail: bytes are valid but hash to B, not A
    await expect(getBundle(r, digestA)).rejects.toThrow(BundleDigestMismatchError);
  });
});

describe('MAX_BUNDLE_BYTES', () => {
  it('is 8 MiB, the bound the control plane and mocactl both enforce', () => {
    expect(MAX_BUNDLE_BYTES).toBe(8 * 1024 * 1024);
  });
});
