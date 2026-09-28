import { describe, expect, it } from 'vitest';
import { trimTrailingSlashes } from '../src/api/url.js';

describe('trimTrailingSlashes', () => {
  it('drops every trailing slash and nothing else', () => {
    expect(trimTrailingSlashes('http://cp/')).toBe('http://cp');
    expect(trimTrailingSlashes('http://cp///')).toBe('http://cp');
    expect(trimTrailingSlashes('http://cp/a/b')).toBe('http://cp/a/b');
    expect(trimTrailingSlashes('')).toBe('');
    expect(trimTrailingSlashes('///')).toBe('');
  });

  it('is linear on a long run of slashes that is not at the end', () => {
    // The input that makes /\/+$/ quadratic; a loop answers it in one pass.
    const s = `http://h${'/'.repeat(100_000)}x`;
    expect(trimTrailingSlashes(s)).toBe(s);
  });
});
