# Optional Context Service integration

Serverless Harness can use an external Context Service to allocate a workload-scoped sandbox pool
and workspace. This integration is optional. Without it, existing `/runs` requests and static
sandbox-pool configuration behave as before.

Set `CONTEXT_SERVICE_URL` on the Knative service to enable the workload lifecycle routes:

```text
POST   /workloads
GET    /workloads/{workloadId}
DELETE /workloads/{workloadId}
```

Context Service requests time out after 5 seconds by default. Set
`CONTEXT_SERVICE_TIMEOUT_MS` to a positive number of milliseconds to override this limit.

`POST /workloads` asks Context Service to allocate the pool. A subsequent `/runs` request can pass
the returned `workloadId`; Serverless Harness resolves it to the pool selector before leasing and
executing in a sandbox. Deleting the workload asks Context Service to release its resources.

If `CONTEXT_SERVICE_URL` is unset, the workload lifecycle routes return
`501 context_service_not_configured`. `/runs` requests that omit `workloadId` continue to use the
existing `KAGENTI_SANDBOX_POOL_SELECTOR` configuration.

## Security boundary

**Authentication and workload identity.** Every `/workloads` verb authenticates with the same rules
as `/turn`: a session token is required under `SH_REQUIRE_AUTH=true`, and a present-but-bad token is
refused in either mode. A workload records the subject that created it as its `owner`. Only that
subject can read it, delete it, or run on it (`POST /runs` with its `workloadId`); an unowned
workload (created without a token) can be read or run on only without one. With `SH_REQUIRE_AUTH`
off, every caller who presents no token is the same unauthenticated principal, so do not expose
`/workloads` to mutually untrusted clients unless it is on. A mismatch is `404
workload_not_found`. Re-creating a live workload that another subject owns is `409
workload_name_taken`. Workload names are still one namespace across all subjects, so a name is
first come, first served.

**Upgrading.** A workload created before owners existed has none. Under `SH_REQUIRE_AUTH=true` it
can be neither read nor run on, and its name cannot be re-created, but **any** authenticated caller
may `DELETE` it. That releases the Context Service pool and frees the name for an owned re-create.

**PVC access is not authorized.** Serverless Harness forwards a caller-provided
`workspace.claimName` to Context Service, and neither component checks that the caller may use that
claim. Owning a workload says nothing about owning the volume it names. So a `claimName` is refused
(`400 claim_name_not_allowed`) from any authenticated caller, which under `SH_REQUIRE_AUTH=true` is
every caller, and always under `MOCA_TENANCY=multi`; such a workload can use only the volume Context
Service provisions for it. Only the anonymous caller of a deployment with authentication off, which
tells no callers apart, may still name a claim. Scoping claims per subject is deferred (MI1 spec §4.3, §13; rossoctl/moca#358).

**Do not expose `/workloads` to mutually untrusted clients unless `SH_REQUIRE_AUTH=true`.** With it
off, every caller without a token is the same principal, and may use any PVC in the namespace.

Kubernetes RBAC on the service account limits what Context Service can provision, but it does not
authorize one API caller relative to another.
