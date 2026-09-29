import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { turnLoaderInputs } from '../src/run-turn.js';
import type { PromotedConfig } from '../src/config-resolver.js';

// Read through the installed package, so the fixture tracks the pi version the harness runs.
const DARK_THEME = fileURLToPath(
  new URL(
    '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json',
    import.meta.url,
  ),
);

let root: string;
let cwd: string;
let savedAgentDir: string | undefined;
let savedHome: string | undefined;

const skill = (name: string) =>
  `---\nname: ${name}\ndescription: A planted skill used to test loader discovery.\n---\n\nBody.\n`;

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
  // A user-scope skill under $HOME/.agents/skills and a prompt template in the agent directory: both
  // are discovered by default, so they show whether discovery is on.
  const home = join(root, 'home');
  mkdirSync(join(home, '.agents', 'skills', 'planted-home-skill'), { recursive: true });
  writeFileSync(
    join(home, '.agents', 'skills', 'planted-home-skill', 'SKILL.md'),
    skill('planted-home-skill'),
  );
  mkdirSync(join(agentDir, 'prompts'), { recursive: true });
  writeFileSync(join(agentDir, 'prompts', 'planted-prompt.md'), 'PLANTED-PROMPT-TEMPLATE\n');
  // An extension in the AGENT directory as well as the project one: `projectTrusted: false` alone
  // already suppresses the project's, so only this one shows that `noExtensions` itself holds.
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  writeFileSync(
    join(agentDir, 'extensions', 'planted-agent.ts'),
    'export default function () { (globalThis as any).__MI1_PLANTED_AGENT_EXTENSION = true; }\n',
  );
  // A theme in the agent directory: pi's own bundled dark theme, renamed, so it is certainly valid.
  mkdirSync(join(agentDir, 'themes'), { recursive: true });
  writeFileSync(
    join(agentDir, 'themes', 'planted-theme.json'),
    JSON.stringify({ ...JSON.parse(readFileSync(DARK_THEME, 'utf8')), name: 'planted-theme' }),
  );
  savedHome = process.env.HOME;
  process.env.HOME = home;
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete (globalThis as Record<string, unknown>).__MI1_PLANTED_EXTENSION;
  delete (globalThis as Record<string, unknown>).__MI1_PLANTED_AGENT_EXTENSION;
});

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

async function load(serverMode: boolean, promotedConfig?: PromotedConfig) {
  const { loaderOptions } = turnLoaderInputs({
    config: serverMode ? { serverMode: true } : undefined,
    cwd,
    extensionFactories: [],
    promotedConfig,
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
    expect((globalThis as Record<string, unknown>).__MI1_PLANTED_AGENT_EXTENSION).toBeUndefined();
  });

  it('outside server mode the same files ARE picked up — each assertion above is sensitive', async () => {
    // One control per assertion in the test above: without it, an assertion that pi never
    // discovers the file in this configuration at all would pass with the lockdown deleted.
    const loader = await load(false);
    expect(loader.getSystemPrompt() ?? '').toContain('PLANTED-PROJECT-SYSTEM');
    expect(loader.getAppendSystemPrompt().join('\n')).toContain('PLANTED-PROJECT-APPEND');
    expect(
      loader
        .getAgentsFiles()
        .agentsFiles.map((f) => f.content)
        .join('\n'),
    ).toContain('PLANTED-AGENTS');
    expect(loader.getExtensions().extensions.length).toBeGreaterThan(0);
    expect((globalThis as Record<string, unknown>).__MI1_PLANTED_EXTENSION).toBe(true);
    expect((globalThis as Record<string, unknown>).__MI1_PLANTED_AGENT_EXTENSION).toBe(true);
  });

  it('discovers no skill, prompt template or theme in server mode', async () => {
    const { loaderOptions } = turnLoaderInputs({
      config: { serverMode: true },
      cwd,
      extensionFactories: [],
    });
    expect(loaderOptions).toMatchObject({
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    const loader = await load(true);
    expect(loader.getSkills().skills.map((s) => s.name)).not.toContain('planted-home-skill');
    expect(loader.getPrompts().prompts.map((p) => p.name)).not.toContain('planted-prompt');
    expect(loader.getThemes().themes.map((t) => t.name)).not.toContain('planted-theme');
  });

  it('outside server mode the user skill and the prompt template ARE discovered — the test is sensitive', async () => {
    const loader = await load(false);
    expect(loader.getSkills().skills.map((s) => s.name)).toContain('planted-home-skill');
    expect(loader.getPrompts().prompts.map((p) => p.name)).toContain('planted-prompt');
    expect(loader.getThemes().themes.map((t) => t.name)).toContain('planted-theme');
  });

  it('a promoted bundle still delivers its skills and prompt templates in server mode', async () => {
    const promotedRoot = join(root, 'promoted');
    const skillsDir = join(promotedRoot, 'skills');
    const promptsDir = join(promotedRoot, 'prompts');
    mkdirSync(join(skillsDir, 'promoted-skill'), { recursive: true });
    writeFileSync(join(skillsDir, 'promoted-skill', 'SKILL.md'), skill('promoted-skill'));
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(join(promptsDir, 'promoted-prompt.md'), 'PROMOTED-PROMPT\n');
    const promoted: PromotedConfig = {
      digest: 'sha256:test',
      root: promotedRoot,
      skillsDir,
      promptsDir,
      context: [],
      promptFragments: [],
      entries: [],
    };
    const loader = await load(true, promoted);
    const skills = loader.getSkills().skills.map((s) => s.name);
    expect(skills).toContain('promoted-skill');
    expect(skills).not.toContain('planted-home-skill');
    const prompts = loader.getPrompts().prompts.map((p) => p.name);
    expect(prompts).toContain('promoted-prompt');
    expect(prompts).not.toContain('planted-prompt');
  });
});
