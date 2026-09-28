import { describe, expect, it } from 'vitest';
import { SANDBOX_ENV_ALLOW, sandboxEnv } from '../src/sandbox-env.js';

describe('sandboxEnv', () => {
  it('keeps only allowlisted names', () => {
    const out = sandboxEnv({
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      ANTHROPIC_API_KEY: 'sk-ant-planted', // notsecret
      SH_EXCHANGE_TOKEN: 'planted', // notsecret
      REDIS_URL: 'redis://planted:6379',
    });
    expect(out).toEqual({ LANG: 'C.UTF-8', TZ: 'UTC' });
  });

  it('never forwards PATH, which Pi rewrites to a harness-host path', () => {
    expect(sandboxEnv({ PATH: '/app/node_modules/.bin:/usr/bin' })).toEqual({});
    expect(SANDBOX_ENV_ALLOW).not.toContain('PATH');
  });

  it('drops undefined values and tolerates an absent env', () => {
    expect(sandboxEnv({ LANG: undefined })).toEqual({});
    expect(sandboxEnv(undefined)).toEqual({});
  });

  it('holds no name that could carry a credential', () => {
    for (const name of SANDBOX_ENV_ALLOW) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASS|AUTH|URL|CRED/i);
    }
  });
});
