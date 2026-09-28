import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('../src/worker.ts', import.meta.url)), 'utf8');
const serverSrc = readFileSync(fileURLToPath(new URL('../src/server.ts', import.meta.url)), 'utf8');

describe('both server entry points run the same boot function (MI1 R2)', () => {
  it('the P6 worker calls prepareServerProcess at boot', () => {
    expect(src).toMatch(/prepareServerProcess\(process\.env\)/);
  });
  it('startServer calls prepareServerProcess', () => {
    expect(serverSrc).toMatch(/prepareServerProcess\(process\.env\)/);
  });
  it('neither entry point calls assertKeysetUsable directly any more', () => {
    expect(src).not.toMatch(/^\s*assertKeysetUsable\(/m);
    expect(serverSrc).not.toMatch(/^\s*assertKeysetUsable\(/m);
  });
});
