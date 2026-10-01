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

describe('a fallback session, later (#368 review)', () => {
  it('stays on the operator key after the subject stores its own: resolved at creation, like any session', async () => {
    // Spec §6.4: a session's credential is resolved once, at creation, so a credential added later
    // cannot change a running session. A new session picks the subject's own credential up.
    const d = makeDeps({ config: fallbackConfig });
    const token = ((await create(d)).body as { token: string }).token;
    await seedCredential(d);
    expect((await exchangeCredential(token, d)).anthropicAuthToken).toBe('op-gw-token'); // notsecret
    const fresh = (
      (
        await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), {
          ...d,
          newId: () => 'sid-own',
        })
      ).body as { token: string }
    ).token;
    expect((await exchangeCredential(fresh, d)).anthropicAuthToken).not.toBe('op-gw-token'); // notsecret
  });

  it('says to start a new session once the fallback is turned off, not "credential \'\'"', async () => {
    const d = makeDeps({ config: fallbackConfig });
    const token = ((await create(d)).body as { token: string }).token;
    d.config.allowOperatorFallback = false;
    let message = '';
    try {
      await exchangeCredential(token, d);
    } catch (e) {
      message = (e as Error).message;
      expect((e as { code: string }).code).toBe('credential_required');
    }
    expect(message).toContain('operator fallback');
    expect(message).toContain('new session');
    expect(message).not.toContain("''");
  });

  it('never moves a session whose own credential was deleted onto the operator key (#411 review)', async () => {
    // The user who deletes a leaked key mid-session: their session must stop, not carry on on the
    // operator's bill. Only a session that recorded NO credential falls back.
    const d = makeDeps({ withStreams: true, config: fallbackConfig });
    await seedCredential(d);
    const token = ((await create(d)).body as { token: string }).token;
    await d.credentials.delete('github:1234', 'my-anthropic');
    let message = '';
    try {
      await exchangeCredential(token, d);
    } catch (e) {
      message = (e as Error).message;
      expect((e as { code: string }).code).toBe('credential_required');
    }
    expect(message).toContain("'my-anthropic'");
    expect(
      (d.streams.get('sh:cp:audit') ?? []).some((r) => r.decision === 'operator_fallback_used'),
    ).toBe(false);
  });

  it("refuses to store a credential named 'operator-fallback', the name the audit gives the operator's key", async () => {
    const res = HANDLERS.putCredential!(
      ctx({
        principal: alice,
        params: { name: 'operator-fallback' },
        body: {
          kind: 'bearer',
          consumer: 'inference',
          destination: { hosts: ['gateway.example'] },
          endpoint: 'https://gateway.example',
          secret: { token: 'mine' }, // notsecret
        },
      }),
      makeDeps(),
    );
    await expect(res).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
