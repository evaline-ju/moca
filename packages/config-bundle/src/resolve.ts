import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { PreflightFinding, ResolvedSkill, SkillRoots, SkillScope } from './types.js';

/**
 * Is `pCanonical` inside `rootCanonical` (or equal to it)? Path-segment-aware: `relative()`
 * rather than a bare `startsWith`, so `/a/skillsX` is never mistaken for being inside `/a/skills`.
 */
export function isWithin(rootCanonical: string, pCanonical: string): boolean {
  if (rootCanonical === pCanonical) return true;
  const rel = relative(rootCanonical, pCanonical);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

/** Parse `name:` out of YAML frontmatter. Deliberately minimal — no YAML dependency. Strips a single matched pair of surrounding double or single quotes. */
export function readSkillFrontmatterName(skillMd: string): string | null {
  if (!skillMd.startsWith('---')) return null;
  const end = skillMd.indexOf('\n---', 3);
  if (end === -1) return null;
  const m = /^name:\s*(.+)$/m.exec(skillMd.slice(3, end));
  if (!m) return null;
  let name = m[1]!.trim();
  // Strip a single matched pair of surrounding double or single quotes
  if (
    (name.startsWith('"') && name.endsWith('"')) ||
    (name.startsWith("'") && name.endsWith("'"))
  ) {
    name = name.slice(1, -1);
  }
  return name;
}

/**
 * Every file under `dir`, relative to it, sorted. Symlinks are followed (deliberate: see
 * `8be16bd` -> `3afe725`), but bounded to `dir`'s own canonical root — a directory symlink that
 * resolves OUTSIDE that root (e.g. `refs/linked -> ~/Documents`) is skipped rather than walked,
 * because `statSync` (not `lstatSync`) would otherwise resolve it and let an unrelated tree's
 * content ride along into a bundle destined for shared Redis. The root canonical path is
 * computed once, here, and reused for every entry rather than re-derived per entry. Cycles
 * within the bound are broken by tracking canonical paths.
 */
function filesUnder(dir: string, findings: PreflightFinding[]): string[] {
  let rootCanonical: string;
  try {
    rootCanonical = realpathSync(dir);
  } catch {
    return [];
  }
  const visited = new Set<string>([rootCanonical]);

  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory() || st.isFile()) {
        let pCanonical: string;
        try {
          pCanonical = realpathSync(p);
        } catch {
          continue;
        }
        if (!isWithin(rootCanonical, pCanonical)) {
          findings.push({
            severity: 'warn',
            code: 'skill_symlink_escaped',
            message: `symlink '${relative(dir, p).split(sep).join('/')}' resolves outside its skill directory and was skipped`,
            path: dir,
          });
          continue;
        }
        if (st.isFile()) {
          out.push(relative(dir, p).split(sep).join('/'));
        } else if (!visited.has(pCanonical)) {
          visited.add(pCanonical);
          walk(p);
        }
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Pi's discovery rule (`pi-fork/.../core/skills.ts`): a directory holding SKILL.md IS a skill
 * root and is NOT recursed into; otherwise recurse looking for one. Symlinks are followed;
 * cycles and aliases are broken by canonical path.
 */
function findSkillDirs(root: string, acc: string[] = [], visited = new Set<string>()): string[] {
  let canonical: string;
  try {
    canonical = realpathSync(root);
  } catch {
    return acc;
  }
  if (visited.has(canonical)) return acc;

  let st;
  try {
    st = statSync(root);
  } catch {
    return acc;
  }
  if (!st.isDirectory()) return acc;

  visited.add(canonical);

  if (existsSync(join(root, 'SKILL.md'))) {
    acc.push(root);
    return acc;
  }
  for (const name of readdirSync(root).sort()) {
    const p = join(root, name);
    let pst;
    try {
      pst = statSync(p);
    } catch {
      continue;
    }
    if (pst.isDirectory()) {
      let pCanonical: string;
      try {
        pCanonical = realpathSync(p);
      } catch {
        continue;
      }
      if (!visited.has(pCanonical)) {
        findSkillDirs(p, acc, visited);
      }
    }
  }
  return acc;
}

function load(dir: string, scope: SkillScope): ResolvedSkill {
  const skillMd = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const fallback = dir.split(sep).filter(Boolean).at(-1) ?? 'skill';
  const findings: PreflightFinding[] = [];
  const files = filesUnder(dir, findings);
  return {
    name: readSkillFrontmatterName(skillMd) ?? fallback,
    dir,
    skillMd,
    files,
    scope,
    findings,
  };
}

const SCOPE_RANK: Record<SkillScope, number> = { project: 0, user: 1, plugin: 2 };

/**
 * Resolve every skill across the configured roots, deduped by name and canonical path.
 *
 * Deduping happens at two levels: by name (project > user > plugin precedence within a scope),
 * and by canonical path (symlinked aliases are recognized and collapsed).
 *
 * Dedupe matters concretely: `~/.claude/plugins/cache/` is largely a resolved duplicate of
 * `~/.claude/plugins/marketplaces/`, so a naive scan double-counts every plugin skill (spec §4.3).
 * Additionally, a skill directory can be aliased via symlinks, which we detect and dedupe.
 */
export function resolveSkills(roots: SkillRoots): ResolvedSkill[] {
  const found: ResolvedSkill[] = [];
  const push = (base: string | undefined, scope: SkillScope): void => {
    if (!base) return;
    for (const dir of findSkillDirs(join(base, 'skills'))) found.push(load(dir, scope));
  };
  push(roots.projectDir, 'project');
  push(roots.userDir, 'user');
  for (const pluginDir of roots.pluginDirs ?? []) {
    for (const dir of findSkillDirs(pluginDir)) found.push(load(dir, 'plugin'));
  }

  const best = new Map<string, ResolvedSkill>();
  const byCanonical = new Map<string, ResolvedSkill>();

  for (const skill of found) {
    let canonical: string;
    try {
      canonical = realpathSync(skill.dir);
    } catch {
      canonical = skill.dir;
    }

    const prev = best.get(skill.name);
    const prevCanonical = byCanonical.get(canonical);

    if (prevCanonical) {
      // Same canonical path: prefer higher precedence scope. When the winning name differs from
      // the name this same canonical path was previously filed under (SKILL.md has no `name:`
      // frontmatter, so `load` falls back to the link directory's basename, and that basename
      // differs across the two aliasing scopes), the old name's entry in `best` must be removed
      // too -- otherwise it is never overwritten and the same physical skill is emitted twice,
      // under two separate `skills/<name>/` prefixes.
      if (SCOPE_RANK[skill.scope] < SCOPE_RANK[prevCanonical.scope]) {
        best.delete(prevCanonical.name);
        best.set(skill.name, skill);
        byCanonical.set(canonical, skill);
      }
    } else if (!prev || SCOPE_RANK[skill.scope] < SCOPE_RANK[prev.scope]) {
      // New name or higher precedence scope
      best.set(skill.name, skill);
      byCanonical.set(canonical, skill);
    }
  }
  return [...best.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
