import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/queue.js';

// work-queue keeps an inline copy of @moca/session-backend's redactUrl (no package dependency).
// This runs it against session-backend's own cases, so a change to either copy that the other does
// not match fails here rather than drifting silently.
const CASES = JSON.parse(
  readFileSync(
    new URL('../../session-backend/test/fixtures/redact-url-cases.json', import.meta.url),
    'utf8',
  ),
) as { why: string; in: string; out: string }[];

describe('work-queue redactUrl matches the canonical session-backend cases', () => {
  it('has cases to run (a guard against an empty or unread fixture)', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(6);
  });
  for (const c of CASES) {
    it(c.why, () => {
      expect(redactUrl(c.in)).toBe(c.out);
    });
  }
});
