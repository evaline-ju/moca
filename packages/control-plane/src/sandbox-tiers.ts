/**
 * The deployment's sandbox tiers (P6.3 spec §3.3): what a session may ask for at creation, and the
 * default it gets otherwise. A copy of the harness's parser rather than an import -- this package
 * does not depend on the harness -- held to the same behaviour by the shared fixture
 * harness/test/fixtures/sandbox-tiers-cases.json (test/sandbox-tiers.test.ts).
 */

export interface SandboxTiers {
  names: string[];
  default: string;
}

/** A Kubernetes label value: what an operator can put in SANDBOX_TIER and a manifest label alike. */
const TIER_NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;

/**
 * Read SH_SANDBOX_TIERS / SH_SANDBOX_DEFAULT_TIER. Null means the deployment declares no tiers, and
 * nothing is filtered. Throws, naming the variable, on a configuration that cannot be served: a
 * silently ignored typo here would put every session in "no tier" and defeat the whole slice.
 */
export function parseSandboxTiers(env: NodeJS.ProcessEnv): SandboxTiers | null {
  const names = (env.SH_SANDBOX_TIERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return null;
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`SH_SANDBOX_TIERS names '${dup}' twice`);
  const bad = names.find((n) => !TIER_NAME.test(n));
  if (bad) {
    throw new Error(
      `SH_SANDBOX_TIERS: '${bad}' is not a tier name (letters, digits, '.', '_' and '-', at most 63)`,
    );
  }
  const def = env.SH_SANDBOX_DEFAULT_TIER?.trim() || (names.length === 1 ? names[0] : '');
  if (!def) {
    throw new Error(
      'SH_SANDBOX_DEFAULT_TIER is required when SH_SANDBOX_TIERS names more than one tier',
    );
  }
  if (!names.includes(def)) {
    throw new Error(
      `SH_SANDBOX_DEFAULT_TIER='${def}' is not one of SH_SANDBOX_TIERS (${names.join(', ')})`,
    );
  }
  return { names, default: def };
}
