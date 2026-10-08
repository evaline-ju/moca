import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describePromotion,
  PromoteError,
  promoteDirectory,
  resolveConfigRoot,
} from '../src/core/promote.js';
import { fakeControlPlane } from './helpers/fakes.js';

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'mocactl-promote-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
const skill = (name: string) => `---\nname: ${name}\ndescription: d\n---\nbody\n`;

describe('resolveConfigRoot', () => {
  it('uses <dir>/.claude for a project root', () => {
    const p = project({ '.claude/skills/a/SKILL.md': skill('a') });
    expect(resolveConfigRoot(p, '/home/u', '/')).toBe(join(p, '.claude'));
  });

  it('uses <dir> itself when it IS a .claude directory', () => {
    const p = project({ 'skills/a/SKILL.md': skill('a') });
    expect(resolveConfigRoot(p, '/home/u', '/')).toBe(p);
  });

  it('expands ~ and resolves relative paths', () => {
    const home = project({ 'work/.claude/commands/go.md': 'go' });
    expect(resolveConfigRoot('~/work', home, '/')).toBe(join(home, 'work/.claude'));
    expect(resolveConfigRoot('work', '/nowhere', home)).toBe(join(home, 'work/.claude'));
  });

  it('refuses a directory with neither layout', () => {
    const p = project({ 'README.md': 'x' });
    expect(() => resolveConfigRoot(p, '/home/u', '/')).toThrow(
      /no \.claude\/skills or \.claude\/commands/,
    );
  });
});

describe('promoteDirectory', () => {
  it('builds for an attended session, so a dialogue skill draws no --mode warning', async () => {
    const p = project({ '.claude/skills/brainstorming/SKILL.md': skill('brainstorming') });
    const cp = fakeControlPlane({
      putConfigBundle: async (req) => ({ digest: req.digest, uploaded: true }),
    });
    const r = await promoteDirectory(p, cp);
    expect(r.skills).toEqual(['brainstorming']);
    expect(r.report).not.toContain('--mode attended');
  });

  it('builds without an entry, uploads, and reports what travelled', async () => {
    const p = project({
      '.claude/skills/hello/SKILL.md': skill('hello'),
      '.claude/commands/go.md': 'go',
    });
    const uploads: Array<{ digest: string; tar: string }> = [];
    const cp = fakeControlPlane({
      putConfigBundle: async (req) => (uploads.push(req), { digest: req.digest, uploaded: true }),
    });
    const r = await promoteDirectory(p, cp);
    expect(r.skills).toEqual(['hello']);
    expect(r.prompts).toEqual(['go']);
    expect(r.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.digest).toBe(r.digest);
    expect(Buffer.from(uploads[0]!.tar, 'base64').length).toBeGreaterThan(0);
  });

  it('hands the built summary to onBuilt before uploading, with the warning count', async () => {
    const outside = project({ 'secret.md': 'x' });
    const p = project({ '.claude/skills/hello/SKILL.md': skill('hello') });
    symlinkSync(join(outside, 'secret.md'), join(p, '.claude/skills/hello/leak.md'));
    const order: string[] = [];
    const cp = fakeControlPlane({
      putConfigBundle: async (req) => (
        order.push('upload'),
        { digest: req.digest, uploaded: true }
      ),
    });
    const r = await promoteDirectory(
      p,
      cp,
      {},
      {
        onBuilt: (s) => {
          order.push('built');
          expect(s).toMatchObject({ skills: ['hello'], prompts: [], warnings: 1 });
          expect(s.report).toContain('skill_symlink_escaped');
        },
      },
    );
    expect(order).toEqual(['built', 'upload']);
    expect(r).toMatchObject({ uploaded: true, warnings: 1 });
  });

  it('builds and reports without uploading on dryRun, needing no control plane', async () => {
    const p = project({ '.claude/commands/go.md': 'go' });
    const built: unknown[] = [];
    const r = await promoteDirectory(
      p,
      undefined,
      {},
      {
        dryRun: true,
        onBuilt: (s) => void built.push(s),
      },
    );
    expect(r).toMatchObject({ uploaded: false, dryRun: true, prompts: ['go'], skills: [] });
    expect(r.digest).toMatch(/^sha256:/);
    expect(built).toHaveLength(1);
  });

  it('refuses an empty bundle without uploading', async () => {
    const p = project({ '.claude/skills/.keep': '' });
    const cp = fakeControlPlane();
    await expect(promoteDirectory(p, cp)).rejects.toThrow(/nothing to promote/);
    expect(cp.calls).not.toContain('putConfigBundle');
  });

  it('blocks a structural credential with exit code 3 and uploads nothing', async () => {
    const p = project({
      '.claude/skills/leaky/SKILL.md': skill('leaky') + 'AKIA' + 'ABCDEFGHIJKLMNOP\n', // notsecret
    });
    const cp = fakeControlPlane();
    await expect(promoteDirectory(p, cp)).rejects.toMatchObject({ exitCode: 3 });
    expect(cp.calls).not.toContain('putConfigBundle');
  });

  it('is a PromoteError with exit code 1 for a bad directory', async () => {
    await expect(
      promoteDirectory('/definitely/not/here', fakeControlPlane()),
    ).rejects.toBeInstanceOf(PromoteError);
  });
});

describe('describePromotion', () => {
  const r = (skills: number, prompts: number, warnings: number, uploaded = true) => ({
    skills: Array.from({ length: skills }, (_, i) => `s${i}`),
    prompts: Array.from({ length: prompts }, (_, i) => `p${i}`),
    warnings,
    uploaded,
  });

  it('counts in the singular and plural and names the directory in the --dry-run hint', () => {
    expect(describePromotion(r(1, 1, 1), '~/work')).toBe(
      'promoted 1 skill, 1 command — uploaded; 1 warning — run `mocactl promote ~/work --dry-run` to see it',
    );
    expect(describePromotion(r(0, 2, 3, false), 'x')).toBe(
      'promoted 0 skills, 2 commands — unchanged; 3 warnings — run `mocactl promote x --dry-run` to see them',
    );
    expect(describePromotion(r(2, 0, 0), 'x')).toBe('promoted 2 skills, 0 commands — uploaded');
  });
});
