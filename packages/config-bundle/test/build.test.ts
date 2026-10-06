import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildBundle, contentDigest, LOCKFILE_PATH } from '../src/build.js';
import { untar } from '../src/tar.js';
import { SecretScanError } from '../src/secret-scan.js';

let root: string;

function write(rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
}

function baseInput() {
  return {
    roots: { userDir: join(root, 'user') },
    memoryDir: join(root, 'memory'),
    promptsDir: join(root, 'prompts'),
    contextFiles: [{ path: '/proj/CLAUDE.md', content: '# project rules' }],
    entry: 'go',
    mode: 'unattended' as const,
    sandboxImage: 'sandbox:pool-default',
    inventory: ['gh'],
    versions: { pi: '0.42.0', harness: '0.0.0' },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cb-build-'));
  // Fenced block, NOT an inline `gh` span: detectBinaries scans only ```bash/sh/shell fences.
  write(
    'user/skills/keeper/SKILL.md',
    '---\nname: keeper\ndescription: d\n---\n```bash\ngh pr list\n```\n',
  );
  write(
    'user/skills/artifact-design/SKILL.md',
    '---\nname: artifact-design\ndescription: d\n---\nx',
  );
  write('memory/MEMORY.md', '- [A](alpha.md) — hook');
  write('memory/alpha.md', '---\nname: alpha\n---\nfact');
  write('prompts/go.md', 'do the thing');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('buildBundle', () => {
  it('packs traveling skills under skills/<name>/ and drops deny-listed ones', () => {
    const r = buildBundle(baseInput());
    const paths = untar(r.tar).map((e) => e.path);
    expect(paths).toContain('skills/keeper/SKILL.md');
    expect(paths.some((p) => p.startsWith('skills/artifact-design/'))).toBe(false);
    expect(r.lockfile.dropped.map((d) => d.name)).toEqual(['artifact-design']);
  });

  it('puts inline context under context/ and sandbox-read memory under memory/', () => {
    const paths = untar(buildBundle(baseInput()).tar).map((e) => e.path);
    expect(paths).toContain('context/agents/0-CLAUDE.md');
    expect(paths).toContain('context/MEMORY.md');
    expect(paths).toContain('memory/alpha.md');
    // MEMORY.md is injected inline, so it must NOT also be under memory/
    expect(paths).not.toContain('memory/MEMORY.md');
  });

  it('includes the two injected prompt notes and the entry prompt', () => {
    const r = buildBundle(baseInput());
    const paths = untar(r.tar).map((e) => e.path);
    expect(paths.filter((p) => p.startsWith('prompt/'))).toHaveLength(2);
    expect(paths).toContain('prompts/go.md');
    expect(r.promptNames).toEqual(['go']);
  });

  it('embeds the lockfile and stamps it with the content digest', () => {
    const r = buildBundle(baseInput());
    const entry = untar(r.tar).find((e) => e.path === LOCKFILE_PATH)!;
    expect(JSON.parse(entry.content.toString()).digest).toBe(r.digest);
  });

  it('defines the digest over content only, so it cannot depend on itself', () => {
    const r = buildBundle(baseInput());
    const withoutLock = untar(r.tar).filter((e) => e.path !== LOCKFILE_PATH);
    expect(contentDigest(withoutLock)).toBe(r.digest);
  });

  it('is deterministic: two builds of the same tree give the same digest', () => {
    expect(buildBundle(baseInput()).digest).toBe(buildBundle(baseInput()).digest);
  });

  it('changes the digest when a skill body changes', () => {
    const before = buildBundle(baseInput()).digest;
    write('user/skills/keeper/SKILL.md', '---\nname: keeper\ndescription: d\n---\nchanged');
    expect(buildBundle(baseInput()).digest).not.toBe(before);
  });

  it('surfaces a missing binary as a preflight WARNING, not a blocking error', () => {
    // Demoted from error after measurement: on a real ~/.claude the detector produced 44 binaries
    // and 32 "missing", half of them not binaries at all (angular, django, `your_command`). At error
    // severity that refused every real promotion.
    const r = buildBundle({ ...baseInput(), inventory: [] });
    const missing = r.findings.filter((f) => f.code === 'missing_binary');
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((f) => f.severity === 'warn')).toBe(true);
    expect(r.findings.some((f) => f.severity === 'error')).toBe(false);
  });

  it('throws SecretScanError and packs nothing when a BLOCKING credential is present', () => {
    write('memory/leak.md', 'token: AKIAIOSFODNN7EXAMPLE');
    expect(() => buildBundle(baseInput())).toThrow(SecretScanError);
  });

  it('does NOT throw on a heuristic-only hit, and surfaces it as a warning finding', () => {
    write('memory/looks-like.md', 'apiKey = process.env.ANTHROPIC_KEY');
    const r = buildBundle(baseInput());
    const warn = r.findings.filter((f) => f.code === 'possible_secret');
    expect(warn.length).toBeGreaterThan(0);
    expect(warn.every((f) => f.severity === 'warn')).toBe(true);
  });

  it('records the entry, mode, image and detected binaries in the lockfile', () => {
    const l = buildBundle(baseInput()).lockfile;
    expect(l.entry).toBe('go');
    expect(l.mode).toBe('unattended');
    expect(l.sandboxImage).toBe('sandbox:pool-default');
    expect(l.binaries).toContain('gh');
  });

  it("warns and excludes a namespaced prompt subdirectory (Claude Code's /<ns>:<cmd>)", () => {
    write('prompts/ns/cmd.md', 'namespaced command body');
    const r = buildBundle(baseInput());
    const paths = untar(r.tar).map((e) => e.path);
    // not recursed into: neither the file nor its containing "directory" travels
    expect(paths.some((p) => p.startsWith('prompts/ns'))).toBe(false);
    // the flat prompts/go.md fixture from beforeEach still travels normally
    expect(paths).toContain('prompts/go.md');
    const warn = r.findings.filter((f) => f.code === 'namespaced_prompt_skipped');
    expect(warn).toHaveLength(1);
    expect(warn[0]!.severity).toBe('warn');
    expect(warn[0]!.message).toContain('ns');
  });

  it('raises no namespaced_prompt_skipped finding for a flat promptsDir', () => {
    // beforeEach's fixture is already flat (prompts/go.md only); this asserts explicitly rather
    // than relying on that being incidental to the other passing tests.
    const r = buildBundle(baseInput());
    expect(r.findings.some((f) => f.code === 'namespaced_prompt_skipped')).toBe(false);
  });
});

describe('buildBundle --exclude-prompt', () => {
  // Local to this suite: adding these to the shared fixture would change promptNames for every
  // other test, which is collateral damage rather than coverage.
  beforeEach(() => {
    write('prompts/promote.md', 'promote this project');
    write('prompts/helper.md', 'a second prompt');
  });

  it('omits an excluded prompt from the bundle while keeping the others', () => {
    const paths = untar(buildBundle({ ...baseInput(), excludePrompts: ['promote'] }).tar).map(
      (e) => e.path,
    );
    expect(paths).not.toContain('prompts/promote.md');
    expect(paths).toContain('prompts/go.md');
    expect(paths).toContain('prompts/helper.md');
  });

  it('records each exclusion as a warning, so a silent omission is impossible', () => {
    const r = buildBundle({ ...baseInput(), excludePrompts: ['promote'] });
    const f = r.findings.find((x) => x.code === 'prompt_excluded');
    expect(f?.severity).toBe('warn');
    expect(f?.message).toContain('promote');
  });

  it('warns when an exclusion matches nothing, which is how a typo surfaces', () => {
    const r = buildBundle({ ...baseInput(), excludePrompts: ['promotte'] });
    const f = r.findings.find((x) => x.code === 'prompt_exclude_unmatched');
    expect(f?.severity).toBe('warn');
    expect(f?.message).toContain('promotte');
  });

  it('refuses to exclude the entry prompt instead of failing later as unknown_entry', () => {
    const r = buildBundle({ ...baseInput(), entry: 'go', excludePrompts: ['go'] });
    const f = r.findings.find((x) => x.code === 'entry_excluded');
    expect(f?.severity).toBe('error');
    expect(r.findings.some((x) => x.code === 'unknown_entry')).toBe(false);
  });

  it('changes the digest, because the bundle content changed', () => {
    const withAll = buildBundle(baseInput()).digest;
    const without = buildBundle({ ...baseInput(), excludePrompts: ['promote'] }).digest;
    expect(without).not.toBe(withAll);
  });

  it('is a no-op when no exclusions are given', () => {
    expect(buildBundle({ ...baseInput(), excludePrompts: [] }).digest).toBe(
      buildBundle(baseInput()).digest,
    );
  });
});

describe('buildBundle without an entry (interactive promotion)', () => {
  const noEntry = () => {
    const { entry: _entry, ...rest } = baseInput();
    return rest;
  };

  it('raises no entry finding and records an empty entry in the lockfile', () => {
    const r = buildBundle(noEntry());
    const codes = r.findings.map((f) => f.code);
    expect(codes).not.toContain('unknown_entry');
    expect(codes).not.toContain('entry_excluded');
    expect(r.lockfile.entry).toBe('');
  });

  it('still packs prompts and skills', () => {
    const paths = untar(buildBundle(noEntry()).tar).map((e) => e.path);
    expect(paths).toContain('prompts/go.md');
    expect(paths).toContain('skills/keeper/SKILL.md');
  });

  it('still reports exclusions, which are about prompts, not the entry', () => {
    const r = buildBundle({ ...noEntry(), excludePrompts: ['go', 'typo'] });
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain('prompt_excluded');
    expect(codes).toContain('prompt_exclude_unmatched');
    expect(codes).not.toContain('entry_excluded');
  });

  it('builds with zero prompts at all', () => {
    rmSync(join(root, 'prompts'), { recursive: true, force: true });
    const r = buildBundle(noEntry());
    expect(r.promptNames).toEqual([]);
    expect(r.findings.some((f) => f.severity === 'error')).toBe(false);
  });
});
