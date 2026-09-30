import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { credentialValue, withCredentials } from '../src/systemd-credentials.js';

function credDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sh-creds-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe('credentialValue', () => {
  it('falls back to the environment when no CREDENTIALS_DIRECTORY is set (Knative, compose)', () => {
    expect(credentialValue({ SH_EXCHANGE_TOKEN: 'from-env' }, 'SH_EXCHANGE_TOKEN')).toBe(
      'from-env',
    ); // notsecret
    expect(credentialValue({}, 'SH_EXCHANGE_TOKEN')).toBeUndefined();
    expect(credentialValue({ SH_EXCHANGE_TOKEN: '' }, 'SH_EXCHANGE_TOKEN')).toBeUndefined();
  });

  it('reads $CREDENTIALS_DIRECTORY/<name>, stripping exactly one trailing newline', () => {
    const dir = credDir({ A: 'v1\n', B: 'v2\r\n', C: 'v3', D: 'v4\n\n' });
    const env = { CREDENTIALS_DIRECTORY: dir };
    expect(credentialValue(env, 'A')).toBe('v1');
    expect(credentialValue(env, 'B')).toBe('v2');
    expect(credentialValue(env, 'C')).toBe('v3');
    // Only one: a value is never silently shortened by more than the newline an editor adds.
    expect(credentialValue(env, 'D')).toBe('v4\n');
  });

  it('falls back to the environment when the unit loads no credential of that name', () => {
    const env = { CREDENTIALS_DIRECTORY: credDir({}), SH_EXCHANGE_TOKEN: 'from-env' }; // notsecret
    expect(credentialValue(env, 'SH_EXCHANGE_TOKEN')).toBe('from-env');
  });

  it('refuses an empty credential file, naming the path, instead of booting without the secret', () => {
    const dir = credDir({ SH_CREDENTIAL_KEK: '\n' });
    expect(() => credentialValue({ CREDENTIALS_DIRECTORY: dir }, 'SH_CREDENTIAL_KEK')).toThrow(
      `SH_CREDENTIAL_KEK: systemd credential ${join(dir, 'SH_CREDENTIAL_KEK')} is empty`,
    );
  });

  it('refuses a secret set both ways rather than picking one', () => {
    const dir = credDir({ SH_EXCHANGE_TOKEN: 'from-file' });
    const env = { CREDENTIALS_DIRECTORY: dir, SH_EXCHANGE_TOKEN: 'from-env' }; // notsecret
    expect(() => credentialValue(env, 'SH_EXCHANGE_TOKEN')).toThrow(
      /both in the environment and as a systemd credential/,
    );
  });

  it('reports an unreadable credential (not ENOENT) instead of falling back', () => {
    const dir = credDir({});
    mkdirSync(join(dir, 'SH_EXCHANGE_TOKEN')); // a directory: EISDIR
    expect(() => credentialValue({ CREDENTIALS_DIRECTORY: dir }, 'SH_EXCHANGE_TOKEN')).toThrow(
      /cannot read systemd credential/,
    );
  });
});

describe('withCredentials', () => {
  it('returns a copy with each named secret resolved, and leaves its input untouched', () => {
    const dir = credDir({ SH_CREDENTIAL_KEK: 'kek\n' });
    const env: NodeJS.ProcessEnv = { CREDENTIALS_DIRECTORY: dir, OTHER: 'x' };
    const out = withCredentials(env, ['SH_CREDENTIAL_KEK', 'SH_EXCHANGE_TOKEN']);
    expect(out.SH_CREDENTIAL_KEK).toBe('kek');
    expect('SH_EXCHANGE_TOKEN' in out).toBe(false);
    expect(out.OTHER).toBe('x');
    // The resolved secret must not land back in the caller's env: process.env is inherited by every
    // child the control plane spawns (kubectl).
    expect(env.SH_CREDENTIAL_KEK).toBeUndefined();
  });
});
