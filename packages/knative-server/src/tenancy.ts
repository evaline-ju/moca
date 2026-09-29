/** The deployment's tenancy mode (MI1 §10.1). Default `single`; anything else is a boot failure. */
export type Tenancy = 'single' | 'multi';

const CORE = 'TENANCY';
// The prefixes an operator might reach for: this package's knobs are SH_-prefixed, and the repo
// was kagenti before it was MOCA.
const PREFIXES = ['MOCA', 'KAGENTI', 'SH'];

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (a.length < b.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Whether `name` looks like an attempt at MOCA_TENANCY without being it. Case, separators and
 * whitespace are ignored and one known prefix is stripped; what remains is refused when it is within
 * one edit of TENANCY (`MOCA_TENENCY`, `MOCA_TENNANCY`, `SH_TENANCY`, `MOCA__TENANCY`, `TENANCY`) or
 * starts with it (`MOCA_TENANCY_MODE`). One edit, not two, so an unrelated `TENANT` is left alone.
 *
 * The `MOCA_TENANCY_*` names are therefore reserved: a leftover such as `MOCA_TENANCY_OLD` is a
 * boot failure too, and the fix is to unset it. A variable that silently fails to set tenancy costs
 * every `multi` protection; one that refuses to boot costs a restart.
 */
export function isTenancyNearMiss(name: string): boolean {
  if (name === 'MOCA_TENANCY') return false;
  let core = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prefix = PREFIXES.find((p) => core.startsWith(p) && core.length > p.length);
  if (prefix) core = core.slice(prefix.length);
  return core.startsWith(CORE) || editDistanceAtMostOne(core, CORE);
}

export function readTenancy(env: NodeJS.ProcessEnv): Tenancy {
  const misnamed = Object.keys(env).find(isTenancyNearMiss);
  if (misnamed !== undefined) {
    throw new Error(
      `unrecognised variable '${misnamed}': the tenancy switch is MOCA_TENANCY (unset '${misnamed}' to boot)`,
    );
  }
  const raw = env.MOCA_TENANCY;
  if (raw === undefined || raw === 'single') return 'single';
  if (raw === 'multi') return 'multi';
  throw new Error(`MOCA_TENANCY must be 'single' or 'multi', got '${raw}'`);
}
