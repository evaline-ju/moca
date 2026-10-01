import type { CredentialConsumer, PutCredentialRequest } from '../api/types.js';

// The documented kinds and their secret fields; the server's registry stays authoritative, and an
// unknown kind falls back to free-form key=value pairs (spec §2.5, §6.4). The TUI form
// (views/overlays/credential-form.ts) and `mocactl credentials add` both check with these.
export const KNOWN_KINDS: Record<string, string[]> = {
  bearer: ['token'],
  basic: ['username', 'password'],
  'api-key': ['key'],
  'oauth2-token': ['accessToken'],
};

export const CONSUMERS: CredentialConsumer[] = ['inference', 'sandbox-egress', 'control-plane'];
export const CREDENTIAL_NAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

// Kinds the server sends as `Authorization: Bearer`; `api-key` goes as x-api-key (#368).
const BEARER_KINDS = new Set(['bearer', 'oauth2-token']);
const ANTHROPIC_API_HOST = 'api.anthropic.com';

/**
 * The control plane's write-time inference checks (credential-store.ts, #368), mirrored so the form
 * and the CLI say what to change before submitting. The server stays authoritative; an unknown
 * kind is left to it. Messages name key PREFIXES only, never the value.
 */
function inferenceShapeProblem(
  values: Record<string, string>,
  secretFields: Record<string, string>,
): string | undefined {
  const fields = KNOWN_KINDS[values.kind];
  if (!fields || fields.length !== 1) return undefined;
  const secret = secretFields[fields[0]!] ?? '';
  const bearer = BEARER_KINDS.has(values.kind);
  const endpoint = values.endpoint?.trim() ?? '';
  if (secret.startsWith('sk-ant-oat')) {
    return 'Anthropic OAuth tokens (sk-ant-oat…) are not supported: use an API key (sk-ant-api…) with kind api-key';
  }
  if (bearer && secret.startsWith('sk-ant-api')) {
    return 'an Anthropic API key (sk-ant-api…) is sent as x-api-key: choose kind api-key, endpoint https://api.anthropic.com';
  }
  if (!endpoint) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'endpoint must be an absolute URL, e.g. https://api.anthropic.com';
  }
  if (url.hostname !== ANTHROPIC_API_HOST) return undefined;
  if (bearer) return `${ANTHROPIC_API_HOST} reads API keys from x-api-key: choose kind api-key`;
  if (url.pathname !== '/' || url.search !== '') {
    return `use https://${ANTHROPIC_API_HOST} as the endpoint (no /v1)`;
  }
  return undefined;
}

function parseHosts(text: string): string[] {
  return text
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
}

function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** The form's secret: a known kind's own fields, or the free-form `secretPairs` otherwise. */
function formSecret(values: Record<string, string>): Record<string, string> {
  const known = KNOWN_KINDS[values.kind];
  return known
    ? Object.fromEntries(known.map((k) => [k, values[k] ?? '']))
    : parsePairs(values.secretPairs ?? '');
}

/** The checks that need no secret: name, consumer and hosts. */
export function descriptionProblem(values: Record<string, string>): string | undefined {
  if (!CREDENTIAL_NAME.test(values.name ?? ''))
    return 'name: lower-case letters, digits and dashes, 1-40 characters';
  if (!CONSUMERS.includes(values.consumer as CredentialConsumer))
    return `consumer must be one of ${CONSUMERS.join(', ')}`;
  if (parseHosts(values.hosts ?? '').length === 0)
    return 'destination hosts: at least one host is required';
  return undefined;
}

/**
 * What is wrong with a credential before it is sent, or undefined. `values` holds name, kind,
 * consumer, hosts (comma-separated) and endpoint; `secret` the secret fields, kept apart so the CLI
 * can pass what it read from stdin.
 */
export function credentialProblem(
  values: Record<string, string>,
  secret: Record<string, string>,
): string | undefined {
  const described = descriptionProblem(values);
  if (described || values.consumer !== 'inference') return described;
  const keys = KNOWN_KINDS[values.kind] ?? Object.keys(secret);
  if (keys.length !== 1) {
    return `an inference credential needs a single-secret kind; '${values.kind}' has ${keys.length} (${keys.join(', ')})`;
  }
  return inferenceShapeProblem(values, secret);
}

export function credentialRequest(
  values: Record<string, string>,
  secret: Record<string, string>,
): { name: string; req: PutCredentialRequest } {
  const hosts = parseHosts(values.hosts ?? '');
  const consumer = values.consumer as CredentialConsumer;
  const req: PutCredentialRequest = { kind: values.kind, consumer, destination: { hosts }, secret };
  if (consumer === 'inference' && values.endpoint?.trim()) req.endpoint = values.endpoint.trim();
  return { name: values.name, req };
}

export function validateCredential(values: Record<string, string>): string | undefined {
  return credentialProblem(values, formSecret(values));
}

export function toPutRequest(values: Record<string, string>): {
  name: string;
  req: PutCredentialRequest;
} {
  return credentialRequest(values, formSecret(values));
}

/**
 * The secret `mocactl credentials add` reads from stdin: the whole input for a kind with one secret
 * field (one line, its trailing newline dropped), else one `field=value` per line. A problem
 * names fields only, never a value.
 */
export function secretFromStdin(
  kind: string,
  text: string,
): { secret: Record<string, string> } | { problem: string } {
  const fields = KNOWN_KINDS[kind];
  if (fields?.length === 1) {
    const value = text.replace(/\r?\n$/, '');
    if (!value) return { problem: 'no secret on stdin' };
    if (/[\r\n]/.test(value)) return { problem: `the ${fields[0]} must be one line` };
    return { secret: { [fields[0]!]: value } };
  }
  const secret: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { problem: 'stdin must be one field=value per line' };
    secret[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  const absent = (fields ?? []).filter((f) => !secret[f]);
  if (absent.length > 0) {
    return { problem: `stdin is missing ${absent.map((f) => `${f}=…`).join(', ')}` };
  }
  if (Object.keys(secret).length === 0) return { problem: 'no secret on stdin' };
  return { secret };
}
