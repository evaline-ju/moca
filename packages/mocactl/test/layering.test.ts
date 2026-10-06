import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = new URL('../src/', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function filesUnder(dir: string): string[] {
  if (!existsSync(join(src, dir))) return [];
  return readdirSync(join(src, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? filesUnder(join(dir, d.name)) : [join(dir, d.name)],
  );
}

describe('layering (spec §3.1)', () => {
  it.each(['api', 'core'])('%s/ never imports the UI', (dir) => {
    for (const file of filesUnder(dir)) {
      const text = readFileSync(join(src, file), 'utf8');
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const i of imports) {
        expect(i, `${file} imports ${i}`).not.toMatch(
          /^(ink|react)(\/|$)|\/(views|render|theme|commands)\//,
        );
      }
    }
  });

  // ADR-0038: exactly one exception to ADR-0036's rule. A second one must fail here.
  const ALLOWED_WORKSPACE_DEPS = new Set(['@moca/config-bundle']);

  it('declares no workspace dependency beyond the ADR-0038 allow-list', () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, range] of Object.entries(all)) {
      if (ALLOWED_WORKSPACE_DEPS.has(name)) continue;
      expect(String(range), name).not.toMatch(/^workspace:/);
      expect(name).not.toMatch(/^@moca\//);
    }
  });
});
