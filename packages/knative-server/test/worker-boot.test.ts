import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('../src/worker.ts', import.meta.url)), 'utf8');
const serverSrc = readFileSync(fileURLToPath(new URL('../src/server.ts', import.meta.url)), 'utf8');
const leafJobPath = fileURLToPath(new URL('../src/leaf-job.ts', import.meta.url));
const leafJobSrc = readFileSync(leafJobPath, 'utf8');
const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));

describe('every server entry point runs the same boot function (MI1 R2)', () => {
  it('the P6 worker calls prepareServerProcess at boot', () => {
    expect(src).toMatch(/prepareServerProcess\(process\.env\)/);
  });
  it('startServer calls prepareServerProcess', () => {
    expect(serverSrc).toMatch(/prepareServerProcess\(process\.env\)/);
  });
  it('the async-run job calls prepareServerProcess before it touches the queue', () => {
    const boot = leafJobSrc.indexOf('prepareServerProcess(process.env)');
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(leafJobSrc.indexOf('new RedisWorkQueue('));
  });
  it('no entry point calls assertKeysetUsable directly any more', () => {
    expect(src).not.toMatch(/^\s*assertKeysetUsable\(/m);
    expect(serverSrc).not.toMatch(/^\s*assertKeysetUsable\(/m);
    expect(leafJobSrc).not.toMatch(/^\s*assertKeysetUsable\(/m);
  });
});

describe('the async-run job builds its turn config the way the server does (MI1 R3/R4)', () => {
  it('uses the shared buildConfig instead of a field list of its own', () => {
    expect(leafJobSrc).not.toMatch(/function buildConfig\s*\(/);
    expect(leafJobSrc).toMatch(/import \{[^}]*\bbuildConfig\b[^}]*\} from '\.\/server\.js'/);
  });

  it('refuses to boot under MOCA_TENANCY=multi without SH_REQUIRE_AUTH, before it dials Redis', () => {
    const r = spawnSync(TSX, [leafJobPath], {
      cwd: PKG_DIR,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MOCA_TENANCY: 'multi',
        // Nothing listens here: reaching the queue would be a connection error, not this refusal.
        REDIS_URL: 'redis://127.0.0.1:1',
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/MOCA_TENANCY=multi requires SH_REQUIRE_AUTH=true/);
  }, 30_000);
});
