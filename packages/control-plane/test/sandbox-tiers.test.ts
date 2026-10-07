import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSandboxTiers } from '../src/sandbox-tiers.js';

// The SAME fixture the harness's parser is pinned to (harness/test/fixtures/sandbox-tiers-cases.json). The two
// packages cannot share code -- the control plane does not depend on the harness -- so they share
// the cases instead: one tier list must mean the same thing to the tier that validates a session and
// the tier that places its turns.
type Case = { name: string; env: Record<string, string>; expect?: unknown; error?: string };
const cases = JSON.parse(
  readFileSync(
    new URL('../../../harness/test/fixtures/sandbox-tiers-cases.json', import.meta.url),
    'utf8',
  ),
) as Case[];

describe('parseSandboxTiers (control plane)', () => {
  for (const c of cases) {
    it(c.name, () => {
      if (c.error) expect(() => parseSandboxTiers(c.env)).toThrow(c.error);
      else expect(parseSandboxTiers(c.env)).toEqual(c.expect);
    });
  }
});
