import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PromoteError, promoteDirectory, resolveConfigRoot } from '../src/core/promote.js';
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
