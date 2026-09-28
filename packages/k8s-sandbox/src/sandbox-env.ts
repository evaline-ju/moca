/**
 * The ONLY environment a sandbox command receives from the harness (MI1 §5 R1).
 *
 * Pi's bash tool hands its operations `{ ...process.env, PATH }`, i.e. the whole harness process
 * environment. The harness process is the semi-trusted tier and the sandbox runs model-authored
 * code, so nothing from that environment may cross by default. This allowlist is by NAME and holds
 * only locale/time variables, whose values carry no identity; PATH is excluded on purpose because
 * Pi rewrites it to a harness-host path that is meaningless in the sandbox.
 *
 * Adding a name here is a security decision: the test in sandbox-env.test.ts refuses any name that
 * looks like it could carry a credential.
 */
export const SANDBOX_ENV_ALLOW: readonly string[] = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'];

export function sandboxEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const name of SANDBOX_ENV_ALLOW) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}
