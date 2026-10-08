/** One file in a bundle. `mode` defaults to 0o644; scripts use 0o755. */
export interface TarEntry {
  path: string;
  content: Buffer;
  mode?: number;
}

/** Bundle wire-format version. Bumped only on a breaking layout change. */
export const BUNDLE_FORMAT_VERSION = 1;

export type SkillScope = 'project' | 'user' | 'plugin';

/** One skill, resolved to a directory. `files` are paths relative to `dir`, always incl. SKILL.md. */
export interface ResolvedSkill {
  name: string;
  dir: string;
  skillMd: string;
  files: string[];
  scope: SkillScope;
  /** Non-fatal findings raised while resolving this skill's files (e.g. an escaped symlink). */
  findings?: PreflightFinding[];
}

export interface SkillRoots {
  /** Repo-local `.claude` directory. */
  projectDir?: string;
  /** `~/.claude`. */
  userDir?: string;
  /** e.g. [`~/.claude/plugins`]. Scanned recursively; cache/marketplace duplicates collapse. */
  pluginDirs?: string[];
}

export type DropReason = 'no_harness_equivalent' | 'needs_subagent' | 'user_denied';

/** Unattended: no human can answer a question. Attended: phase-2 live attach (spec §4.6). */
export type PromoteMode = 'unattended' | 'attended';

export interface DroppedSkill {
  name: string;
  reason: DropReason;
  detail: string;
}

export interface Classification {
  travels: ResolvedSkill[];
  dropped: DroppedSkill[];
  /** Travels, but degrades without a human. Warned under `unattended` only. */
  interactionDependent: string[];
}

export interface ClassifyOptions {
  mode: PromoteMode;
  userDenyList?: string[];
}

export type SecretSeverity = 'blocking' | 'warning';

export interface SecretFinding {
  path: string;
  line: number;
  rule: string;
  severity: SecretSeverity;
}

export interface LockfileSkillRecord {
  name: string;
  scope: SkillScope;
  sourceDir: string;
  contentHash: string;
}

export interface BundleLockfile {
  binaries: string[];
  builtAgainst: { harness: string; pi: string };
  context: string[];
  digest: string;
  dropped: DroppedSkill[];
  entry: string;
  formatVersion: number;
  interactionDependent: string[];
  memory: string[];
  mode: PromoteMode;
  sandboxImage: string;
  skills: LockfileSkillRecord[];
}

export interface LockfileInput {
  digest: string;
  mode: PromoteMode;
  entry: string;
  classification: Classification;
  contextPaths: string[];
  memoryPaths: string[];
  sandboxImage: string;
  binaries: string[];
  versions: { pi: string; harness: string };
  skillHashes: Record<string, string>;
}

export interface PreflightFinding {
  severity: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  path?: string;
}

export interface BuildBundleInput {
  roots: SkillRoots;
  /** Directory holding MEMORY.md plus one-fact-per-file memories. */
  memoryDir?: string;
  /** Directory of slash-command templates; each `<name>.md` becomes prompt `<name>`. */
  promptsDir?: string;
  /** Already-read CLAUDE.md/AGENTS.md chain, outermost first. */
  contextFiles?: Array<{ path: string; content: string }>;
  /** The batch entry prompt. Omitted for interactive promotion, which has no fixed first prompt. */
  entry?: string;
  mode: PromoteMode;
  userDenyList?: string[];
  /**
   * Prompt names (no `.md`) to leave out of the bundle.
   *
   * Exists so a slash command that drives promotion can live in the project it promotes without
   * shipping itself: with `HOME` pointed at the project, `promptsDir` IS that project's
   * `.claude/commands/`, and every markdown file in it otherwise travels.
   */
  excludePrompts?: string[];
  sandboxImage: string;
  /** Commands the sandbox image provides; undefined ⇒ cannot verify. */
  inventory?: string[];
  versions: { pi: string; harness: string };
  /** Extra appendSystemPrompt fragments beyond the two standard notes. */
  extraPromptFragments?: string[];
}

export interface BuildResult {
  tar: Buffer;
  digest: string;
  lockfile: BundleLockfile;
  findings: PreflightFinding[];
  promptNames: string[];
}
