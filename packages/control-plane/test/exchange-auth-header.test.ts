import { beforeEach, describe, expect, it } from 'vitest';
import { exchangeCredential } from '../src/exchange.js';
import { HANDLERS, type CpDeps } from '../src/handlers.js';
import { makeDeps, ctx, alice, codeOf, seedCredential } from './helpers/deps.js';

/** #368: which header the data plane sends the subject's credential in. */
async function sessionToken(d: CpDeps, id = 'sid-hdr'): Promise<string> {
  const res = await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), {
    ...d,
    newId: () => id,
  });
  return (res.body as { token: string }).token;
}

const RAW_KEY = 'sk-ant-api03-not-a-real-key'; // notsecret
const anthropicKey = {
  kind: 'api-key',
  destination: { hosts: ['api.anthropic.com'] },
  endpoint: 'https://api.anthropic.com',
  secret: { key: RAW_KEY },
};

describe('exchangeCredential: authHeader', () => {
  let d: CpDeps;
  beforeEach(() => {
    d = makeDeps({ config: { exchangeToken: 'shared-abc' } }); // notsecret
  });

  it('omits authHeader for a Bearer credential, so the pre-#368 wire shape is unchanged', async () => {
    await seedCredential(d);
    const res = await exchangeCredential(await sessionToken(d), d);
    expect(res).not.toHaveProperty('authHeader');
  });

  it("returns authHeader 'x-api-key' and the raw key for an api-key credential in direct mode", async () => {
    await seedCredential(d, 'github:1234', 'my-anthropic', anthropicKey);
    const res = await exchangeCredential(await sessionToken(d), d);
    expect(res.authHeader).toBe('x-api-key');
    expect(res.anthropicAuthToken).toBe(RAW_KEY);
    expect(res.anthropicBaseUrl).toBe('https://api.anthropic.com');
  });

  it('refuses an x-api-key credential in placeholder mode rather than sending an unrewritten placeholder', async () => {
    // Review Focus 4: the injector rewrites only `Bearer <placeholder>` (RC1/P5).
    const inj = makeDeps({ config: { exchangeToken: 'shared-abc', injectorConfigured: true } }); // notsecret
    await seedCredential(inj, 'github:1234', 'my-anthropic', anthropicKey);
    const token = await sessionToken(inj);
    expect(await codeOf(() => exchangeCredential(token, inj))).toBe('credential_required');
  });

  it('refuses a stored binding the inference path cannot send, never falling back to Bearer', async () => {
    // Review Focus 5: a credential written before Task 1's check existed. Bypasses parseCredentialBody.
    await d.credentials.put('github:1234', {
      descriptor: {
        name: 'my-anthropic',
        kind: 'bearer',
        consumer: 'inference',
        destination: { hosts: ['litellm.internal'] },
        binding: { header: 'X-Custom', format: '{token}' },
        endpoint: 'https://litellm.internal',
      },
      secret: { token: 'gw-fake' }, // notsecret
    });
    const token = await sessionToken(d);
    let message = '';
    try {
      await exchangeCredential(token, d);
    } catch (e) {
      message = (e as Error).message;
      expect((e as { code: string }).code).toBe('credential_required');
    }
    expect(message).toContain("'my-anthropic'");
    expect(message).not.toContain('gw-fake');
  });

  it('keeps the operator fallback on Bearer', async () => {
    const fb = makeDeps({
      config: {
        exchangeToken: 'shared-abc', // notsecret
        allowOperatorFallback: true,
        operatorInferenceToken: 'op-gw-token', // notsecret
        defaultInferenceEndpoint: 'https://litellm.internal',
      },
    });
    // Mirrors exchange.test.ts's fallback case: a session needs a credential to be created, and the
    // fallback is what applies once that credential is gone.
    await seedCredential(fb);
    const token = await sessionToken(fb);
    await fb.credentials.delete('github:1234', 'my-anthropic');
    const res = await exchangeCredential(token, fb);
    expect(res.anthropicAuthToken).toBe('op-gw-token'); // notsecret
    expect(res).not.toHaveProperty('authHeader');
  });

  it('refuses a Bearer credential whose RESOLVED endpoint is api.anthropic.com', async () => {
    // No endpoint on the credential, and a deployment default of api.anthropic.com (compose
    // documents that default): Bearer there always 401s, and PUT could not know the default.
    const dflt = makeDeps({
      config: {
        exchangeToken: 'shared-abc',
        defaultInferenceEndpoint: 'https://api.anthropic.com',
      }, // notsecret
    });
    await seedCredential(dflt, 'github:1234', 'my-anthropic', {
      destination: { hosts: ['api.anthropic.com'] },
      endpoint: undefined,
    });
    const token = await sessionToken(dflt);
    let message = '';
    try {
      await exchangeCredential(token, dflt);
    } catch (e) {
      message = (e as Error).message;
      expect((e as { code: string }).code).toBe('credential_required');
    }
    expect(message).toContain("kind 'api-key'");
  });

  it('lets an api-key credential with no endpoint use an api.anthropic.com default', async () => {
    const dflt = makeDeps({
      config: {
        exchangeToken: 'shared-abc',
        defaultInferenceEndpoint: 'https://api.anthropic.com',
      }, // notsecret
    });
    await seedCredential(dflt, 'github:1234', 'my-anthropic', {
      ...anthropicKey,
      endpoint: undefined,
    });
    const res = await exchangeCredential(await sessionToken(dflt), dflt);
    expect(res.authHeader).toBe('x-api-key');
    expect(res.anthropicBaseUrl).toBe('https://api.anthropic.com');
  });
});
