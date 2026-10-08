import { createHash } from 'node:crypto';

const BLOCK = 512;
/** USTAR encodes a path as prefix(155) + '/' + name(100). */
export const MAX_USTAR_PATH = 255;

import type { TarEntry } from './types.js';

/** Write `n` as a NUL-terminated octal field of `len` bytes (len-1 digits + NUL). */
function writeOctal(b: Buffer, n: number, off: number, len: number): void {
  b.write(n.toString(8).padStart(len - 1, '0') + '\0', off, len, 'ascii');
}

/** Split a path into USTAR name/prefix. Throws rather than truncate. */
export function splitUstarPath(p: string): { name: string; prefix: string } {
  if (Buffer.byteLength(p) <= 100) return { name: p, prefix: '' };
  for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) {
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`path too long for USTAR (max ${MAX_USTAR_PATH} with a '/' split point): ${p}`);
}

function header(path: string, size: number, mode: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  const { name, prefix } = splitUstarPath(path);
  h.write(name, 0, 100, 'utf8');
  writeOctal(h, mode & 0o7777, 100, 8);
  writeOctal(h, 0, 108, 8); // uid — always 0, never the builder's
  writeOctal(h, 0, 116, 8); // gid
  writeOctal(h, size, 124, 12);
  writeOctal(h, 0, 136, 12); // mtime — always 0, the usual source of tar non-determinism
  h.write('        ', 148, 8, 'ascii'); // checksum computed over spaces, then overwritten
  h.write('0', 156, 1, 'ascii'); // type: regular file
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

/**
 * Deterministic USTAR archive: entries sorted byte-wise by path, no mtime/uid/gid, fixed
 * modes. Two builds of the same content produce byte-identical output, which is what makes
 * the digest a stable identity (spec §4.1).
 */
export function canonicalTar(entries: TarEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')),
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(header(entry.path, entry.content.length, entry.mode ?? 0o644));
    parts.push(entry.content);
    const pad = (BLOCK - (entry.content.length % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive
  return Buffer.concat(parts);
}

/** Unsigned octal or nothing: `parseInt` would accept a sign and junk, and a negative size can walk
 * the read offset backwards forever. */
function octalField(text: string, field: string): number {
  const t = text.trim();
  if (!/^[0-7]*$/.test(t)) throw new Error(`invalid tar ${field} field: ${JSON.stringify(t)}`);
  return t === '' ? 0 : parseInt(t, 8);
}

/** Read a canonical archive back. Ignores anything that is not a regular file. Throws on a
 * malformed header or a truncated entry; the offset strictly advances, so it always terminates. */
export function untar(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  for (let off = 0; off + BLOCK <= tar.length;) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break; // end-of-archive
    const cstr = (s: number, n: number) => {
      const raw = h.subarray(s, s + n);
      const z = raw.indexOf(0);
      return raw.subarray(0, z === -1 ? n : z).toString('utf8');
    };
    const name = cstr(0, 100);
    const prefix = cstr(345, 155);
    const mode = octalField(cstr(100, 8), 'mode');
    const size = octalField(cstr(124, 12), 'size');
    const type = h.subarray(156, 157).toString('ascii');
    off += BLOCK;
    if (off + size > tar.length) throw new Error(`truncated tar: entry ${name} runs past the end`);
    if (type === '0' || type === '\0') {
      out.push({
        path: prefix ? `${prefix}/${name}` : name,
        content: Buffer.from(tar.subarray(off, off + size)),
        mode,
      });
    }
    const next = off + Math.ceil(size / BLOCK) * BLOCK;
    if (next < off) throw new Error('tar offset did not advance');
    off = next;
  }
  return out;
}

/** Content address of a canonical archive. */
export function digestOf(tar: Buffer): string {
  return 'sha256:' + createHash('sha256').update(tar).digest('hex');
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Thrown by `assertValidDigest` for anything not matching `sha256:<64 lowercase hex>`. The
 * message caps how much of the bad value it echoes, so a long or crafted string (e.g. a
 * path-traversal payload) doesn't ride unbounded into logs or a rendered error.
 */
export class InvalidDigestError extends Error {
  constructor(digest: string) {
    const shown =
      digest.length > 40 ? `${digest.slice(0, 40)}...(${digest.length} chars total)` : digest;
    super(
      `invalid digest: expected 'sha256:' + 64 lowercase hex chars, got ${JSON.stringify(shown)}`,
    );
    this.name = 'InvalidDigestError';
  }
}

/**
 * Reject any digest string not shaped `sha256:<64 lowercase hex>`. Both `unpackBundle`
 * (harness/src/config-resolver.ts) and `configCacheDir` (harness/src/config-overlay.ts) turn a
 * digest into a filesystem path via `digestDirName` + `join(baseDir, ...)`; a shape like
 * `sha256:../../../evil` would otherwise walk that join straight out of the base directory.
 * Neither pod currently accepts an attacker-chosen digest over the wire today -- this is
 * defense-in-depth against a digest string that originated somewhere less trusted than the
 * builder in this package, not a demonstrated live exploit. One shared check, called from both
 * sites, keeps that guarantee from drifting between them.
 */
export function assertValidDigest(digest: string): string {
  if (!DIGEST_RE.test(digest)) throw new InvalidDigestError(digest);
  return digest;
}

/** Filesystem-safe form of a digest, for use as a directory name. `replaceAll`, not `replace`:
 * a digest has exactly one `:` today (`sha256:<hex>`), but a single `replace` silently stops
 * after the first match, so a future multi-colon shape would collide two distinct digests into
 * the same directory name instead of erroring. */
export function digestDirName(digest: string): string {
  return digest.replaceAll(':', '-');
}
