import { describe, expect, it } from 'vitest';
import {
  SESSION_OPTION_FIELDS,
  checkPreset,
  parseOptionFlags,
  resolveSessionOptions,
  fieldRefusedByServer,
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
