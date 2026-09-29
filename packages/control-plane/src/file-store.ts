import { accessSync, constants, mkdirSync } from 'node:fs';
import { open as openFile, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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

/**
 * Credentials as one JSON file per subject in a local directory: the store for a deployment with no
 * Kubernetes and no Vault -- the Docker Compose trial (#348), whose directory is a named volume so
 * credentials survive `docker compose down`. NOT for anything multi-host: the directory is only as
 * durable and as private as the disk under it.
 *
 * The file is `<dir>/<subjectHash>.json` (subject-document.ts), so every access opens one file by
 * exact name and no code path ever reads the directory listing -- the same "no enumerate" property
 * the Kubernetes store gets from its list-free Role (spec §6.5). Only the `sealed` field is secret,
 * and it is envelope-encrypted, so a copy of the volume without SH_CREDENTIAL_KEK yields ciphertext.
 *
 * A write is write-temp + fsync + rename, so a crash leaves the old document or the new one, never a
 * torn one. Read-modify-write is serialized PER SUBJECT inside this process; two control-plane
 * processes sharing one directory would lose updates, and that topology is not supported (compose
 * runs exactly one).
 */
export class FileCredentialStore implements CredentialStore {
  private readonly dir: string;
  private readonly keks: Buffer[];
  private readonly queue = new SubjectQueue();

  /**
   * Creates the directory (0700) if needed and checks it is writable NOW, so a missing or read-only
   * volume fails the control plane at startup rather than on some user's first credential write.
   */
  constructor(opts: { dir: string; keks: Buffer[] }) {
    if (!opts.dir) throw new Error('SH_CREDENTIAL_DIR is required for the file credential store');
    this.dir = opts.dir;
    this.keks = opts.keks;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    accessSync(this.dir, constants.W_OK | constants.X_OK);
  }

  private path(subject: string): string {
    return join(this.dir, `${subjectHash(subject)}.json`);
  }

  private async read(subject: string): Promise<SubjectDocument | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(subject), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new CpError('credential_unavailable', 'the credential store is not answering');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CpError('credential_unavailable', 'the credential store returned a non-JSON body');
    }
    return parseDocument(parsed);
  }

  private async write(subject: string, doc: SubjectDocument): Promise<void> {
    const final = this.path(subject);
    const tmp = `${final}.${randomUUID()}.tmp`;
    try {
      // 0600 from the first byte: `open` with a mode, never write-then-chmod.
      const fh = await openFile(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(JSON.stringify(doc));
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, final);
    } catch {
      await unlink(tmp).catch(() => undefined);
      throw new CpError('credential_unavailable', 'the credential store is not answering');
    }
  }

  async put(subject: string, cred: StoredCredential): Promise<void> {
    await this.queue.run(subject, async () => {
      const doc = (await this.read(subject)) ?? emptyDocument();
      await this.write(subject, withCredential(doc, this.keks, subject, cred));
    });
  }

  async get(subject: string, name: string): Promise<StoredCredential | null> {
    const doc = await this.read(subject);
    return doc ? readCredential(doc, this.keks, subject, name) : null;
  }

  async list(subject: string): Promise<CredentialDescriptor[]> {
    const doc = await this.read(subject);
    return doc ? describeAll(doc) : [];
  }

  async delete(subject: string, name: string): Promise<void> {
    await this.queue.run(subject, async () => {
      const doc = await this.read(subject);
      if (!doc || !Object.hasOwn(doc.credentials, name)) return;
      await this.write(subject, withoutCredential(doc, name));
    });
  }
}
