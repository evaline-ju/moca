import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSkills, readSkillFrontmatterName } from '../src/resolve.js';

let root: string;

function skill(dir: string, name: string, extra: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: does ${name}\n---\n\nbody of ${name}\n`,
  );
  for (const [rel, body] of Object.entries(extra)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cb-resolve-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readSkillFrontmatterName', () => {
  it('reads the frontmatter name', () => {
    expect(readSkillFrontmatterName('---\nname: foo\n---\nbody')).toBe('foo');
  });
  it('returns null when there is no frontmatter', () => {
    expect(readSkillFrontmatterName('# just a heading')).toBeNull();
  });
  it('strips surrounding double quotes', () => {
    expect(readSkillFrontmatterName('---\nname: "foo"\n---\nbody')).toBe('foo');
  });
  it('strips surrounding single quotes', () => {
    expect(readSkillFrontmatterName("---\nname: 'foo'\n---\nbody")).toBe('foo');
  });
  it('leaves unquoted names untouched', () => {
    expect(readSkillFrontmatterName('---\nname: foo\n---\nbody')).toBe('foo');
  });
});

describe('resolveSkills', () => {
  it('finds a skill by its SKILL.md and records its sibling files', () => {
    skill(join(root, 'user', 'skills', 'alpha'), 'alpha', {
      'references/guide.md': 'g',
      'run.sh': '#!/bin/sh\n',
    });
    const found = resolveSkills({ userDir: join(root, 'user') });
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('alpha');
    expect(found[0]!.scope).toBe('user');
    expect(found[0]!.files.sort()).toEqual(['SKILL.md', 'references/guide.md', 'run.sh']);
  });

  it('dedupes the same skill appearing in plugins/cache and plugins/marketplaces', () => {
    skill(join(root, 'plugins', 'marketplaces', 'mp', 'skills', 'dup'), 'dup');
    skill(join(root, 'plugins', 'cache', 'mp', 'skills', 'dup'), 'dup');
    const found = resolveSkills({ pluginDirs: [join(root, 'plugins')] });
    expect(found.map((s) => s.name)).toEqual(['dup']);
  });

  it('prefers project scope over user scope for the same name', () => {
    skill(join(root, 'user', 'skills', 'both'), 'both');
    skill(join(root, 'proj', 'skills', 'both'), 'both');
    const found = resolveSkills({
      projectDir: join(root, 'proj'),
      userDir: join(root, 'user'),
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.scope).toBe('project');
  });

  it('does not recurse below a directory that already holds a SKILL.md', () => {
    skill(join(root, 'user', 'skills', 'outer'), 'outer');
    skill(join(root, 'user', 'skills', 'outer', 'nested'), 'nested');
    const found = resolveSkills({ userDir: join(root, 'user') });
    expect(found.map((s) => s.name)).toEqual(['outer']);
    // the nested SKILL.md is carried as a plain file of `outer`, not as its own skill
    expect(found[0]!.files).toContain('nested/SKILL.md');
  });

  it('falls back to the directory name when frontmatter has no name', () => {
    const dir = join(root, 'user', 'skills', 'unnamed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'no frontmatter here');
    expect(resolveSkills({ userDir: join(root, 'user') })[0]!.name).toBe('unnamed');
  });

  it('returns an empty list for roots that do not exist', () => {
    expect(resolveSkills({ userDir: join(root, 'nope') })).toEqual([]);
  });

  it('skips dangling symlinks without throwing', () => {
    skill(join(root, 'user', 'skills', 'real'), 'real');
    // Create a dangling symlink inside the skill directory
    const skillDir = join(root, 'user', 'skills', 'real');
    symlinkSync(join(root, 'nonexistent'), join(skillDir, 'dangling'));
    const found = resolveSkills({ userDir: join(root, 'user') });
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('real');
    // dangling symlink should not appear in files
    expect(found[0]!.files).not.toContain('dangling');
  });

  it('does not hang on symlink cycles', () => {
    skill(join(root, 'user', 'skills', 'real'), 'real');
    const skillDir = join(root, 'user', 'skills', 'real');
    const subdir = join(skillDir, 'subdir');
    mkdirSync(subdir);
    // Create a symlink cycle: subdir -> skill dir (ancestor)
    symlinkSync(skillDir, join(subdir, 'cycle'));
    const found = resolveSkills({ userDir: join(root, 'user') });
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('real');
  });

  it('<userDir>/skills that is a symlink to a real directory is discovered', () => {
    const realSkillsDir = join(root, 'real-skills');
    skill(join(realSkillsDir, 'linked'), 'linked');
    const userSkillsLink = join(root, 'user', 'skills');
    mkdirSync(join(root, 'user'));
    symlinkSync(realSkillsDir, userSkillsLink);
    const found = resolveSkills({ userDir: join(root, 'user') });
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('linked');
  });

  it('a pluginDirs entry that is itself a symlink is discovered', () => {
    const realPluginDir = join(root, 'real-plugins');
    skill(join(realPluginDir, 'mp', 'skills', 'plugin-skill'), 'plugin-skill');
    const pluginLink = join(root, 'plugins-link');
    symlinkSync(realPluginDir, pluginLink);
    const found = resolveSkills({ pluginDirs: [pluginLink] });
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('plugin-skill');
  });

  it('an individual skill directory that is a symlink is discovered', () => {
    const realSkill = join(root, 'real-skill');
    skill(realSkill, 'symlinked-skill');
    const skillsDir = join(root, 'user', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(realSkill, join(skillsDir, 'linked'));
    const found = resolveSkills({ userDir: join(root, 'user') });
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('symlinked-skill');
  });

  it('dedupes skills that canonicalize to the same real path', () => {
    const realSkill = join(root, 'the-real-skill');
    skill(realSkill, 'canonical');
    const skillsDir = join(root, 'user', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    // Create two entries: one direct, one via symlink alias
    symlinkSync(realSkill, join(skillsDir, 'direct-link'));
    symlinkSync(realSkill, join(skillsDir, 'alias-link'));
    const found = resolveSkills({ userDir: join(root, 'user') });
    // Should dedupe to one skill (the same canonical path)
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('canonical');
  });

  it('a symlink escaping the skill directory is skipped and raises a warn finding', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    const skillDir = join(root, 'user', 'skills', 'escapee');
    skill(skillDir, 'escapee');
    symlinkSync(outside, join(skillDir, 'escape'));

    const found = resolveSkills({ userDir: join(root, 'user') });
    expect(found).toHaveLength(1);
    // the escaping symlink's content must not ride along into the bundle
    expect(found[0]!.files).not.toContain('escape/secret.txt');
    expect(found[0]!.files.some((f) => f.startsWith('escape/'))).toBe(false);

    const findings = found[0]!.findings ?? [];
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warn');
    expect(findings[0]!.code).toBe('skill_symlink_escaped');
    expect(findings[0]!.message).toContain('escape');
  });

  it('a FILE symlink escaping the skill directory is skipped and raises a warn finding', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'credentials'), 'aws_secret');
    const skillDir = join(root, 'user', 'skills', 'leaky');
    skill(skillDir, 'leaky');
    symlinkSync(join(outside, 'credentials'), join(skillDir, 'creds'));

    const found = resolveSkills({ userDir: join(root, 'user') });
    expect(found[0]!.files).not.toContain('creds');
    expect(found[0]!.findings).toEqual([
      expect.objectContaining({ severity: 'warn', code: 'skill_symlink_escaped' }),
    ]);
    expect(found[0]!.findings![0]!.message).toContain("'creds'");
  });

  it('a FILE symlink pointing within the skill directory is kept, with no finding', () => {
    const skillDir = join(root, 'user', 'skills', 'filealias');
    skill(skillDir, 'filealias');
    writeFileSync(join(skillDir, 'real.md'), 'real');
    symlinkSync(join(skillDir, 'real.md'), join(skillDir, 'alias.md'));
    const found = resolveSkills({ userDir: join(root, 'user') });
    expect(found[0]!.files).toContain('alias.md');
    expect(found[0]!.findings ?? []).toEqual([]);
  });

  it('a symlink pointing within the skill directory is still followed, and raises no finding', () => {
    const skillDir = join(root, 'user', 'skills', 'aliased');
    skill(skillDir, 'aliased');
    mkdirSync(join(skillDir, 'real'));
    writeFileSync(join(skillDir, 'real', 'inner.md'), 'inner');
    // alias -> real, both inside the skill directory
    symlinkSync(join(skillDir, 'real'), join(skillDir, 'alias'));

    const found = resolveSkills({ userDir: join(root, 'user') });
    expect(found).toHaveLength(1);
    expect(found[0]!.files).toContain('alias/inner.md');
    expect(found[0]!.findings ?? []).toEqual([]);
  });

  it('a symlink to a same-prefix sibling ("skillsX" vs "skills") is treated as escaped, not inside', () => {
    // The containment check must be path-segment-aware (relative(), not a bare startsWith):
    // '<skillDir>X' is a STRING prefix match of '<skillDir>' but is not actually inside it.
    const skillDir = join(root, 'user', 'skills', 'trap');
    skill(skillDir, 'trap');
    const sibling = join(root, 'user', 'skills', 'trapX');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'leak.txt'), 'leak');
    symlinkSync(sibling, join(skillDir, 'link'));

    const found = resolveSkills({ userDir: join(root, 'user') });
    expect(found).toHaveLength(1);
    expect(found[0]!.files.some((f) => f.startsWith('link/'))).toBe(false);
    const findings = found[0]!.findings ?? [];
    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe('skill_symlink_escaped');
  });

  it('dedupes an aliased directory across two scopes even when the fallback names differ', () => {
    // NOTE ON COVERAGE: this exercises the overall dedupe-by-canonical-path guarantee (exactly
    // one entry survives, under the winning scope's name), which the maintainer's fix targets.
    // It does NOT, however, fail if `best.delete(prevCanonical.name)` in resolve.ts's dedupe loop
    // is reverted: resolveSkills() always processes roots in strict project -> user -> plugin
    // (precedence-ascending) order, so a later-processed entry can never have STRICTLY better
    // precedence than an earlier-recorded one for the same canonical path -- the `if` branch that
    // guards the delete is therefore unreachable via this (or any) two-scope alias through the
    // public API today, and removing the delete line was verified (by hand, outside this suite)
    // to produce byte-identical output for this exact scenario. Kept as defense-in-depth per the
    // review comment; documented here rather than claimed as a regression test for that line.
    const realSkill = join(root, 'real-skill');
    mkdirSync(realSkill, { recursive: true });
    writeFileSync(join(realSkill, 'SKILL.md'), 'no frontmatter name here');

    const projSkills = join(root, 'proj', 'skills');
    const userSkills = join(root, 'user', 'skills');
    mkdirSync(projSkills, { recursive: true });
    mkdirSync(userSkills, { recursive: true });
    symlinkSync(realSkill, join(projSkills, 'project-alias'));
    symlinkSync(realSkill, join(userSkills, 'user-alias'));

    const found = resolveSkills({
      projectDir: join(root, 'proj'),
      userDir: join(root, 'user'),
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('project-alias');
    expect(found[0]!.scope).toBe('project');
  });
});
