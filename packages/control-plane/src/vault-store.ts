import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { CpError } from './errors.js';
import type {
  CredentialDescriptor,
  CredentialStore,
  StoredCredential,
} from './credential-store.js';
import {
  describeAll,
  emptyDocument,
  parseDocument,
  readCredential,
  subjectHash,
  SubjectQueue,
  withCredential,
  withoutCredential,
  type SubjectDocument,
} from './subject-document.js';

/** Structural subset of fetch, so tests inject a fake Vault and no test touches the network. */
export type VaultFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface VaultStoreOptions {
  /** `VAULT_ADDR`, e.g. `https://vault.internal:8200`. */
  addr: string;
  /** Called per request, so a token file rewritten by Vault Agent is picked up without a restart. */
  token: () => string | Promise<string>;
  /** `VAULT_NAMESPACE` (Vault Enterprise / HCP); omitted from requests when unset. */
  namespace?: string;
  /** The KV v2 mount (`SH_VAULT_KV_MOUNT`, default `secret`). */
  mount: string;
  /** Path under the mount (`SH_VAULT_PATH`, default `moca/credentials`). */
  prefix: string;
  keks: Buffer[];
  fetch?: VaultFetch;
}

/** How many times a write re-reads and retries after losing a check-and-set race. */
const CAS_ATTEMPTS = 5;

const trimSlashes = (s: string): string => {
  // Loops, not /^\/+|\/+$/g: that regex is quadratic on a long run of slashes (CodeQL
  // js/polynomial-redos), the same reason main.ts's urlEnv trims by hand.
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 0x2f) start++;
  while (end > start && s.charCodeAt(end - 1) === 0x2f) end--;
  return s.slice(start, end);
};

/**
 * Credentials in HashiCorp Vault's KV v2 engine: the store for a VM deployment (test, staging,
 * production) that has no Kubernetes to hold Secrets in.
 *
 * Layout: one KV secret per subject at `<mount>/data/<prefix>/<subjectHash>`, whose value is the
 * shared subject document (subject-document.ts). So, as with the Kubernetes store:
 * - every access is a read or write of ONE path named by the subject's hash, so the Vault policy
 *   needs no `list` capability and a bug or an injection cannot enumerate users (spec §6.5); the
 *   minimum policy is `path "<mount>/data/<prefix>/*" { capabilities = ["create", "read", "update"] }`;
 * - the secret half is still envelope-encrypted under SH_CREDENTIAL_KEK. Vault encrypts at rest
 *   too, but a token that can READ this path must still yield only ciphertext, and a token that can
 *   WRITE it must still be unable to relabel one subject's ciphertext as another's (the AAD).
 *
 * Writes are read-modify-write with KV v2 CHECK-AND-SET (`options.cas` = the version read), so two
 * concurrent writes for one subject cannot silently drop each other's credential -- the lost-update
 * failure spec §6.6 rejects a single shared Secret over. A lost race re-reads and retries.
 *
 * Authentication is a Vault token: `VAULT_TOKEN`, or `VAULT_TOKEN_FILE`, re-read per request, which
 * is the Vault Agent sink pattern -- the agent does the login (AppRole, cloud IAM, ...) and the
 * renewal, and this store never holds a long-lived credential of its own. TLS to a private CA is
 * Node's `NODE_EXTRA_CA_CERTS`.
 */
export class VaultCredentialStore implements CredentialStore {
  private readonly base: string;
  private readonly token: () => string | Promise<string>;
  private readonly namespace?: string;
  private readonly keks: Buffer[];
  private readonly fetchImpl: VaultFetch;
  private readonly queue = new SubjectQueue();

  constructor(opts: VaultStoreOptions) {
    if (!opts.addr) throw new Error('VAULT_ADDR is required for the vault credential store');
    let u: URL;
    try {
      u = new URL(opts.addr);
    } catch {
      throw new Error(`VAULT_ADDR must be an absolute http(s) URL, got "${opts.addr}"`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      throw new Error(`VAULT_ADDR must be an absolute http(s) URL, got "${opts.addr}"`);
    const mount = trimSlashes(opts.mount);
    const prefix = trimSlashes(opts.prefix);
    if (!mount) throw new Error('SH_VAULT_KV_MOUNT must not be empty');
    if (!prefix) throw new Error('SH_VAULT_PATH must not be empty');
    // Keeps a path on VAULT_ADDR, for a Vault served behind a reverse proxy under a sub-path.
    const addrPath = trimSlashes(u.pathname);
    this.base = `${u.origin}${addrPath ? `/${addrPath}` : ''}/v1/${mount}/data/${prefix}`;
    this.token = opts.token;
    this.namespace = opts.namespace || undefined;
    this.keks = opts.keks;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as VaultFetch);
  }

  private url(subject: string): string {
    return `${this.base}/${subjectHash(subject)}`;
  }

  private async headers(): Promise<Record<string, string>> {
    let token: string;
    try {
      token = await this.token();
    } catch {
      // An unreadable VAULT_TOKEN_FILE: the store is not answering, and the path (which may name a
      // secret's location) stays out of the caller's error.
      throw new CpError('credential_unavailable', 'the credential store is not answering');
    }
    return {
      'X-Vault-Token': token,
      'Content-Type': 'application/json',
      ...(this.namespace ? { 'X-Vault-Namespace': this.namespace } : {}),
    };
  }

  /**
   * One HTTP call, with every transport or server failure typed as `credential_unavailable` (503).
   * The message never carries Vault's response body, which can echo a path or a policy name.
   */
  private async call(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const headers = await this.headers();
    let res: { status: number; text(): Promise<string> };
    let text: string;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      text = await res.text();
    } catch {
      throw new CpError('credential_unavailable', 'the credential store is not answering');
    }
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new CpError(
          'credential_unavailable',
          'the credential store returned a non-JSON body',
        );
      }
    }
    return { status: res.status, json };
  }

  /** The subject's document and its KV version; version 0 means "no secret at this path yet". */
  private async read(subject: string): Promise<{ doc: SubjectDocument | null; version: number }> {
    const { status, json } = await this.call('GET', this.url(subject));
    const data = (json as { data?: { data?: unknown; metadata?: { version?: unknown } } } | null)
      ?.data;
    const version = typeof data?.metadata?.version === 'number' ? data.metadata.version : 0;
    // 404 is "absent". Vault also answers 404 -- WITH metadata -- when the latest version was
    // soft-deleted out of band; its version is still the one a check-and-set write must name.
    if (status === 404) return { doc: null, version };
    if (status !== 200) {
      throw new CpError('credential_unavailable', `the credential store answered ${status}`);
    }
    if (data?.data === undefined || data.data === null) return { doc: null, version };
    return { doc: parseDocument(data.data), version };
  }

  /**
   * Read, apply `change`, write back under check-and-set. `change` returning null means "nothing to
   * write" (a delete of an absent name).
   */
  private async update(
    subject: string,
    change: (doc: SubjectDocument | null) => SubjectDocument | null,
  ): Promise<void> {
    return this.queue.run(subject, () => this.updateOnce(subject, change));
  }

  private async updateOnce(
    subject: string,
    change: (doc: SubjectDocument | null) => SubjectDocument | null,
  ): Promise<void> {
    for (let attempt = 1; attempt <= CAS_ATTEMPTS; attempt++) {
      const { doc, version } = await this.read(subject);
      const next = change(doc);
      if (!next) return;
      const { status, json } = await this.call('POST', this.url(subject), {
        options: { cas: version },
        data: next,
      });
      if (status === 200 || status === 204) return;
      if (status === 400 && isCasMismatch(json)) continue;
      throw new CpError('credential_unavailable', `the credential store answered ${status}`);
    }
    throw new CpError(
      'credential_unavailable',
      'the credential store kept losing a concurrent-write race; retry',
    );
  }

  async put(subject: string, cred: StoredCredential): Promise<void> {
    await this.update(subject, (doc) =>
      withCredential(doc ?? emptyDocument(), this.keks, subject, cred),
    );
  }

  async get(subject: string, name: string): Promise<StoredCredential | null> {
    const { doc } = await this.read(subject);
    return doc ? readCredential(doc, this.keks, subject, name) : null;
  }

  async list(subject: string): Promise<CredentialDescriptor[]> {
    const { doc } = await this.read(subject);
    return doc ? describeAll(doc) : [];
  }

  async delete(subject: string, name: string): Promise<void> {
    await this.update(subject, (doc) =>
      doc && Object.hasOwn(doc.credentials, name) ? withoutCredential(doc, name) : null,
    );
  }
}

/** KV v2's check-and-set refusal. Matched on its text: Vault gives it no distinct code or status. */
function isCasMismatch(json: unknown): boolean {
  const errors = (json as { errors?: unknown } | null)?.errors;
  return (
    Array.isArray(errors) && errors.some((e) => typeof e === 'string' && /check-and-set/.test(e))
  );
}

/** `VAULT_TOKEN`, or the CURRENT contents of `VAULT_TOKEN_FILE` -- exactly one of them. */
export function vaultTokenSource(env: NodeJS.ProcessEnv): () => string | Promise<string> {
  const direct = env.VAULT_TOKEN;
  const file = env.VAULT_TOKEN_FILE;
  if (direct && file) {
    throw new Error('set VAULT_TOKEN or VAULT_TOKEN_FILE, not both');
  }
  if (direct) return () => direct;
  if (file) {
    const check = (raw: string): string => {
      const t = raw.trim();
      if (!t) throw new Error(`VAULT_TOKEN_FILE ${file} is empty`);
      return t;
    };
    // Read once now, synchronously, so an unreadable or empty file fails STARTUP with its name in
    // the log. Per request it is an async read, so a slow disk never blocks the event loop.
    check(readFileSync(file, 'utf8'));
    return async () => check(await readFile(file, 'utf8'));
  }
  throw new Error('the vault credential store needs VAULT_TOKEN or VAULT_TOKEN_FILE');
}
