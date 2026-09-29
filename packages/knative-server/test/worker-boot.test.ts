import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('../src/worker.ts', import.meta.url)), 'utf8');
const serverSrc = readFileSync(fileURLToPath(new URL('../src/server.ts', import.meta.url)), 'utf8');
const workerPath = fileURLToPath(new URL('../src/worker.ts', import.meta.url));
const leafJobPath = fileURLToPath(new URL('../src/leaf-job.ts', import.meta.url));
const leafJobSrc = readFileSync(leafJobPath, 'utf8');
const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));

// Anchored to start-of-line: worker.ts also names this call inside a `//` comment, which an
// unanchored match would accept with the real call deleted (PR #350 review).
const BOOT_CALL = /^\s*prepareServerProcess\(process\.env\);/m;

describe('every server entry point runs the same boot function (MI1 R2)', () => {
  it('the P6 worker calls prepareServerProcess at boot', () => {
    expect(src).toMatch(BOOT_CALL);
  });
  it('startServer calls prepareServerProcess', () => {
    expect(serverSrc).toMatch(BOOT_CALL);
  });
  it('the P6 worker refuses to boot under MOCA_TENANCY=multi without SH_REQUIRE_AUTH', async () => {
    // The behaviour, not the source text. Forked with an IPC channel, as the supervisor forks it:
    // without one the worker exits on the missing channel before it reaches the boot check.
    const child = spawn(TSX, [workerPath], {
      cwd: PKG_DIR,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, MOCA_TENANCY: 'multi' },
    });
    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    // 'close', not 'exit': only 'close' guarantees the piped stderr has been drained. An 'error'
    // (tsx missing, spawn refused) rejects instead of waiting out the timer.
    const status = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(stderr).toMatch(/MOCA_TENANCY=multi requires SH_REQUIRE_AUTH=true/);
    expect(status).toBe(2);
  }, 30_000);
  it('the async-run job calls prepareServerProcess before it touches the queue', () => {
    // The anchored match, as above: a comment naming the call must not satisfy the ordering either.
    const boot = BOOT_CALL.exec(leafJobSrc)?.index ?? -1;
    const queue = leafJobSrc.indexOf('new RedisWorkQueue(');
    expect(boot).toBeGreaterThan(-1);
    expect(queue).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(queue);
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
