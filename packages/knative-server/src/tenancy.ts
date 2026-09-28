/** The deployment's tenancy mode (MI1 §10.1). Default `single`; anything else is a boot failure. */
export type Tenancy = 'single' | 'multi';

export function readTenancy(env: NodeJS.ProcessEnv): Tenancy {
  const raw = env.MOCA_TENANCY;
  if (raw === undefined || raw === 'single') return 'single';
  if (raw === 'multi') return 'multi';
  throw new Error(`MOCA_TENANCY must be 'single' or 'multi', got '${raw}'`);
}
