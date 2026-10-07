import { bundleKey, DEFAULT_BUNDLE_TTL_SECONDS } from '@moca/config-bundle';
import { CpError } from './errors.js';
import { subjectHash } from './subject-document.js';

/**
 * The Redis surface the config-bundle byte budget needs (R2 of the PR #458 review). Shapes match
 * node-redis: `zRange` here is the plain (key, MIN, MAX) BY SCORE form, not the index's REV form.
 */
export interface BundleBudgetRedisLike {
  zAdd(key: string, member: { score: number; value: string }): Promise<unknown>;
  zRange(
    key: string,
    min: number | string,
    max: number | string,
    opts: { BY: 'SCORE' },
  ): Promise<string[]>;
  zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<unknown>;
  hSet(key: string, values: Record<string, string>): Promise<unknown>;
  hmGet(key: string, fields: string[]): Promise<(string | null)[]>;
  hDel(key: string, fields: string[]): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/**
 * Layout. Each zset member is a digest scored by its expiry (epoch ms), so an entry ages out with
 * the bundle's own TTL; `meta` holds `<storedBytes>:<subjectHash of the first uploader>`.
 */
export const BUNDLES_ALL_KEY = 'sh:cp:bundles:all';
export const BUNDLES_META_KEY = 'sh:cp:bundles:meta';
const ownerZsetFor = (hash: string): string => `sh:cp:bundles:owner:${hash}`;
export const bundleOwnerKey = (subject: string): string => ownerZsetFor(subjectHash(subject));

export interface BundleBudgetLimits {
  subjectBytes: number;
  totalBytes: number;
}

const expiryMs = (nowMs: number): number => nowMs + DEFAULT_BUNDLE_TTL_SECONDS * 1000;

function parseMeta(raw: string | null): { bytes: number; owner: string } | null {
  if (raw === null) return null;
  const i = raw.indexOf(':');
  const bytes = Number(raw.slice(0, i));
  return i > 0 && Number.isFinite(bytes) ? { bytes, owner: raw.slice(i + 1) } : null;
}

/**
 * Refuse a NEW digest of `bytes` stored bytes that would take `subject` or the deployment past its
 * budget. Two concurrent uploads can both pass and overshoot by at most one bundle each; no lock.
 */
export async function admitBundle(
  redis: BundleBudgetRedisLike,
  limits: BundleBudgetLimits,
  subject: string,
  bytes: number,
  nowMs: number,
): Promise<void> {
  const ownKey = bundleOwnerKey(subject);
  const expired = await redis.zRange(BUNDLES_ALL_KEY, '-inf', nowMs, { BY: 'SCORE' });
  if (expired.length > 0) {
    await redis.hDel(BUNDLES_META_KEY, expired);
    await redis.zRemRangeByScore(BUNDLES_ALL_KEY, '-inf', nowMs);
  }
  await redis.zRemRangeByScore(ownKey, '-inf', nowMs);
  const live = await redis.zRange(BUNDLES_ALL_KEY, `(${nowMs}`, '+inf', { BY: 'SCORE' });
  const mine = new Set(await redis.zRange(ownKey, `(${nowMs}`, '+inf', { BY: 'SCORE' }));
  const metas = live.length > 0 ? await redis.hmGet(BUNDLES_META_KEY, live) : [];
  let total = 0;
  let own = 0;
  live.forEach((digest, i) => {
    const b = parseMeta(metas[i] ?? null)?.bytes ?? 0;
    total += b;
    if (mine.has(digest)) own += b;
  });
  if (own + bytes > limits.subjectBytes) {
    throw new CpError(
      'bundle_quota_exceeded',
      `storing this ${bytes}-byte bundle would exceed your config-bundle budget of ` +
        `${limits.subjectBytes} bytes (${own} in use)`,
    );
  }
  if (total + bytes > limits.totalBytes) {
    throw new CpError(
      'bundle_quota_exceeded',
      `storing this ${bytes}-byte bundle would exceed the deployment's config-bundle budget of ` +
        `${limits.totalBytes} bytes`,
    );
  }
}

/** Charge a newly stored digest to the subject that stored it. */
export async function recordBundle(
  redis: BundleBudgetRedisLike,
  subject: string,
  digest: string,
  bytes: number,
  nowMs: number,
): Promise<void> {
  const hash = subjectHash(subject);
  const score = expiryMs(nowMs);
  await redis.hSet(BUNDLES_META_KEY, { [digest]: `${bytes}:${hash}` });
  await redis.zAdd(BUNDLES_ALL_KEY, { score, value: digest });
  await redis.zAdd(ownerZsetFor(hash), { score, value: digest });
  await redis.expire(ownerZsetFor(hash), DEFAULT_BUNDLE_TTL_SECONDS);
}

/** Push a stored digest's budget expiry out with its TTL. A digest with no entry is left alone. */
export async function refreshBundle(
  redis: BundleBudgetRedisLike,
  digest: string,
  nowMs: number,
): Promise<void> {
  const [raw] = await redis.hmGet(BUNDLES_META_KEY, [digest]);
  const meta = parseMeta(raw ?? null);
  if (!meta) return;
  const score = expiryMs(nowMs);
  await redis.zAdd(BUNDLES_ALL_KEY, { score, value: digest });
  await redis.zAdd(ownerZsetFor(meta.owner), { score, value: digest });
  await redis.expire(ownerZsetFor(meta.owner), DEFAULT_BUNDLE_TTL_SECONDS);
}

/** A session is using `digest`: keep the bundle and its budget entry alive for another TTL. */
export async function touchBundle(
  redis: BundleBudgetRedisLike,
  digest: string,
  nowMs: number,
): Promise<void> {
  await redis.expire(bundleKey(digest), DEFAULT_BUNDLE_TTL_SECONDS);
  await refreshBundle(redis, digest, nowMs);
}
