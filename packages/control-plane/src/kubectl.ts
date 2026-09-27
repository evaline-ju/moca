import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The Kubernetes API, reached by spawning `kubectl` -- which the runtime image already installs
 * (Dockerfile:42) and which resolves the in-cluster ServiceAccount with no client library and no new
 * runtime dependency. Same shape as packages/k8s-sandbox/src/resolve-pod.ts: pure argv builders plus
 * one injectable runner, so every Kubernetes interaction is unit-testable without a cluster.
 *
 * Two properties the builders exist to make assertable:
 *   1. A patch body rides on a temp file (`--patch-file=<path>`), never in argv -- argv is readable
 *      through /proc/<pid>/cmdline by anything sharing the pod.
 *   2. No Secret operation is ever a LIST. Spec §6.5's Role deliberately omits the `list` verb, so
 *      any code path needing it would 403 in production; naming every object keeps that RBAC usable.
 */
export type RunKubectl = (args: string[], stdin?: string) => Promise<string>;

function spawnKubectl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(out).toString());
      // The stderr text is included because callers branch on it (isAlreadyExists), but the ARGS are
      // summarised to the verb+resource: a full argv join is safe today only because no builder puts
      // a secret there, and this message ends up in logs.
      reject(
        new Error(
          `kubectl ${args.slice(0, 3).join(' ')} failed (${code}): ${Buffer.concat(err)
            .toString()
            .trim()}`,
        ),
      );
    });
  });
}

export const defaultRunKubectl: RunKubectl = async (args, stdin) => {
  if (stdin === undefined) return spawnKubectl(args);

  /*
   * `--patch-file=/dev/stdin` can't be fed through a Node child's stdin pipe: libuv backs
   * `stdio: 'pipe'` with a UNIX-domain socket rather than a plain pipe(2) (confirmed with
   * `stat -L /proc/self/fd/0` on the deployed image: `socket:[...]`), and kubectl reads
   * `--patch-file` by re-opening the given path -- which the kernel refuses for a socket reached
   * through /proc/<pid>/fd (ENXIO, "no such device or address"). A real temp file sidesteps the
   * whole class: it's an ordinary path any program can open, and its CONTENT still never touches
   * argv -- only its randomly-named, briefly-lived path does, which is what this module exists to
   * keep out of /proc/<pid>/cmdline.
   */
  const path = join(tmpdir(), `sh-cp-patch-${randomBytes(16).toString('hex')}.json`);
  await writeFile(path, stdin, { mode: 0o600 });
  try {
    return await spawnKubectl(args.map((a) => a.replaceAll('/dev/stdin', path)));
  } finally {
    await unlink(path).catch(() => {});
  }
};

export function buildCreateSecretArgs(name: string, namespace: string): string[] {
  return ['create', 'secret', 'generic', name, '-n', namespace];
}

export function buildPatchSecretArgs(name: string, namespace: string): string[] {
  return [
    'patch',
    'secret',
    name,
    '-n',
    namespace,
    '--type=merge',
    // A strategic/JSON merge patch, sent on stdin. Merge (not apply) is what makes a per-credential
    // write safe without read-modify-write: two credentials written concurrently for one subject
    // cannot lose each other, which is the failure mode spec §6.6 rejects a shared Secret over.
    '--patch-file=/dev/stdin',
  ];
}

export function buildGetSecretArgs(name: string, namespace: string): string[] {
  return ['get', 'secret', name, '-n', namespace, '-o', 'json', '--ignore-not-found'];
}

export function buildDeleteSecretArgs(name: string, namespace: string): string[] {
  return ['delete', 'secret', name, '-n', namespace, '--ignore-not-found'];
}

export function buildGetPodPhaseArgs(pod: string, namespace: string): string[] {
  return [
    'get',
    'pod',
    pod,
    '-n',
    namespace,
    '-o',
    'jsonpath={.status.phase}',
    '--ignore-not-found',
  ];
}

/** Tab-separated `<name>\t<phase>`, empty when the selector matches nothing. */
export function buildFindPodBySelectorArgs(selector: string, namespace: string): string[] {
  return [
    'get',
    'pods',
    '-n',
    namespace,
    '-l',
    selector,
    '--field-selector=status.phase=Running',
    '-o',
    'jsonpath={.items[0].metadata.name}\t{.items[0].status.phase}',
  ];
}

export function isAlreadyExists(err: unknown): boolean {
  return err instanceof Error && /AlreadyExists|already exists/.test(err.message);
}
