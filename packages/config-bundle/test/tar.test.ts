import { describe, it, expect } from 'vitest';
import {
  canonicalTar,
  untar,
  digestOf,
  MAX_USTAR_PATH,
  assertValidDigest,
  InvalidDigestError,
  digestDirName,
} from '../src/tar.js';

const e = (path: string, body: string, mode?: number) => ({
  path,
  content: Buffer.from(body),
  ...(mode === undefined ? {} : { mode }),
});

describe('canonicalTar', () => {
  it('is byte-identical regardless of input entry order', () => {
    const a = canonicalTar([e('b/two.md', 'two'), e('a/one.md', 'one')]);
    const b = canonicalTar([e('a/one.md', 'one'), e('b/two.md', 'two')]);
    expect(a.equals(b)).toBe(true);
  });

  it('embeds no mtime, uid or gid (the fields that make tars non-reproducible)', () => {
    const t = canonicalTar([e('a.md', 'x')]);
    // header field offsets: uid 108(8), gid 116(8), mtime 136(12)
    expect(t.subarray(108, 116).toString('ascii')).toBe('0000000\0');
    expect(t.subarray(116, 124).toString('ascii')).toBe('0000000\0');
    expect(t.subarray(136, 148).toString('ascii')).toBe('00000000000\0');
  });

  it('pads each entry to a 512-byte boundary and ends with two zero blocks', () => {
    const t = canonicalTar([e('a.md', 'x')]);
    expect(t.length % 512).toBe(0);
    expect(t.subarray(t.length - 1024).every((b) => b === 0)).toBe(true);
  });

  it('writes a valid USTAR magic and checksum', () => {
    const t = canonicalTar([e('a.md', 'x')]);
    expect(t.subarray(257, 263).toString('ascii')).toBe('ustar\0');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : t[i]!;
    expect(parseInt(t.subarray(148, 154).toString('ascii'), 8)).toBe(sum);
  });

  it('rejects a path too long for USTAR instead of silently truncating', () => {
    const long = 'x'.repeat(MAX_USTAR_PATH + 1);
    expect(() => canonicalTar([e(long, 'x')])).toThrow(/too long for USTAR/);
  });

  it('splits a long-but-legal path across prefix and name', () => {
    const deep = 'a'.repeat(120) + '/' + 'b'.repeat(80);
    const t = canonicalTar([e(deep, 'x')]);
    expect(untar(t)[0]!.path).toBe(deep);
  });
});

describe('untar', () => {
  it('round-trips entries, contents and modes', () => {
    const entries = [e('skills/x/SKILL.md', '# x'), e('exec/run.sh', '#!/bin/sh\n', 0o755)];
    const back = untar(canonicalTar(entries));
    expect(back.map((x) => x.path)).toEqual(['exec/run.sh', 'skills/x/SKILL.md']);
    expect(back.find((x) => x.path === 'exec/run.sh')!.mode).toBe(0o755);
    expect(back.find((x) => x.path === 'skills/x/SKILL.md')!.content.toString()).toBe('# x');
  });

  it('handles content whose length is an exact multiple of 512', () => {
    const body = 'y'.repeat(1024);
    expect(untar(canonicalTar([e('a.md', body)]))[0]!.content.toString()).toBe(body);
  });
});

describe('digestOf', () => {
  it('is sha256:<64 hex> and stable for identical trees', () => {
    const d = digestOf(canonicalTar([e('a.md', 'x')]));
    expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestOf(canonicalTar([e('a.md', 'x')]))).toBe(d);
  });

  it('changes when any content changes', () => {
    const a = digestOf(canonicalTar([e('a.md', 'x')]));
    const b = digestOf(canonicalTar([e('a.md', 'y')]));
    expect(a).not.toBe(b);
  });
});

describe('assertValidDigest', () => {
  it('passes through a well-formed digest unchanged', () => {
    const good = 'sha256:' + '0123456789abcdef'.repeat(4);
    expect(assertValidDigest(good)).toBe(good);
  });

  it('rejects a path-traversal payload disguised as a digest', () => {
    expect(() => assertValidDigest('sha256:../../../evil')).toThrow(InvalidDigestError);
  });

  it('rejects hex of the wrong length', () => {
    expect(() => assertValidDigest('sha256:' + 'a'.repeat(63))).toThrow(InvalidDigestError);
    expect(() => assertValidDigest('sha256:' + 'a'.repeat(65))).toThrow(InvalidDigestError);
  });

  it('rejects uppercase hex', () => {
    expect(() => assertValidDigest('sha256:' + 'A'.repeat(64))).toThrow(InvalidDigestError);
  });

  it('rejects a digest missing the sha256: prefix', () => {
    expect(() => assertValidDigest('a'.repeat(64))).toThrow(InvalidDigestError);
  });

  it('rejects the empty string', () => {
    expect(() => assertValidDigest('')).toThrow(InvalidDigestError);
  });

  it('caps how much of a long bad value the error message echoes', () => {
    // The message must name the bad value's SHAPE without echoing an unbounded attacker string
    // (a long or crafted digest could otherwise ride, unbounded, into logs or a rendered error).
    const long = 'sha256:' + 'z'.repeat(5000);
    try {
      assertValidDigest(long);
      throw new Error('expected assertValidDigest to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidDigestError);
      const message = (err as Error).message;
      expect(message.length).toBeLessThan(200);
      expect(message).not.toContain('z'.repeat(5000));
    }
  });
});

describe('digestDirName', () => {
  it('replaces the colon in a normal digest', () => {
    expect(digestDirName('sha256:' + 'a'.repeat(64))).toBe('sha256-' + 'a'.repeat(64));
  });

  it('replaces every colon, not just the first (replaceAll, not replace)', () => {
    // A single `.replace(':', '-')` only swaps the first ':' and silently leaves the rest, so
    // 'a:b:c' would become 'a-b:c' instead of 'a-b-c' -- this fails if replaceAll is reverted to
    // replace.
    expect(digestDirName('a:b:c')).toBe('a-b-c');
  });
});

describe('untar on hostile input', () => {
  const hostile = (size: string, opts: { mode?: string } = {}) => {
    const h = Buffer.alloc(512);
    h.write('evil.md', 0, 100, 'utf8');
    h.write(opts.mode ?? '0000644\0', 100, 8, 'ascii');
    h.write(size, 124, 12, 'ascii');
    h.write('0', 156, 1, 'ascii');
    return Buffer.concat([h, Buffer.alloc(1024)]);
  };

  // A hang is synchronous, so the timeout only reports it; the RED run used a shell timeout.
  it('throws on a negative size instead of looping', { timeout: 1000 }, () => {
    expect(() => untar(hostile('-1000'))).toThrow(/size/);
  });

  it('throws on a non-octal size', { timeout: 1000 }, () => {
    expect(() => untar(hostile('0000009'))).toThrow(/size/);
  });

  it('throws on a non-octal mode', { timeout: 1000 }, () => {
    expect(() => untar(hostile('00000000001', { mode: '-000644' }))).toThrow(/mode/);
  });

  it('throws on an entry whose content runs past the end of the archive', { timeout: 1000 }, () => {
    expect(() => untar(hostile('00000010000').subarray(0, 600))).toThrow(/truncated/);
  });
});
