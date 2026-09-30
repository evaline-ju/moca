import type { CredentialConsumer, PutCredentialRequest } from '../../api/types.js';
import type { FormField } from '../Form.js';

// A friendly form for the documented kinds; the server's registry stays authoritative, and an
// unknown kind falls back to free-form key=value pairs (spec §2.5, §6.4).
export const KNOWN_KINDS: Record<string, string[]> = {
  bearer: ['token'],
  basic: ['username', 'password'],
  'api-key': ['key'],
  'oauth2-token': ['accessToken'],
};

const CONSUMERS: CredentialConsumer[] = ['inference', 'sandbox-egress', 'control-plane'];
export const CREDENTIAL_NAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

const LABELS: Record<string, string> = {
  token: 'Token',
  username: 'Username',
  password: 'Password',
  key: 'API key',
  accessToken: 'Access token',
};

// Kinds the server sends as `Authorization: Bearer`; `api-key` goes as x-api-key (#368).
const BEARER_KINDS = new Set(['bearer', 'oauth2-token']);
const ANTHROPIC_API_HOST = 'api.anthropic.com';

/**
 * The control plane's write-time inference checks (credential-store.ts, #368), mirrored so the form
 * says what to change before submitting. The server stays authoritative; an unknown kind is left to
 * it. Messages name key PREFIXES only, never the value.
 */
function inferenceShapeProblem(values: Record<string, string>): string | undefined {
  const fields = KNOWN_KINDS[values.kind];
  if (!fields || fields.length !== 1) return undefined;
  const secret = values[fields[0]!] ?? '';
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

export function credentialFields(): FormField[] {
  const secretFields = [...new Set(Object.values(KNOWN_KINDS).flat())];
  return [
    {
      key: 'name',
      label: 'Name',
      hint: 'lower-case letters, digits and dashes, e.g. anthropic-work',
    },
    {
      key: 'kind',
      label: 'Kind',
      initial: 'bearer',
      suggestions: Object.keys(KNOWN_KINDS),
      hint: 'inference: bearer for a gateway token (LiteLLM etc.), api-key for an Anthropic API key (sk-ant-api…)',
    },
    { key: 'consumer', label: 'Consumer', initial: 'inference', suggestions: CONSUMERS },
    {
      key: 'hosts',
      label: 'Destination hosts',
      hint: 'comma-separated host allow-list, e.g. api.anthropic.com',
    },
    {
      key: 'endpoint',
      label: 'Gateway endpoint',
      optional: true,
      hint: 'the model gateway base URL, as for ANTHROPIC_BASE_URL — no /v1, e.g. https://litellm.internal, or https://api.anthropic.com for kind api-key; empty uses the deployment default',
      visible: (v) => v.consumer === 'inference',
    },
    ...secretFields.map((key) => ({
      key,
      label: LABELS[key] ?? key,
      masked: true,
      visible: (v: Record<string, string>) => (KNOWN_KINDS[v.kind] ?? []).includes(key),
    })),
    {
      key: 'secretPairs',
      label: 'Secret fields',
      masked: true,
      hint: 'key=value, key=value — the fields this kind requires',
      visible: (v) => !(v.kind in KNOWN_KINDS),
    },
  ];
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

export function validateCredential(values: Record<string, string>): string | undefined {
  if (!CREDENTIAL_NAME.test(values.name ?? ''))
    return 'name: lower-case letters, digits and dashes, 1-40 characters';
  if (!CONSUMERS.includes(values.consumer as CredentialConsumer))
    return `consumer must be one of ${CONSUMERS.join(', ')}`;
  if (parseHosts(values.hosts ?? '').length === 0)
    return 'destination hosts: at least one host is required';
  const fields = KNOWN_KINDS[values.kind];
  if (values.consumer === 'inference') {
    if (fields) {
      if (fields.length !== 1) {
        return `an inference credential needs a single-secret kind; '${values.kind}' has ${fields.length} (${fields.join(', ')})`;
      }
    } else {
      const pairs = Object.keys(parsePairs(values.secretPairs ?? ''));
      if (pairs.length !== 1) {
        return `an inference credential needs a single-secret kind; '${values.kind}' has ${pairs.length} (${pairs.join(', ')})`;
      }
    }
  }
  return values.consumer === 'inference' ? inferenceShapeProblem(values) : undefined;
}

export function toPutRequest(values: Record<string, string>): {
  name: string;
  req: PutCredentialRequest;
} {
  const known = KNOWN_KINDS[values.kind];
  const secret = known
    ? Object.fromEntries(known.map((k) => [k, values[k] ?? '']))
    : parsePairs(values.secretPairs ?? '');
  const hosts = parseHosts(values.hosts ?? '');
  const consumer = values.consumer as CredentialConsumer;
  const req: PutCredentialRequest = { kind: values.kind, consumer, destination: { hosts }, secret };
  if (consumer === 'inference' && values.endpoint?.trim()) req.endpoint = values.endpoint.trim();
  return { name: values.name, req };
}
