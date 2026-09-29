import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyModelGateway } from '../src/run-turn';
import { AMBIENT_KEY_SENTINEL } from '../src/ambient-sentinel';

const baseModel = { id: 'claude-haiku-4-5', headers: { 'x-api-key': 'orig' } } as never;

describe('applyModelGateway', () => {
  let savedKey: string | undefined;
  let savedBase: string | undefined;
  let savedTok: string | undefined;
  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    savedBase = process.env.ANTHROPIC_BASE_URL;
    savedTok = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = savedBase;
    if (savedTok === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = savedTok;
  });

  it('returns the base model unchanged when no gateway base or token is set', () => {
    const m = applyModelGateway(baseModel, {}) as any;
    expect(m).toBe(baseModel);
  });

  it('applies the gateway baseUrl and Bearer auth, stripping x-api-key', () => {
    const m = applyModelGateway(baseModel, {
      anthropicBaseUrl: 'https://gw.example/v1',
      anthropicAuthToken: 'tok-123',
    }) as any;
    expect(m.baseUrl).toBe('https://gw.example/v1');
    expect(m.headers.Authorization).toBe('Bearer tok-123');
    expect(m.headers['x-api-key']).toBeNull();
  });

  it('reads ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from env when config omits them', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://env-gw/v1';
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-tok';
    const m = applyModelGateway(baseModel, {}) as any;
    expect(m.baseUrl).toBe('https://env-gw/v1');
    expect(m.headers.Authorization).toBe('Bearer env-tok');
  });

  it('seeds only the constant sentinel, never the auth token, when the key is unset', () => {
    applyModelGateway(baseModel, { anthropicAuthToken: 'tok-xyz' }); // notsecret
    expect(process.env.ANTHROPIC_API_KEY).toBe(AMBIENT_KEY_SENTINEL);
    expect(process.env.ANTHROPIC_API_KEY).not.toBe('tok-xyz');
  });

  it('disables gateway-incompatible compat flags when a gateway base is set', () => {
    // litellm rejects per-tool eager_input_streaming / cache_control; the gateway model must
    // disable these so convertTools() omits them (otherwise tool-bearing requests 400).
    const m = applyModelGateway(baseModel, { anthropicBaseUrl: 'https://gw.example/v1' }) as any;
    expect(m.compat.supportsEagerToolInputStreaming).toBe(false);
    expect(m.compat.supportsCacheControlOnTools).toBe(false);
    expect(m.compat.supportsLongCacheRetention).toBe(false);
  });

  it('does not add compat when no gateway base is set (direct API)', () => {
    const m = applyModelGateway(baseModel, { anthropicAuthToken: 'tok-only' }) as any;
    expect(m.compat).toBeUndefined();
  });

  it('applies baseUrl + disables compat but sets no auth header for a token-less public gateway', () => {
    const m = applyModelGateway(baseModel, { anthropicBaseUrl: 'https://public-gw/v1' }) as any;
    expect(m.baseUrl).toBe('https://public-gw/v1');
    expect(m.compat.supportsEagerToolInputStreaming).toBe(false);
    // no token → no Authorization header, and the original headers are left untouched
    expect(m.headers.Authorization).toBeUndefined();
    expect(m.headers['x-api-key']).toBe('orig');
  });

  it('treats an empty-string config value as unset and falls back to the env var', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://env-gw/v1';
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-tok';
    const m = applyModelGateway(baseModel, { anthropicBaseUrl: '', anthropicAuthToken: '' }) as any;
    expect(m.baseUrl).toBe('https://env-gw/v1');
    expect(m.headers.Authorization).toBe('Bearer env-tok');
  });

  describe('a tagged upstream credential (MU1 spec §3.6)', () => {
    it('takes precedence over both anthropicAuthToken and the environment', () => {
      // MU1's work is to make `config` carry the RIGHT SUBJECT's token; the gateway function itself
      // needs no new logic (spec §3.4).
      process.env.ANTHROPIC_AUTH_TOKEN = 'env-deployment-token'; // notsecret
      const m = applyModelGateway(baseModel, {
        anthropicBaseUrl: 'https://gw.example/v1',
        anthropicAuthToken: 'stale-config-token', // notsecret
        upstreamCredential: { mode: 'direct', value: 'sk-alice' }, // notsecret
      }) as any;
      expect(m.headers.Authorization).toBe('Bearer sk-alice'); // notsecret
    });

    it('installs a placeholder verbatim, for an injector to rewrite', () => {
      // RC1's static-inject rewrites `Bearer <placeholder>` from a mounted secret_dir (P5 §3.1-§3.2),
      // so the harness must send it through UNCHANGED rather than treating it as a real token.
      const m = applyModelGateway(baseModel, {
        anthropicBaseUrl: 'https://gw.example/v1',
        upstreamCredential: { mode: 'placeholder', value: 'sh-placeholder-github:1234' }, // notsecret
      }) as any;
      expect(m.headers.Authorization).toBe('Bearer sh-placeholder-github:1234'); // notsecret
    });

    it('falls back to the existing chain when no upstream credential is supplied', () => {
      // The whole point of an ADDITIVE change: every existing caller -- the leaf path, the CLI, the 14
      // unauthenticated deploy scripts -- must behave exactly as before.
      process.env.ANTHROPIC_AUTH_TOKEN = 'env-token'; // notsecret
      const m = applyModelGateway(baseModel, { anthropicBaseUrl: 'https://gw.example/v1' }) as any;
      expect(m.headers.Authorization).toBe('Bearer env-token'); // notsecret
    });

    it('treats an empty value as "not set", like every other term in the chain', () => {
      // `||` not `??` throughout this function: "" is a not-set sentinel here, not a credential.
      process.env.ANTHROPIC_AUTH_TOKEN = 'env-token'; // notsecret
      const m = applyModelGateway(baseModel, {
        anthropicBaseUrl: 'https://gw.example/v1',
        upstreamCredential: { mode: 'direct', value: '' },
      }) as any;
      expect(m.headers.Authorization).toBe('Bearer env-token'); // notsecret
    });

    it("never writes the subject's own credential into the environment (MI1 R2)", () => {
      // In a fresh process with no ANTHROPIC_API_KEY, an authenticated turn's credential travels
      // only in its own request's Bearer header; the environment only ever receives a constant
      // that names no one.
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      const m = applyModelGateway(baseModel, {
        anthropicBaseUrl: 'https://gw.example/v1',
        upstreamCredential: { mode: 'direct', value: 'sk-alice' }, // notsecret
      }) as any;
      expect(m.headers.Authorization).toBe('Bearer sk-alice'); // notsecret
      expect(m.headers['x-api-key']).toBeNull();
      expect(process.env.ANTHROPIC_API_KEY).toBe(AMBIENT_KEY_SENTINEL);
    });

    it('a token-less call after an authenticated one inherits nothing from it', () => {
      applyModelGateway(baseModel, {
        anthropicBaseUrl: 'https://gw.example/v1',
        upstreamCredential: { mode: 'direct', value: 'sk-alice' }, // notsecret
      });
      const second = applyModelGateway(baseModel, {}) as any;
      expect(second).toBe(baseModel); // no gateway, no token: the model is returned unchanged
      expect(process.env.ANTHROPIC_API_KEY).toBe(AMBIENT_KEY_SENTINEL);
      expect(JSON.stringify(process.env)).not.toContain('sk-alice');
    });

    it('does NOT overwrite an ANTHROPIC_API_KEY that is already set — the seed is write-once', () => {
      // The other half of the same property, and the half that keeps the seed from being a
      // cross-subject leak on every turn: with the deployment's key already in the environment (the
      // normal case, per service.yaml's required secretKeyRef) Alice's credential does not replace it.
      process.env.ANTHROPIC_API_KEY = 'sk-deployment'; // notsecret
      applyModelGateway(baseModel, {
        anthropicBaseUrl: 'https://gw.example/v1',
        upstreamCredential: { mode: 'direct', value: 'sk-alice' }, // notsecret
      });
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-deployment'); // notsecret
    });
  });
});
