import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AMBIENT_KEY_SENTINEL } from '@sh/harness/ambient-sentinel';
import { assertKeysetUsable } from './turn-auth.js';
import { readTenancy, type Tenancy } from './tenancy.js';

// Created once per process: every turn in this process shares it, no other process does.
let privateAgentDir: string | undefined;

function ensurePrivateAgentDir(): string {
  if (!privateAgentDir) privateAgentDir = mkdtempSync(join(tmpdir(), 'sh-agent-')); // mode 0700
  return privateAgentDir;
}

/**
 * P5 §3.2 step 3, applied only under multi tenancy (MI1 §5 R2): the process holds no provider
 * credential. ANTHROPIC_API_KEY becomes the sentinel (pi requires it to exist); the OAuth token is
 * DELETED because pi's lookup ranks it above ANTHROPIC_API_KEY, so leaving it would defeat the
 * sentinel; the gateway token and the OpenAI key go too.
 */
export function scrubAmbientCredentials(env: NodeJS.ProcessEnv): void {
  env.ANTHROPIC_API_KEY = AMBIENT_KEY_SENTINEL;
  delete env.ANTHROPIC_OAUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENAI_API_KEY;
}

/**
 * Boot-time preparation shared by BOTH server entry points — `startServer()` and the P6 worker — so
 * neither can run unprepared (MI1 §5 R2, P6 §3.6). Throws on an inconsistent configuration; callers
 * turn that into a boot failure.
 */
export function prepareServerProcess(env: NodeJS.ProcessEnv = process.env): {
  tenancy: Tenancy;
  agentDir: string;
} {
  assertKeysetUsable(env);
  const tenancy = readTenancy(env);
  if (tenancy === 'multi') {
    if (env.SH_LOCAL_TOOLS === '1') {
      throw new Error('MOCA_TENANCY=multi refuses SH_LOCAL_TOOLS=1: tools must run in a sandbox');
    }
    if (env.SH_REQUIRE_AUTH !== 'true') {
      throw new Error('MOCA_TENANCY=multi requires SH_REQUIRE_AUTH=true');
    }
    scrubAmbientCredentials(env);
  }
  // Pi reads SYSTEM.md, extensions/, skills/, auth.json and models.json from the agent directory. A
  // server never uses a shared one — not $HOME/.pi/agent, not an inherited value (MI1 §5 R4).
  env.PI_CODING_AGENT_DIR = ensurePrivateAgentDir();
  return { tenancy, agentDir: env.PI_CODING_AGENT_DIR };
}
