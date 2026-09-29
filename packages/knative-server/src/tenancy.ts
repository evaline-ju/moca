/** The deployment's tenancy mode (MI1 §10.1). Default `single`; anything else is a boot failure. */
export type Tenancy = 'single' | 'multi';

// A near-miss NAME (`MOCA_TENANCY_MODE`, `moca_tenancy`) would otherwise read as "unset" and boot
// `single` silently, while a near-miss VALUE already throws. Refuse both the same way.
const NEAR_MISS = /^moca_?tenanc/i;

export function readTenancy(env: NodeJS.ProcessEnv): Tenancy {
  const misnamed = Object.keys(env).find((k) => k !== 'MOCA_TENANCY' && NEAR_MISS.test(k));
  if (misnamed !== undefined) {
    throw new Error(`unrecognised variable ${misnamed}: the tenancy switch is MOCA_TENANCY`);
  }
  const raw = env.MOCA_TENANCY;
  if (raw === undefined || raw === 'single') return 'single';
  if (raw === 'multi') return 'multi';
  throw new Error(`MOCA_TENANCY must be 'single' or 'multi', got '${raw}'`);
}
