import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { turnLoaderInputs } from '../src/run-turn.js';

let root: string;
let cwd: string;
let savedAgentDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mi1-r4-'));
  cwd = join(root, 'cwd');
  const agentDir = join(root, 'agent');
  mkdirSync(join(cwd, '.pi', 'extensions'), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(cwd, '.pi', 'SYSTEM.md'), 'PLANTED-PROJECT-SYSTEM');
  writeFileSync(join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'PLANTED-PROJECT-APPEND');
  writeFileSync(join(cwd, 'AGENTS.md'), 'PLANTED-AGENTS');
  writeFileSync(
    join(cwd, '.pi', 'extensions', 'planted.ts'),
    'export default function () { (globalThis as any).__MI1_PLANTED_EXTENSION = true; }\n',
  );
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete (globalThis as Record<string, unknown>).__MI1_PLANTED_EXTENSION;
});

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  rmSync(root, { recursive: true, force: true });
});

async function load(serverMode: boolean) {
  const { loaderOptions } = turnLoaderInputs({
    config: serverMode ? { serverMode: true } : undefined,
    cwd,
    extensionFactories: [],
  });
  const loader = new DefaultResourceLoader(loaderOptions as never);
  await loader.reload();
  return loader;
}

describe('server-mode resource loader (MI1 R4)', () => {
  it('loads no project SYSTEM.md, APPEND_SYSTEM.md, AGENTS.md or extension file', async () => {
    const loader = await load(true);
    expect(loader.getSystemPrompt() ?? '').not.toContain('PLANTED');
    expect(loader.getAppendSystemPrompt().join('\n')).not.toContain('PLANTED');
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getExtensions().extensions).toEqual([]);
    expect((globalThis as Record<string, unknown>).__MI1_PLANTED_EXTENSION).toBeUndefined();
  });

  it('outside server mode the same files ARE picked up — the test is sensitive', async () => {
    const loader = await load(false);
    expect(loader.getSystemPrompt() ?? '').toContain('PLANTED-PROJECT-SYSTEM');
  });
});
