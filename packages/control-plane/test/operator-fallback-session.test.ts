import { describe, expect, it } from 'vitest';
import { exchangeCredential } from '../src/exchange.js';
import { HANDLERS, type CpDeps } from '../src/handlers.js';
import { makeDeps, ctx, alice, codeOf, seedCredential } from './helpers/deps.js';

/**
 * #368 phase 2: the operator fallback serves a subject that has stored NO inference credential -- the
 * case spec §6.4 exists for -- not only one whose credential vanished after session creation.
 */
const fallbackConfig = {
  exchangeToken: 'shared-abc', // notsecret
  allowOperatorFallback: true,
  operatorInferenceToken: 'op-gw-token', // notsecret
  defaultInferenceEndpoint: 'https://gateway.example',
};

async function create(d: CpDeps, body: Record<string, unknown> = {}) {
  return HANDLERS.createSession!(ctx({ principal: alice, body }), { ...d, newId: () => 'sid-fb' });
}

describe('createSession under the operator fallback', () => {
  it('creates a session for a subject with no inference credential, and the turn spends the operator key', async () => {
    const d = makeDeps({ withStreams: true, config: fallbackConfig });
    const res = await create(d);
    expect(res.status).toBe(201);
    const token = (res.body as { token: string }).token;
    const ex = await exchangeCredential(token, d);
    expect(ex.anthropicAuthToken).toBe('op-gw-token'); // notsecret
    expect(ex.anthropicBaseUrl).toBe('https://gateway.example');
    const audit = d.streams.get('sh:cp:audit') ?? [];
    expect(
      audit.some((r) => r.decision === 'session_created' && r.credential === 'operator-fallback'),
    ).toBe(true);
    expect(audit.some((r) => r.decision === 'operator_fallback_used')).toBe(true);
  });

  it("uses the subject's own credential when there is one, fallback or not", async () => {
    const d = makeDeps({ config: fallbackConfig });
    await seedCredential(d);
    const token = ((await create(d)).body as { token: string }).token;
    const ex = await exchangeCredential(token, d);
    expect(ex.anthropicAuthToken).not.toBe('op-gw-token'); // notsecret
  });

  it('still refuses a subject with no credential when the fallback is off', async () => {
    const d = makeDeps({ config: { ...fallbackConfig, allowOperatorFallback: false } });
    expect(await codeOf(() => create(d))).toBe('credential_required');
  });

  it('still refuses when the fallback is on but no operator token is configured', async () => {
    const d = makeDeps({ config: { ...fallbackConfig, operatorInferenceToken: undefined } });
    expect(await codeOf(() => create(d))).toBe('credential_required');
  });

  it('never falls back for an explicitly named credential that does not exist', async () => {
    const d = makeDeps({ config: fallbackConfig });
    expect(await codeOf(() => create(d, { credentials: { inference: 'nope' } }))).toBe(
      'credential_not_found',
    );
  });
});
