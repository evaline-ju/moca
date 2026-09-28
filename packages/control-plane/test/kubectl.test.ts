import * as crypto from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Partial mock: randomBytes stays real unless a test pins the temp file's name to force a collision.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});
import {
  buildCreateSecretArgs,
  buildDeleteSecretArgs,
  buildFindPodBySelectorArgs,
  buildGetPodPhaseArgs,
  buildGetSecretArgs,
  buildPatchSecretArgs,
  defaultRunKubectl,
  isAlreadyExists,
} from '../src/kubectl.js';

describe('secret argv builders', () => {
  it('creates an empty Secret by exact name', () => {
    expect(buildCreateSecretArgs('sh-cred-abc', 'sh-credentials')).toEqual([
      'create',
      'secret',
      'generic',
      'sh-cred-abc',
      '-n',
      'sh-credentials',
    ]);
  });

  it('patches from stdin, never from argv', () => {
    const args = buildPatchSecretArgs('sh-cred-abc', 'sh-credentials');
    expect(args).toEqual([
      'patch',
      'secret',
      'sh-cred-abc',
      '-n',
      'sh-credentials',
      '--type=merge',
      '--patch-file=/dev/stdin',
    ]);
    // argv is readable via /proc/<pid>/cmdline by anything sharing the pod, so a `-p <json>`
    // carrying a user's provider key would be exposed to every process in the container.
    expect(args.join(' ')).not.toContain('-p ');
  });

  it('reads a Secret by exact name and tolerates absence', () => {
    expect(buildGetSecretArgs('sh-cred-abc', 'sh-credentials')).toEqual([
      'get',
      'secret',
      'sh-cred-abc',
      '-n',
      'sh-credentials',
      '-o',
      'json',
      '--ignore-not-found',
    ]);
  });

  it('deletes idempotently', () => {
    expect(buildDeleteSecretArgs('sh-cred-abc', 'sh-credentials')).toContain('--ignore-not-found');
  });

  it('never builds a Secret list', () => {
    // Spec §6.5: the runtime Role grants get/create/update/patch/delete and OMITS `list`, so a bug
    // or an injection cannot enumerate users' credential objects. That RBAC is only usable if no
    // code path needs list -- pinned here rather than discovered as a 403 in production.
    const secretCalls = [
      buildCreateSecretArgs('n', 'ns'),
      buildPatchSecretArgs('n', 'ns'),
      buildGetSecretArgs('n', 'ns'),
      buildDeleteSecretArgs('n', 'ns'),
    ];
    for (const args of secretCalls) {
      expect(args, args.join(' ')).toContain('n'); // the object is always named
      expect(
        args.some((a) => a === '-l' || a.startsWith('--selector')),
        args.join(' '),
      ).toBe(false);
      expect(args[1]).toMatch(/^secret$/); // never the plural collection form
    }
  });
});

describe('pod argv builders', () => {
  it('reads one pod phase, tolerating a deleted pod', () => {
    expect(buildGetPodPhaseArgs('sandbox-0-0', 'default')).toEqual([
      'get',
      'pod',
      'sandbox-0-0',
      '-n',
      'default',
      '-o',
      'jsonpath={.status.phase}',
      '--ignore-not-found',
    ]);
  });

  it('finds the first Running pod for a selector and returns name + phase', () => {
    const args = buildFindPodBySelectorArgs('sh.kagenti.io/sandbox-pool=default', 'default');
    expect(args.slice(0, 6)).toEqual([
      'get',
      'pods',
      '-n',
      'default',
      '-l',
      'sh.kagenti.io/sandbox-pool=default',
    ]);
    expect(args).toContain('--field-selector=status.phase=Running');
    expect(args.join(' ')).toContain('{.items[0].metadata.name}');
  });
});

describe('isAlreadyExists', () => {
  it('recognises the create-race error so put() can be idempotent', () => {
    expect(
      isAlreadyExists(
        new Error('Error from server (AlreadyExists): secrets "sh-cred-x" already exists'),
      ),
    ).toBe(true);
    expect(isAlreadyExists(new Error('Error from server (Forbidden): cannot create secrets'))).toBe(
      false,
    );
    expect(isAlreadyExists('not an error')).toBe(false);
    expect(isAlreadyExists(undefined)).toBe(false);
  });
});

describe('defaultRunKubectl', () => {
  // A stand-in `kubectl` on PATH that does what the real binary does with `--patch-file=<path>`:
  // opens that path BY NAME and prints its content. This is the exact operation that fails when
  // fed `/dev/stdin` as spawned from a Node child: libuv backs `stdio: 'pipe'` with a UNIX-domain
  // socket (verified with `stat -L /proc/self/fd/0` inside the deployed container: `socket:[...]`),
  // and the kernel refuses to re-open a socket by its /proc/<pid>/fd path (ENXIO) -- so a program
  // that reads fd 0 directly (`cat`, no args) never notices, but one that reopens it by NAME does.
  let binDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), 'fake-kubectl-'));
    const script = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const patchArg = process.argv.slice(2).find((a) => a.startsWith('--patch-file='));",
      "if (!patchArg) { console.error('no --patch-file'); process.exit(1); }",
      'try {',
      "  process.stdout.write(fs.readFileSync(patchArg.slice('--patch-file='.length), 'utf8'));",
      '} catch (err) {',
      "  console.error('OPEN_FAILED: ' + err.message);",
      '  process.exit(1);',
      '}',
      '',
    ].join('\n');
    const kubectlPath = join(binDir, 'kubectl');
    writeFileSync(kubectlPath, script);
    chmodSync(kubectlPath, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(binDir, { recursive: true, force: true });
  });

  it('delivers patch content to a child that reopens --patch-file by path', async () => {
    const out = await defaultRunKubectl(
      buildPatchSecretArgs('sh-cred-abc', 'sh-credentials'),
      '{"hello":"world"}',
    );
    expect(out).toBe('{"hello":"world"}');
  });

  it('never hands the child the literal /dev/stdin path', async () => {
    // Regression guard independent of the kernel quirk above: whatever path reaches the child
    // must be a real, openable file -- not the magic symlink that triggered it. Overwrites the
    // fake `kubectl` from beforeEach with one that reports its own argv instead of reading a file.
    writeFileSync(
      join(binDir, 'kubectl'),
      [
        '#!/usr/bin/env node',
        'process.stdout.write(JSON.stringify(process.argv.slice(2)));',
        '',
      ].join('\n'),
    );
    chmodSync(join(binDir, 'kubectl'), 0o755);

    const out = await defaultRunKubectl(
      buildPatchSecretArgs('sh-cred-abc', 'sh-credentials'),
      '{}',
    );
    const receivedArgs: string[] = JSON.parse(out);
    expect(receivedArgs.join(' ')).not.toContain('/dev/stdin');
  });

  it('writes the plaintext patch file 0600 even under a wide-open umask', async () => {
    // The review's scenario: a permissive umask. It can only clear bits, so 0600 stays 0600.
    writeFileSync(
      join(binDir, 'kubectl'),
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const p = process.argv.slice(2).find((a) => a.startsWith('--patch-file=')).slice(13);",
        'process.stdout.write((fs.statSync(p).mode & 0o777).toString(8));',
        '',
      ].join('\n'),
    );
    chmodSync(join(binDir, 'kubectl'), 0o755);
    const previous = process.umask(0o000);
    try {
      const mode = await defaultRunKubectl(buildPatchSecretArgs('s', 'n'), '{"stringData":{}}');
      expect(mode).toBe('600');
    } finally {
      process.umask(previous);
    }
  });

  it('refuses a file already at the temp path instead of writing through it', async () => {
    // Pin the "random" name so the collision is certain, and plant a file there first.
    vi.mocked(crypto.randomBytes).mockReturnValueOnce(Buffer.alloc(16) as never);
    const planted = join(tmpdir(), `sh-cp-patch-${'00'.repeat(16)}.json`);
    writeFileSync(planted, 'planted', { mode: 0o644 });
    try {
      await expect(
        defaultRunKubectl(buildPatchSecretArgs('s', 'n'), '{"stringData":{"k":"secret"}}'),
      ).rejects.toThrow(/EEXIST/);
      expect(readFileSync(planted, 'utf8')).toBe('planted');
    } finally {
      rmSync(planted, { force: true });
    }
    expect(existsSync(planted)).toBe(false);
  });
});
