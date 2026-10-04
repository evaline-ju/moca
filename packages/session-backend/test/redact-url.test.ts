import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/redact-url.js';

// The cases are shared with work-queue's inline copy (packages/work-queue/test/redact-url-parity.test.ts),
// so the two redactors are held to one definition.
const CASES = JSON.parse(
  readFileSync(new URL('./fixtures/redact-url-cases.json', import.meta.url), 'utf8'),
) as { why: string; in: string; out: string }[];

describe('redactUrl', () => {
  it('has cases to run (a guard against an empty or unread fixture)', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(6);
  });
  for (const c of CASES) {
    it(c.why, () => {
      expect(redactUrl(c.in)).toBe(c.out);
    });
  }
});
