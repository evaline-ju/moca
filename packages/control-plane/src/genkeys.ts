import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { KEK_BYTES } from './envelope.js';
import { keyIdFor, publicKeyToBase64 } from './token.js';

/**
 * The four MU1 secrets a control plane and its harness need, as env-file lines:
 *
 *   SH_SESSION_TOKEN_PRIVATE_KEY  ed25519 signing key, PKCS#8 DER as one line of base64 (control plane)
 *   SH_SESSION_TOKEN_PUBLIC_KEYS  its public half as `<kid>:<base64 SPKI>` (harness / supervisor)
 *   SH_CREDENTIAL_KEK             32 random bytes, base64 (control plane)
 *   SH_EXCHANGE_TOKEN             32 random bytes, hex (both tiers)
 *
 * It exists so a host needs no openssl -- deploy/compose/install.sh runs it in the harness image:
 *
 *   docker run --rm --network none IMAGE node --import tsx src/genkeys.ts
 *
 * Output goes to STDOUT ONLY, never an argv or a file this process picks, so the caller decides
 * where the secrets land (install.sh appends them to a 0600 .env). The public keyset is derived with
 * the same `keyIdFor` the verifier uses, so the two halves cannot disagree about the kid.
 */
export function generateMu1Secrets(): Record<string, string> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  return {
    SH_SESSION_TOKEN_PRIVATE_KEY: der.toString('base64'),
    SH_SESSION_TOKEN_PUBLIC_KEYS: `${keyIdFor(publicKey)}:${publicKeyToBase64(publicKey)}`,
    SH_CREDENTIAL_KEK: randomBytes(KEK_BYTES).toString('base64'),
    SH_EXCHANGE_TOKEN: randomBytes(32).toString('hex'),
  };
}

export function formatEnvLines(secrets: Record<string, string>): string {
  return Object.entries(secrets)
    .map(([k, v]) => `${k}=${v}\n`)
    .join('');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(formatEnvLines(generateMu1Secrets()));
}
