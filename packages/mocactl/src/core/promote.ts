import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildBundle,
  hasErrors,
  MAX_BUNDLE_BYTES,
  renderPreflight,
  SecretScanError,
} from '@moca/config-bundle';
import type { ControlPlaneApi } from '../api/types.js';

export class PromoteError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 | 3,
  ) {
    super(message);
    this.name = 'PromoteError';
  }
}

export interface PromoteResult {
  digest: string;
  uploaded: boolean;
  configRoot: string;
  skills: string[];
  dropped: Array<{ name: string; reason: string }>;
  prompts: string[];
  report: string;
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** A project root holds `.claude/`; a path that is itself a `.claude` dir holds `skills/` or `commands/`. */
export function resolveConfigRoot(dir: string, home: string, cwd: string): string {
  const expanded = dir === '~' ? home : dir.startsWith('~/') ? join(home, dir.slice(2)) : dir;
  const abs = resolve(cwd, expanded);
  if (isDir(join(abs, '.claude'))) return join(abs, '.claude');
  if (isDir(join(abs, 'skills')) || isDir(join(abs, 'commands'))) return abs;
  throw new PromoteError(`no .claude/skills or .claude/commands under ${abs}`, 1);
}

export async function promoteDirectory(
  dir: string,
  cp: ControlPlaneApi,
  env: { home?: string; cwd?: string } = {},
): Promise<PromoteResult> {
  const configRoot = resolveConfigRoot(dir, env.home ?? homedir(), env.cwd ?? process.cwd());
  let result;
  try {
    result = buildBundle({
      roots: { userDir: configRoot },
      promptsDir: join(configRoot, 'commands'),
      mode: 'unattended',
      sandboxImage: 'ghcr.io/rossoctl/moca-sandbox:latest',
      versions: { pi: 'unknown', harness: 'mocactl' },
    });
  } catch (err) {
    if (err instanceof SecretScanError) {
      const where = err.findings.map((f) => `  ${f.path}:${f.line}  ${f.rule}`).join('\n');
      throw new PromoteError(
        `promote blocked — a credential would reach a shared store:\n${where}\n` +
          'Remove it, then promote again.',
        3,
      );
    }
    throw new PromoteError(err instanceof Error ? err.message : String(err), 1);
  }
  const report = renderPreflight(result.findings);
  if (hasErrors(result.findings)) throw new PromoteError(`preflight found errors:\n${report}`, 2);
  const skills = result.lockfile.skills.map((s) => s.name);
  if (skills.length === 0 && result.promptNames.length === 0) {
    throw new PromoteError(`nothing to promote: no skills or commands under ${configRoot}`, 1);
  }
  if (result.tar.length > MAX_BUNDLE_BYTES) {
    throw new PromoteError(
      `bundle is ${result.tar.length} bytes; the limit is ${MAX_BUNDLE_BYTES} bytes`,
      1,
    );
  }
  const { uploaded } = await cp.putConfigBundle({
    digest: result.digest,
    tar: result.tar.toString('base64'),
  });
  return {
    digest: result.digest,
    uploaded,
    configRoot,
    skills,
    dropped: result.lockfile.dropped.map((d) => ({ name: d.name, reason: d.reason })),
    prompts: result.promptNames,
    report,
  };
}
