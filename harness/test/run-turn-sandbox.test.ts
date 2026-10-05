import { describe, it, expect, vi } from 'vitest';
import { acquireTurnSandbox } from '../src/run-turn.js';
import type { LeaseStore } from '../src/sandbox-lease.js';

// executeTurn resolved its sandbox from process.env unconditionally (ADR 0028: prompt leaves
// "inherit /turn's sandbox routing"), which left a leased pool sandbox — and the whole remote
// relay transport — unreachable from a prompt leaf. That was fixed for leaves by injection.
//
// It was NOT fixed for /turn, which is what acquireTurnSandbox now closes: /turn used to call
// resolveSandboxConfig alone, so a deployment configuring a POOL had its turn's tool calls run in
// the harness process. Proven on hardware — the tool's file landed in the supervisor unit's own
// PrivateTmp namespace, never in a sandbox container.
//
// The load-bearing property in here is the no-pool EQUIVALENCE: /turn is live for every Knative
// deployment, so a deployment with no KAGENTI_SANDBOX_POOL_SELECTOR must resolve exactly as it did
// before, and must arm no lease renewal.

/** Records every call, so a test can assert on the lease store rather than on a spy's count. */
function fakeLeaseStore(): LeaseStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    load: async () => {
      calls.push('load');
      return 0;
    },
    acquire: async (pod, _cap, runId) => {
      calls.push(`acquire:${pod}:${runId}`);
      return true;
    },
    heartbeat: async (pod, runId) => {
      calls.push(`heartbeat:${pod}:${runId}`);
    },
    release: async (pod, runId) => {
      calls.push(`release:${pod}:${runId}`);
    },
  };
}

describe('acquireTurnSandbox', () => {
  it('returns the injected sandbox verbatim, including its transport, and never leases', async () => {
    const transport = {
      exec: async () => ({ stdout: Buffer.from(''), exitCode: 0, truncated: false }),
      close: async () => {},
    };
    // `context` is a required key on K8sSandboxConfig (its value may be undefined, meaning
    // "use current-context"), so a config literal that omits it is not one -- unnoticed until
    // harness/test came under the typechecker (#190).
    const injected = {
      config: {
        pod: 'sbx-laptop',
        namespace: 'default',
        context: undefined,
        podCwd: '/workspace',
        headCwd: '/head',
      },
      transport,
    };

    const got = await acquireTurnSandbox(injected, {}, '/head', 'run-1');

    expect(got.sandbox).toEqual(injected);
    expect(got.sandbox.transport).toBe(transport);
    // The injecting caller owns the lease. Renewing or returning it from here would let one turn
    // release the sandbox another turn is still executing in.
    expect(got.leased).toBe(false);
  });

  it('ignores env resolution entirely when a sandbox is injected', async () => {
    // A leased remote sandbox must win over an ambient KAGENTI_SANDBOX_POD: honouring the env
    // here would silently route a remote prompt leaf back to an in-cluster pod.
    const injected = {
      config: {
        pod: 'sbx-leased',
        namespace: 'default',
        context: undefined,
        podCwd: '/workspace',
        headCwd: '/head',
      },
    };

    const got = await acquireTurnSandbox(
      injected,
      { KAGENTI_SANDBOX_POD: 'sandbox-0' },
      '/head',
      'run-1',
    );

    expect(got.sandbox.config?.pod).toBe('sbx-leased');
  });

  it('falls back to single-pod env resolution when nothing is injected and no pool is configured', async () => {
    const got = await acquireTurnSandbox(
      undefined,
      { KAGENTI_SANDBOX_POD: 'sandbox-0' },
      '/head',
      'run-1',
    );

    expect(got.sandbox.config).toMatchObject({
      pod: 'sandbox-0',
      namespace: 'default',
      podCwd: '/workspace',
      headCwd: '/head',
    });
    expect(got.sandbox.transport).toBeUndefined();
    // No pool ⇒ no lease behind it ⇒ executeTurn must not arm a renewal interval, which would
    // otherwise land on every turn of every non-pool deployment and perturb loop_lag_p99.
    expect(got.leased).toBe(false);
  });

  it('resolves to a null config when neither injected nor configured (tools run local)', async () => {
    const got = await acquireTurnSandbox(undefined, {}, '/head', 'run-1');

    expect(got.sandbox).toEqual({ config: null });
    expect(got.leased).toBe(false);
  });

  it('leases from the pool when a selector is configured — the /turn behaviour this fixes', async () => {
    const lease = fakeLeaseStore();

    const got = await acquireTurnSandbox(
      undefined,
      { KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sandbox' },
      '/head',
      'sess-42',
      { lease, listPods: async () => ['sandbox-a'] },
    );

    expect(got.sandbox.config?.pod).toBe('sandbox-a');
    expect(got.leased).toBe(true);
    // The member is the per-turn HOLDER, derived here from the session id -- not the session id
    // itself, which would make N concurrent turns of one session share one lease slot
    // (turn-lease-holder.test.ts covers why). Prefixed by it for greppability.
    const acquire = lease.calls.find((c) => c.startsWith('acquire:'));
    expect(acquire).toMatch(/^acquire:sandbox-a:sess-42:[0-9a-f-]{36}$/);
    expect(lease.calls).not.toContain('acquire:sandbox-a:sess-42');
  });

  it('drives the real lease store on heartbeat and release', async () => {
    const lease = fakeLeaseStore();

    const got = await acquireTurnSandbox(
      undefined,
      { KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sandbox' },
      '/head',
      'sess-42',
      { lease, listPods: async () => ['sandbox-a'] },
    );
    await got.heartbeat();
    await got.release();

    // Asserted against the store's own recorded calls: a fake that merely agreed with a spy count
    // would pass even if heartbeat/release were wired to the wrong pod or holder. Renewal and release
    // must name the SAME member acquire took, or a turn renews nothing and releases someone else's
    // lease -- so this reads the holder off the acquire rather than hard-coding it.
    const holder = lease.calls
      .find((c) => c.startsWith('acquire:sandbox-a:'))!
      .slice('acquire:sandbox-a:'.length);
    expect(holder).toMatch(/^sess-42:[0-9a-f-]{36}$/);
    expect(lease.calls).toContain(`heartbeat:sandbox-a:${holder}`);
    expect(lease.calls).toContain(`release:sandbox-a:${holder}`);
  });

  it('treats an empty-string selector as no pool, matching selectPoolSandbox exactly', async () => {
    // selectPoolSandbox branches on `if (!selector)`, so '' takes its no-lease path and now REPORTS
    // that through `SelectedSandbox.leased`. This used to be re-derived here from the environment,
    // which agreed only as long as both copies of the predicate did.
    const got = await acquireTurnSandbox(
      undefined,
      { KAGENTI_SANDBOX_POOL_SELECTOR: '', KAGENTI_SANDBOX_POD: 'sandbox-0' },
      '/head',
      'run-1',
    );

    expect(got.sandbox.config?.pod).toBe('sandbox-0');
    expect(got.leased).toBe(false);
  });

  it('throws rather than silently running local when a configured pool has no candidates', async () => {
    // The previous /turn behaviour for this case was to run tools in the harness process, which is
    // the failure spec §5.4 exists to prevent: a turn that cannot reach its configured sandbox is
    // not a turn that should quietly succeed.
    await expect(
      acquireTurnSandbox(
        undefined,
        { KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sandbox' },
        '/head',
        'r',
        {
          lease: fakeLeaseStore(),
          listPods: async () => [],
        },
      ),
    ).rejects.toThrow(/pool selector/);
  });

  it('passes the tier to the selection and reports where the turn landed (P6.3)', async () => {
    const lease = fakeLeaseStore();
    const records = {
      put: async () => {},
      remove: async () => {},
      list: async () => [
        {
          sandboxId: 'c-0',
          labels: { 'moca.dev/tier': 'container' },
          capabilities: [],
          capacityMax: 4,
          transport: 'grpc' as const,
        },
        {
          sandboxId: 'm-0',
          labels: { 'moca.dev/tier': 'microvm' },
          capabilities: [],
          capacityMax: 4,
          transport: 'grpc' as const,
        },
      ],
    };
    const affinity = {
      get: async () => ({ sandboxId: 'm-gone', tier: 'microvm' }),
      claim: async (_s: string, e: { sandboxId: string; tier: string }) => e,
      replace: async () => {},
      detachedSince: async () => 0, // long gone: past any grace
    };
    // The fallback logs one line by design; silenced here so the suite's output stays clean.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const got = await acquireTurnSandbox(
      undefined,
      {
        KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sandbox',
        SH_REMOTE_SANDBOX: '1',
        SH_SANDBOX_DISCOVERY: 'records',
        SH_SANDBOX_TIERS: 'container,microvm',
        SH_SANDBOX_DEFAULT_TIER: 'container',
      },
      '/head',
      'sess-7',
      {
        lease,
        records,
        affinity,
        makeExecClient: () => ({}) as never,
        makeTransport: () => ({ exec: async () => ({}) as never, close: async () => {} }),
      },
      'microvm',
    );
    expect(got.placement).toEqual({
      sandboxId: 'm-0',
      tier: 'microvm',
      workspaceReset: { from: 'm-gone', reason: 'detached' },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("moved from 'm-gone' to 'm-0'"));
    warn.mockRestore();
  });

  it('reports no placement when nothing was leased', async () => {
    const got = await acquireTurnSandbox(undefined, {}, '/head', 'sess-8');
    expect(got.placement).toBeUndefined();
  });
});
