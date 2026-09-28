import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AMBIENT_KEY_SENTINEL } from '@sh/harness/ambient-sentinel';
import { readTenancy } from '../src/tenancy.js';
import { prepareServerProcess, scrubAmbientCredentials } from '../src/server-process.js';

const KEYS = [
  'MOCA_TENANCY',
  'SH_REQUIRE_AUTH',
  'SH_LOCAL_TOOLS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'SH_SESSION_TOKEN_PUBLIC_KEYS',
  'PI_CODING_AGENT_DIR',
];

describe('readTenancy', () => {
  it('defaults to single and accepts the two values', () => {
    expect(readTenancy({})).toBe('single');
    expect(readTenancy({ MOCA_TENANCY: 'single' })).toBe('single');
    expect(readTenancy({ MOCA_TENANCY: 'multi' })).toBe('multi');
  });

  it('refuses anything else, naming the variable', () => {
    expect(() => readTenancy({ MOCA_TENANCY: 'Multi' })).toThrow(/MOCA_TENANCY/);
    expect(() => readTenancy({ MOCA_TENANCY: '' })).toThrow(/MOCA_TENANCY/);
  });
});

describe('prepareServerProcess', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('under single tenancy leaves an operator key in place', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'sk-operator' }; // notsecret
    expect(prepareServerProcess(env).tenancy).toBe('single');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-operator'); // notsecret
  });

  it('under multi tenancy replaces the key with the sentinel and deletes the rest', () => {
    const env: NodeJS.ProcessEnv = {
      MOCA_TENANCY: 'multi',
      SH_REQUIRE_AUTH: 'true',
      ANTHROPIC_API_KEY: 'sk-tenant-planted', // notsecret
      ANTHROPIC_OAUTH_TOKEN: 'oauth-planted', // notsecret
      ANTHROPIC_AUTH_TOKEN: 'auth-planted', // notsecret
      OPENAI_API_KEY: 'sk-openai-planted', // notsecret
    };
    prepareServerProcess(env);
    expect(env.ANTHROPIC_API_KEY).toBe(AMBIENT_KEY_SENTINEL);
    // ANTHROPIC_OAUTH_TOKEN outranks ANTHROPIC_API_KEY in pi's lookup, so the sentinel alone would
    // not be enough: asserting its absence is the point (P5 §3.2 step 3).
    expect(env).not.toHaveProperty('ANTHROPIC_OAUTH_TOKEN');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('under multi tenancy refuses SH_LOCAL_TOOLS=1', () => {
    expect(() =>
      prepareServerProcess({ MOCA_TENANCY: 'multi', SH_REQUIRE_AUTH: 'true', SH_LOCAL_TOOLS: '1' }),
    ).toThrow(/SH_LOCAL_TOOLS/);
  });

  it('under multi tenancy refuses to run without SH_REQUIRE_AUTH=true', () => {
    expect(() => prepareServerProcess({ MOCA_TENANCY: 'multi' })).toThrow(/SH_REQUIRE_AUTH/);
  });

  it('still refuses a malformed session-token keyset, as startServer always has', () => {
    expect(() => prepareServerProcess({ SH_SESSION_TOKEN_PUBLIC_KEYS: 'garbage' })).toThrow(
      /SH_SESSION_TOKEN_PUBLIC_KEYS/,
    );
  });

  it('scrubAmbientCredentials is idempotent', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'sk-x' }; // notsecret
    scrubAmbientCredentials(env);
    scrubAmbientCredentials(env);
    expect(env.ANTHROPIC_API_KEY).toBe(AMBIENT_KEY_SENTINEL);
  });
});
