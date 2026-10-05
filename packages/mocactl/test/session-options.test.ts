import { describe, expect, it } from 'vitest';
import {
  SESSION_OPTION_FIELDS,
  checkPreset,
  parseOptionFlags,
  resolveSessionOptions,
  fieldRefusedByServer,
  sandboxTierField,
} from '../src/core/session-options.js';
import { ApiError } from '../src/api/errors.js';
import { credential, fakeControlPlane } from './helpers/fakes.js';

const api = (...names: string[]) =>
  fakeControlPlane({
    listCredentials: async () => [
      ...names.map((n) => credential(n)),
      credential('gh', { consumer: 'sandbox-egress' }),
    ],
  });

describe('resolveSessionOptions', () => {
  it('leaves the inference credential to the server when there is none (#368: the operator fallback)', async () => {
    const r = await resolveSessionOptions(api(), SESSION_OPTION_FIELDS, {}, {});
    expect(r).toEqual({ status: 'ready', values: {}, request: {} });
  });

  it('is blocked when the named credential does not exist and there is none at all', async () => {
    const r = await resolveSessionOptions(
      api(),
      SESSION_OPTION_FIELDS,
      { inferenceCredential: 'x' },
      {},
    );
    expect(r.status).toBe('blocked');
    if (r.status === 'blocked') expect(r.field.emptyHint).toMatch(/add an inference credential/);
  });

  it('maps the server refusing a credential-less session back to the field that needs one', () => {
    const refused = new ApiError('control-plane', 400, 'credential_required', 'no credential');
    expect(fieldRefusedByServer(refused, SESSION_OPTION_FIELDS)?.key).toBe('inferenceCredential');
    expect(
      fieldRefusedByServer(new ApiError('control-plane', 500, 'internal'), SESSION_OPTION_FIELDS),
    ).toBeUndefined();
    expect(
      fieldRefusedByServer(new Error('credential_required'), SESSION_OPTION_FIELDS),
    ).toBeUndefined();
  });

  it('maps a refusal to the field by its refusal code, whatever the field order', () => {
    const refused = new ApiError('control-plane', 400, 'credential_required', 'no credential');
    const reversed = [...SESSION_OPTION_FIELDS].reverse();
    expect(reversed[0].key).toBe('sandboxTier');
    expect(fieldRefusedByServer(refused, reversed)?.key).toBe('inferenceCredential');
    // The tier field may also be left to the server, but no refusal is about it.
    expect(fieldRefusedByServer(refused, [sandboxTierField])).toBeUndefined();
  });

  it('picks the only inference credential silently, ignoring other consumers', async () => {
    const r = await resolveSessionOptions(api('anthropic'), SESSION_OPTION_FIELDS, {}, {});
    expect(r).toMatchObject({
      status: 'ready',
      request: { credentials: { inference: 'anthropic' } },
    });
  });

  it('asks when there are several, defaulting to the last one used', async () => {
    const r = await resolveSessionOptions(
      api('a', 'b'),
      SESSION_OPTION_FIELDS,
      {},
      { inferenceCredential: 'b' },
    );
    expect(r.status).toBe('needs-input');
    if (r.status === 'needs-input') {
      expect(r.choices.map((c) => c.value)).toEqual(['a', 'b']);
      expect(r.defaultValue).toBe('b');
    }
  });

  it('is ready once the value is given', async () => {
    const r = await resolveSessionOptions(
      api('a', 'b'),
      SESSION_OPTION_FIELDS,
      { inferenceCredential: 'a' },
      {},
    );
    expect(r).toMatchObject({ status: 'ready', values: { inferenceCredential: 'a' } });
  });

  it('asks again when the given value no longer exists', async () => {
    const r = await resolveSessionOptions(
      api('a', 'b'),
      SESSION_OPTION_FIELDS,
      { inferenceCredential: 'gone' },
      {},
    );
    expect(r.status).toBe('needs-input');
  });

  it('asks even for a single choice when a different, missing value was given', async () => {
    const r = await resolveSessionOptions(
      api('a'),
      SESSION_OPTION_FIELDS,
      { inferenceCredential: 'gone' },
      {},
    );
    expect(r.status).toBe('needs-input');
  });
});

describe('sandboxTierField (P6.3)', () => {
  const api = (sandboxTiers: { names: string[]; default: string } | null) =>
    fakeControlPlane({ discovery: async () => ({ harnessUrl: null, sandboxTiers }) });

  it('offers the declared tiers, marking the default', async () => {
    expect(
      await sandboxTierField.source(api({ names: ['container', 'microvm'], default: 'container' })),
    ).toEqual([
      { value: 'container', label: 'container', isDefault: true },
      { value: 'microvm', label: 'microvm' },
    ]);
  });

  it('is skipped entirely when the deployment declares no tiers', async () => {
    const r = await resolveSessionOptions(api(null), [sandboxTierField], {}, {});
    expect(r).toEqual({ status: 'ready', values: {}, request: {} });
  });

  it('interactive: asks, preselecting the server default when nothing was used last', async () => {
    const r = await resolveSessionOptions(
      api({ names: ['container', 'microvm'], default: 'microvm' }),
      [sandboxTierField],
      {},
      {},
    );
    expect(r.status).toBe('needs-input');
    expect(r.status === 'needs-input' && r.defaultValue).toBe('microvm');
  });

  it('NON-interactive: an omitted tier is left to the server default, never a refusal', async () => {
    const r = await resolveSessionOptions(
      api({ names: ['container', 'microvm'], default: 'container' }),
      [sandboxTierField],
      {},
      {},
      { interactive: false },
    );
    expect(r).toEqual({ status: 'ready', values: {}, request: {} });
  });

  it('a given tier goes into the request as sandbox.tier', async () => {
    const r = await resolveSessionOptions(
      api({ names: ['container', 'microvm'], default: 'container' }),
      [sandboxTierField],
      { sandboxTier: 'microvm' },
      {},
    );
    expect(r).toMatchObject({ status: 'ready', request: { sandbox: { tier: 'microvm' } } });
  });

  it('a tier used last beats the server default as the preselection', async () => {
    const r = await resolveSessionOptions(
      api({ names: ['container', 'microvm'], default: 'container' }),
      [sandboxTierField],
      {},
      { sandboxTier: 'microvm' },
    );
    expect(r.status === 'needs-input' && r.defaultValue).toBe('microvm');
  });

  it('skips the field when the control plane predates /v1/discovery (a 404, with --harness-url)', async () => {
    const cp = fakeControlPlane({
      discovery: async () => {
        throw new ApiError('control-plane', 404, 'http_404');
      },
      listCredentials: async () => [credential('anthropic')],
    });
    const r = await resolveSessionOptions(cp, SESSION_OPTION_FIELDS, {}, {});
    expect(r).toEqual({
      status: 'ready',
      values: { inferenceCredential: 'anthropic' },
      request: { credentials: { inference: 'anthropic' } },
    });
  });

  it('lets any other discovery failure propagate', async () => {
    const cp = fakeControlPlane({
      discovery: async () => {
        throw new ApiError('control-plane', 500, 'internal_error');
      },
    });
    await expect(resolveSessionOptions(cp, [sandboxTierField], {}, {})).rejects.toMatchObject({
      status: 500,
      code: 'internal_error',
    });
  });

  it('a given tier on a deployment with none is blocked, saying so', async () => {
    const r = await resolveSessionOptions(
      api(null),
      [sandboxTierField],
      { sandboxTier: 'microvm' },
      {},
    );
    expect(r.status).toBe('blocked');
    expect(r.status === 'blocked' && r.field.emptyHint).toContain('declares no sandbox tiers');
  });
});

describe('presets', () => {
  it('splits known fields from stale ones', () => {
    expect(
      checkPreset(
        { name: 'p', values: { inferenceCredential: 'a', model: 'x' } },
        SESSION_OPTION_FIELDS,
      ),
    ).toEqual({
      values: { inferenceCredential: 'a' },
      stale: ['model'],
    });
  });
});

describe('parseOptionFlags', () => {
  it('parses key=value pairs, keeping = in values', () => {
    expect(parseOptionFlags(['inferenceCredential=a', 'x=b=c'])).toEqual({
      inferenceCredential: 'a',
      x: 'b=c',
    });
  });

  it('rejects a flag without =', () => {
    expect(() => parseOptionFlags(['oops'])).toThrow('--option expects key=value, got "oops"');
  });
});
