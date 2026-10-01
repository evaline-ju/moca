import type { ControlPlaneApi, CreateSessionRequest } from '../api/types.js';
import type { Preset } from '../config.js';
import { ApiError } from '../api/errors.js';
import { sanitizeRemote } from './sanitize.js';

// Spec §7.3. Supporting a new session-time parameter (a model, a sandbox selector) is one more
// entry in SESSION_OPTION_FIELDS; the New Session overlay, presets and `run --option` all read it.

export interface Choice {
  value: string;
  label: string;
}

export interface SessionOptionField {
  key: string;
  label: string;
  emptyHint: string;
  /**
   * With no choice to offer, leave the field unset and let the server decide rather than block: the
   * control plane may have a default (the operator fallback, #368). A server refusal comes back as
   * `credential_required` and is mapped to `emptyHint` by fieldRefusedByServer.
   */
  serverMayResolve?: boolean;
  source(api: ControlPlaneApi): Promise<Choice[]>;
  toRequest(value: string, req: CreateSessionRequest): CreateSessionRequest;
}

export const inferenceCredentialField: SessionOptionField = {
  key: 'inferenceCredential',
  label: 'Inference credential',
  emptyHint: 'add an inference credential to start',
  serverMayResolve: true,
  async source(api) {
    return (await api.listCredentials())
      .filter((c) => c.consumer === 'inference')
      .map((c) => {
        // The picker's label is shown terminal-safe; `value` stays the raw name, which is the id
        // sent back to the server.
        const name = sanitizeRemote(c.name);
        return {
          value: c.name,
          label: c.endpoint ? `${name}  ${sanitizeRemote(c.endpoint)}` : name,
        };
      });
  },
  toRequest: (value, req) => ({ ...req, credentials: { ...req.credentials, inference: value } }),
};

export const SESSION_OPTION_FIELDS: readonly SessionOptionField[] = [inferenceCredentialField];

export type Resolution =
  | { status: 'ready'; values: Record<string, string>; request: CreateSessionRequest }
  | {
      status: 'needs-input';
      field: SessionOptionField;
      choices: Choice[];
      defaultValue?: string;
      values: Record<string, string>;
    }
  | { status: 'blocked'; field: SessionOptionField; values: Record<string, string> };

export async function resolveSessionOptions(
  api: ControlPlaneApi,
  fields: readonly SessionOptionField[],
  given: Record<string, string>,
  lastUsed: Record<string, string>,
): Promise<Resolution> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const choices = await field.source(api);
    const wanted = given[field.key];
    if (wanted !== undefined && choices.some((c) => c.value === wanted)) {
      values[field.key] = wanted;
      continue;
    }
    if (choices.length === 0) {
      if (field.serverMayResolve && wanted === undefined) continue;
      return { status: 'blocked', field, values };
    }
    if (choices.length === 1 && wanted === undefined) {
      values[field.key] = choices[0].value;
      continue;
    }
    const last = lastUsed[field.key];
    return {
      status: 'needs-input',
      field,
      choices,
      defaultValue: choices.some((c) => c.value === last) ? last : undefined,
      values,
    };
  }
  let request: CreateSessionRequest = {};
  for (const field of fields) {
    if (values[field.key] !== undefined) request = field.toRequest(values[field.key], request);
  }
  return { status: 'ready', values, request };
}

/**
 * The field a `POST /v1/sessions` refusal is about, when the server declined to resolve one the
 * client left to it (serverMayResolve): the caller then shows that field's emptyHint, as if blocked.
 */
export function fieldRefusedByServer(
  err: unknown,
  fields: readonly SessionOptionField[],
): SessionOptionField | undefined {
  if (!(err instanceof ApiError) || err.code !== 'credential_required') return undefined;
  return fields.find((f) => f.serverMayResolve);
}

export function checkPreset(
  preset: Preset,
  fields: readonly SessionOptionField[],
): { values: Record<string, string>; stale: string[] } {
  const known = new Set(fields.map((f) => f.key));
  const values: Record<string, string> = {};
  const stale: string[] = [];
  for (const [k, v] of Object.entries(preset.values)) {
    if (known.has(k)) values[k] = v;
    else stale.push(k);
  }
  return { values, stale };
}

export function parseOptionFlags(flags: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flags) {
    const eq = f.indexOf('=');
    if (eq <= 0) throw new Error(`--option expects key=value, got "${f}"`);
    out[f.slice(0, eq)] = f.slice(eq + 1);
  }
  return out;
}
