import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeDefaultValidateToken } from '../src/main.js';

const EXEC = 'e'.repeat(64);
let dirs: string[] = [];
function tokenDir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'relay-tokens-'));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v);
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  vi.restoreAllMocks();
});

describe('makeDefaultValidateToken with SH_RELAY_TOKEN_DIR (spec §2.1-2.2)', () => {
  it('accepts the token in <dir>/<id>, with one trailing newline stripped', () => {
    const d = tokenDir({ moca_microvm_0: 'p4-token\n' });
    const v = makeDefaultValidateToken({ SH_RELAY_TOKEN_DIR: d, MOCA_RELAY_EXEC_TOKEN: EXEC });
    expect(v('p4-token', 'moca_microvm_0')).toBe(true);
    expect(v('p4-token\n', 'moca_microvm_0')).toBe(false);
    expect(v('wrong', 'moca_microvm_0')).toBe(false);
  });

  it('reads the file on EACH attach: a token written after the validator was built is accepted', () => {
    const d = tokenDir({});
    const v = makeDefaultValidateToken({ SH_RELAY_TOKEN_DIR: d, MOCA_RELAY_EXEC_TOKEN: EXEC });
    expect(v('later', 'moca_microvm_1')).toBe(false);
    writeFileSync(join(d, 'moca_microvm_1'), 'later');
    expect(v('later', 'moca_microvm_1')).toBe(true);
  });

  it('a missing file falls through to SH_RELAY_TOKEN_<id>, then SH_RELAY_TOKEN', () => {
    const d = tokenDir({});
    const v = makeDefaultValidateToken({
      SH_RELAY_TOKEN_DIR: d,
      SH_RELAY_TOKEN_sbx1: 'own',
      SH_RELAY_TOKEN: 'global',
    });
    expect(v('own', 'sbx1')).toBe(true);
    expect(v('global', 'moca_sandbox_0')).toBe(true);
  });

  it('an absent DIRECTORY falls through too (a container-only stack has no token Secret)', () => {
    const v = makeDefaultValidateToken({
      SH_RELAY_TOKEN_DIR: join(tmpdir(), 'no-such-relay-token-dir-xyz'),
      SH_RELAY_TOKEN: 'global',
    });
    expect(v('global', 'moca_sandbox_0')).toBe(true);
  });

  it('an EMPTY file is no token, and does not fall through', () => {
    const d = tokenDir({ moca_microvm_0: '' });
    const v = makeDefaultValidateToken({ SH_RELAY_TOKEN_DIR: d, SH_RELAY_TOKEN: 'global' });
    expect(v('global', 'moca_microvm_0')).toBe(false);
    expect(v('', 'moca_microvm_0')).toBe(false);
  });

  it('a read error other than ENOENT refuses the attach, and does not fall through', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const v = makeDefaultValidateToken(
      { SH_RELAY_TOKEN_DIR: '/run/relay-tokens', SH_RELAY_TOKEN: 'global' },
      {
        readFile: () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        },
      },
    );
    expect(v('global', 'moca_microvm_0')).toBe(false);
    expect(err.mock.calls.flat().join(' ')).toMatch(/relay token for moca_microvm_0 unreadable/);
  });

  it('refuses a directory token equal to the exec token, logging the id only', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = tokenDir({ moca_microvm_0: EXEC });
    const v = makeDefaultValidateToken({ SH_RELAY_TOKEN_DIR: d, MOCA_RELAY_EXEC_TOKEN: EXEC });
    expect(v(EXEC, 'moca_microvm_0')).toBe(false);
    const logged = err.mock.calls.flat().join(' ');
    expect(logged).toMatch(/relay token for moca_microvm_0 equals the exec token; refused/);
    expect(logged).not.toContain(EXEC);
  });

  it('looks up the directory only for ids matching ^[A-Za-z_][A-Za-z0-9_]*$; others use the env path', () => {
    const readFile = vi.fn(() => 'x');
    const v = makeDefaultValidateToken(
      { SH_RELAY_TOKEN_DIR: '/run/relay-tokens', SH_RELAY_TOKEN: 'global' },
      { readFile },
    );
    // No path traversal: these never touch the directory, and 'x' is not the env token.
    for (const id of ['../etc/passwd', 'a/b', '0abc', '']) {
      expect(v('x', id), id).toBe(false);
    }
    // The container tier's dashed ids (moca-sandbox-N) keep authenticating with SH_RELAY_TOKEN.
    expect(v('global', 'moca-sandbox-0')).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
  });
});
