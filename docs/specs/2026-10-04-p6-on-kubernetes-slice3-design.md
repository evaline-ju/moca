# P6 on Kubernetes, slice 3: sandbox tiers and session-to-sandbox affinity — Design

Version: 1.1 — October 2026 (v1.1: corrections from the implementation plan)
Status: Proposed
Milestone: **P6.3**, registered in [the milestone registry](README.md). This is slice 3 of epic
rossoctl/moca#426, issue rossoctl/moca#425.
Builds on (reuse, no redesign): [P6.1](2026-10-02-p6-on-kubernetes-slice1-design.md) (the P6 stack on
Kubernetes), [P6.2](2026-10-04-p6-on-kubernetes-slice2-design.md) (external P4 hosts attached to the
in-cluster relay), [MU1](2026-09-08-multi-user-control-plane-design.md) (sessions, the per-turn
exchange), and `deploy/microvm/P4-ON-P6.md` (the P4 tier on the P6 relay).

> **The one-sentence thesis.** A session picks a sandbox tier once, at creation, and from then on
> every turn lands in that tier and, whenever it can, on the same sandbox as the turn before. A turn
> never moves to another tier, and never silently loses its workspace: it waits (503) for its
> sandbox, or, if that sandbox has been gone longer than a grace period, moves within the tier and
> records the reset.

**Not specific to Kubernetes.** The VM path (`deploy/vm` + `deploy/microvm`) has the same limits, and
this slice lifts them there too. Only the harness, the relay, the workers, the control plane and
mocactl change; the deployment paths only set configuration.

---

## 0. Decisions taken during design

### 0.1 v1.1 corrections

1. **Durations are integer seconds:** `SH_SANDBOX_AFFINITY_TTL_SECONDS` and `SH_SANDBOX_AFFINITY_GRACE_SECONDS`. The TypeScript side has no Go-duration parser, and the repo's knobs are `*_SECONDS` / `*_MS` integers read through `intEnv`.
2. **The relay overwrites the detach mark** (plain `SET` with TTL); only the harness uses `SET NX`. Otherwise a stale mark can survive and cause early grace-period expiry.
3. **Affinity applies only on the records path** (`remoteOn`). The pods-only path stays byte-for-byte unchanged. Pods listed alongside records (`both`) take part in affinity like records.
4. **Placement is reported at turn end**, from the result, not at turn start: the sandbox is not known when `server.ts` reports `start`.
5. **§10's first risk is resolved:** mocactl already parses an unknown SSE `event:` as an `UnknownFrame`. Older clients ignore `workspace_reset`. The mocactl contract test requires `KNOWN_FRAME_TYPES` to change in the same PR as the harness union.
6. **Retiered sandboxes:** an affine sandbox present under another tier falls back immediately (reason `'retiered'`). §4 step 4 covered only "absent".
7. **`SandboxAffinityPendingError` extends `SandboxPoolSaturatedError`,** so the three leaf paths' existing `instanceof SandboxPoolSaturatedError` checks classify it `saturated` (retryable) with no edit. Its own `name` joins knative-server's `NO_CAPACITY` set.

| Question                          | Decision                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is driving this slice        | **Mixed tiers behind one relay**: container sandboxes and P4 microVM workers on one stack, each session pinned to one tier. Horizontal P4 scale comes with it (affinity), but is secondary.                                                                                                                                                    |
| Who picks a session's tier        | **The user, at session creation**, with a deployment default. Fixed for the session's life, like `credentialName`. A per-subject allow-list is out of scope; it can be layered on later without changing the shape.                                                                                                                            |
| What a tier is                    | **An operator-defined name**, advertised by a worker as the presence label `moca.dev/tier`. The deployment declares its names and default (`SH_SANDBOX_TIERS`, `SH_SANDBOX_DEFAULT_TIER`). Rejected: a fixed enum in code (a GPU or regional pool would need a code change); arbitrary per-session selectors (MU2's `poolSelector` territory). |
| The previous sandbox is saturated | **503, retryable.** Never another sandbox: that trades a short wait for a lost workspace.                                                                                                                                                                                                                                                      |
| The previous sandbox is absent    | **503 for a grace period (default 60 s), then fall back within the tier and record a workspace reset.** Rejected: strict (a decommissioned host strands its sessions until an operator acts) and soft (today's bug, at a lower rate).                                                                                                          |
| Where affinity lives              | **Data-plane Redis, beside the leases** (`sh:sandbox:affinity:<sessionId>`). Rejected: the control plane's `SessionRecord` (couples it to placement, needs a per-turn write-back, does nothing without a control plane); shared workspace storage per tier (§9).                                                                               |
| How the tier reaches the selector | **On the exchange response**, which every authenticated turn already fetches from the control plane. Unauthenticated turns and leaves use the deployment default.                                                                                                                                                                              |

## 1. Scope

**In scope**

- A tier label on presence records, set by the workers; a detach timestamp written by the relay.
- `selectPoolSandbox`: filter by tier, prefer the affine sandbox, the grace-period fallback.
- The tier on the control plane's session (create, store, exchange, list, discovery).
- `mocactl new --tier`, the TUI picker, and placement in the session's resources view.
- A `workspace_reset` turn-stream frame.
- Configuration on every deployment path; the rewrite of `P4-ON-P6.md`'s "A P4-only host" and of
  slice 2's one-tier-per-stack guard.

**Not in scope**

- Per-subject tier allow-lists, tier quotas, and tier-aware admission in the supervisor.
- Moving a session to another tier, or changing a session's tier after creation.
- Shared workspace storage (§9), and any change to how the container tier stores its workspace.
- Using `capacityMax` for leasing (the soft cap stays the lease store's `opts.cap`).
- MU2's tenant-labelled `poolSelector`.

## 2. Current state (what this slice changes)

- **Selection re-runs on every turn** over **every** presence record: the least-loaded one under the
  soft cap (`harness/src/select-sandbox.ts`, `selectPoolSandbox`). Nothing remembers which sandbox
  served a session.
- **The labels already have a wire.** `Hello` has `map<string,string> labels` and `string trust`
  (`proto/sandbox/v1/sandbox.proto`), and the relay copies `labels` into the presence record
  (`packages/sandbox-relay/src/relay.ts`, `onAttach`). Neither worker sets `labels`
  (`remote-worker/internal/session/loop.go`, the `Hello` send), and nothing reads them. **No proto
  change is needed.**
- **Continuity today is only the workspace key.** `workspaceKey = sessionId` goes to whichever
  sandbox is picked. On P4 the workspace is `SH_WORKSPACE_ROOT/<sessionId>` on the worker's host, so
  a second P4 host opens an empty one. The container tier ignores the key: one container-local,
  shared workspace per container (`remote-worker/internal/exec/runner.go`, `Spec.WorkspaceKey`). So
  **with two container sandboxes a session already loses its files when turn 2 lands on the other
  one.** Affinity fixes that too.
- **The control plane already reserves a placement field.** `SessionRecord.poolSelector` is always
  `null`, kept for MU2 (`packages/control-plane/src/handlers.ts`, `createSession`). This slice adds a
  separate field and leaves `poolSelector` alone.
- **The exchange is the trusted hop.** `resolveTurnAuth` (`packages/knative-server/src/turn-auth.ts`)
  verifies the session token and calls the control plane's exchange on every authenticated turn. A
  tier carried there cannot be set by a request body.

## 3. Data model and wire

### 3.1 Workers (`remote-worker`)

Both workers read `SANDBOX_TIER` and, when it is non-empty, send `labels["moca.dev/tier"] = <value>`
in `Hello`. Defaults: `microvm-worker` → `microvm`, `worker` → `container`. An explicitly empty
`SANDBOX_TIER=` sends no label. `session.Config` gains `Labels map[string]string`, which the `Hello`
send copies.

### 3.2 Relay (`packages/sandbox-relay`)

- `sh:sandbox:records` keeps its shape; `labels` are now populated.
- **New key `sh:sandbox:detached:<sandboxId>`** = epoch milliseconds, with a TTL equal to
  `SH_SANDBOX_AFFINITY_TTL_SECONDS` (§3.5). `teardown` writes it with a plain `SET` and TTL, after the
  record is removed. A successful Hello deletes it, before the presence put.
- The detach write and delete are best effort, like the presence remove: a failure is logged and
  changes nothing else. A missing key is handled by the selector (§4, step 4).
- The relay reads `SH_SANDBOX_AFFINITY_TTL_SECONDS` for the TTL. It has no other tier logic: it stays a
  bridge keyed by `sandboxId`.

### 3.3 Control plane (`packages/control-plane`)

- `SessionRecord` gains `sandboxTier: string`, stored in the session hash beside `credentialName`.
  `''` means "no tiers declared at creation".
- `POST /v1/sessions` accepts an optional `sandbox: { tier: string }`.
  - With `SH_SANDBOX_TIERS` set, a tier not in the list is a **400 `invalid_request`** whose message
    lists the declared names. An omitted tier stores `SH_SANDBOX_DEFAULT_TIER`. The default is
    resolved and **stored at creation**, so changing the default later does not move an existing
    session.
  - With `SH_SANDBOX_TIERS` unset, a requested tier is a 400 (`this deployment declares no sandbox
tiers`), and `''` is stored.
- At startup the control plane refuses a `SH_SANDBOX_DEFAULT_TIER` that is not in
  `SH_SANDBOX_TIERS`, and a `SH_SANDBOX_TIERS` without a default (unless it names exactly one tier,
  which is then the default).
- `ExchangeResponse` gains `sandboxTier: string`. A record written before this slice has no field;
  the exchange returns the current default for it (or `''` when no tiers are declared).
- Session listings and `GET /v1/sessions/{id}` include `sandboxTier`.
- `GET /v1/discovery` gains `sandboxTiers: { names: string[]; default: string } | null`.
- `docs/api/openapi.yaml` and the client spec are updated with all of the above.

### 3.4 Data plane (`packages/knative-server`, `harness`)

- `TurnAuth` gains `sandboxTier`, from the exchange. `executeTurn` passes it to
  `acquireTurnSandbox`, which passes it to `selectPoolSandbox` as `opts.tier`.
- With no `TurnAuth` (an unauthenticated turn on a deployment that allows it) and on every leaf
  path (`run-leaf.ts`), `opts.tier` is `SH_SANDBOX_DEFAULT_TIER` from the process environment.
- `''` or undefined means "no tier filter".

### 3.5 Affinity (new, harness)

- **Key `sh:sandbox:affinity:<sessionId>`** = JSON `{ "sandboxId": string, "tier": string }`, with
  TTL `SH_SANDBOX_AFFINITY_TTL_SECONDS` (integer seconds, default `86400`), refreshed on every lease.
- **The TTL must be at least `SH_WORKSPACE_IDLE`** (P4's idle reclaim, default 30 min). Affinity
  outliving the workspace is harmless: the session returns to its sandbox and finds an empty
  workspace, which is what a fallback gives it anyway. Affinity expiring first loses a workspace
  that still exists. Container workspaces live until the pod restarts, hence the long default.
- Served by a new `AffinityStore` (`get`, `setIfAbsent`, `refresh`, `getDetached`,
  `setDetachedIfAbsent`), memoised and guarded exactly like the lease store
  (`select-sandbox.ts`, `sharedLease` / `dropMemo`), on the same `REDIS_URL`.

## 4. The selection algorithm (`selectPoolSandbox`)

The inputs gain `opts.tier?: string`. The no-selector path, the pods path, the lease, `holderId` and
`workspaceKey` are unchanged.

1. **List and filter.** List the records. When tiers are declared (`SH_SANDBOX_TIERS` set in the
   worker's environment), keep only records with `labels["moca.dev/tier"] === opts.tier`. A record
   with **no** tier label is excluded, with one log line per sandbox ID per process naming the ID and
   its labels, so a misconfigured worker fails loudly instead of serving either tier. When no tiers
   are declared, nothing is filtered. Pods (the `pods` and `both` discovery sources) are container
   tier: they pass the filter only when `opts.tier` is the default tier.
2. **Read affinity** for `sessionId`. An entry whose `tier` is not `opts.tier` is ignored.
3. **The affine sandbox is in the filtered set:** `acquire` that sandbox **only**. If the cap
   refuses it, throw `SandboxPoolSaturatedError` (503). Do not try another sandbox.
4. **The affine sandbox is absent from the filtered set:** read `sh:sandbox:detached:<id>`.
   - **Missing:** write it now with `SET NX` (`setDetachedIfAbsent`). This starts the grace clock at
     the first turn that noticed the absence. It covers a relay that restarted, and so never wrote
     the key, while the host was gone for good. Then treat the sandbox as just detached.
   - **Present under a different tier** (reason `'retiered'`): continue to step 5 immediately, carrying
     `workspaceReset = { from: <id>, reason: 'retiered' }`.
   - **Detached for less than `SH_SANDBOX_AFFINITY_GRACE_SECONDS`** (integer seconds, default `60`): throw
     the new **`SandboxAffinityPendingError`** (503, retryable), naming the sandbox and the time left.
   - **Detached for longer:** continue to step 5, carrying
     `workspaceReset = { from: <id>, reason: 'detached' }`.
5. **No affinity, or the fallback:** today's least-loaded loop over the filtered set. If the set is
   empty, throw `SandboxPoolEmptyError`, its message naming the tier; if every sandbox is full,
   throw `SandboxPoolSaturatedError`.
6. **After a successful lease:**
   - **Without a prior entry:** `setIfAbsent({sandboxId, tier})`. If another turn of the same session
     won the write and chose a **different** sandbox, release this lease and re-run from step 2 against
     the winner's entry, **once**. A second disagreement throws `SandboxAffinityPendingError`.
   - **With a prior entry for this sandbox:** `refresh` the TTL.
   - **After a fallback:** overwrite the entry with the new sandbox.
   - `SelectedSandbox` gains `sandboxId`, `tier` and `workspaceReset?`, for §6.

Concurrent turns of one session read the same entry, so they converge on one sandbox. Step 6 closes
the race between two **first** turns.

## 5. Failure modes

| Situation                                                    | Behaviour                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay restart                                                | Every record disappears, then the workers re-Hello under the same IDs. Affinity and detach keys are in Redis and untouched. Turns in the gap get 503: `SandboxAffinityPendingError` for a session with affinity, `SandboxPoolEmptyError` for one without. Each session is back on its own sandbox within seconds.                                              |
| Worker or pod restart                                        | P4: the workspace is on host disk and survives. Container tier: the pod returns under the same StatefulSet name, but its workspace is container-local and **lost by the existing design** (`deploy/k8s/base/sandbox.yaml`). Affinity still returns the session to the same ID, and no reset is recorded: the harness cannot see that loss. A documented limit. |
| Host gone for good                                           | 503 for the grace period, then the fallback within the tier, with the reset recorded (§6).                                                                                                                                                                                                                                                                     |
| The session's tier is empty or saturated                     | 503, as today. A session **never** moves to another tier.                                                                                                                                                                                                                                                                                                      |
| Reading affinity or the detach key fails                     | The turn fails, as a failed lease read does today. It does not fall back to an unpinned selection: a Redis blip must not scatter sessions across sandboxes.                                                                                                                                                                                                    |
| Writing affinity fails after the lease was taken             | The turn **proceeds**, with a warning. The lease is held and the sandbox is right. The next turn finds the old entry or none, and selects as in §4.                                                                                                                                                                                                            |
| The session's tier is removed from `SH_SANDBOX_TIERS`        | The exchange returns the stored tier; nothing matches it; `SandboxPoolEmptyError`, naming the tier. The control plane does not rewrite stored tiers.                                                                                                                                                                                                           |
| An unlabelled or mislabelled worker                          | Excluded while tiers are declared, with a log line naming its ID and labels.                                                                                                                                                                                                                                                                                   |
| `SH_SANDBOX_TIERS` differs between control plane and workers | A session's tier may match no record (`SandboxPoolEmptyError`, naming the tier). Every deployment path sets both from one source, and an env-parity test guards it (§7).                                                                                                                                                                                       |

**Error mapping.** `SandboxAffinityPendingError` joins `turnErrorStatus`'s NO_CAPACITY set (503) and
stays retryable in `classifyOutcome`, beside `SandboxPoolSaturatedError` and `SandboxPoolEmptyError`.

## 6. User surface and observability

- **Discovery and creation.** mocactl reads `sandboxTiers` from `GET /v1/discovery`.
  - Headless: `mocactl new --tier <name>`. An unknown name gets the control plane's 400, which lists
    the valid names. With `sandboxTiers: null`, `--tier` is refused locally with the same wording.
  - TUI: the new-session overlay shows a tier picker only when more than one tier is declared, with
    the default preselected.
  - Session listings and session info show the tier.
- **Placement.** The data plane's runtime report (`runtimeFieldsForTurn`, `reportRuntime`) gains
  `sandboxId` and `sandboxTier` at turn end, from the lease actually taken, and
  `workspaceResetAt` / `workspaceResetFrom` and `workspaceResetReason` after a fallback. `projectResources` exposes them under
  `sandbox`, so the resources view shows where the session runs and when it last lost its workspace.
- **The turn itself.** After a fallback, a streamed turn emits a new frame before any other:
  `{ type: 'workspace_reset'; sessionId; from; tier; reason }` (`harness/src/turn-stream.ts`,
  `TurnStreamFrame`). A JSON turn result gains `workspaceReset?: { from, tier, reason }`. mocactl prints it as
  a notice. Clients that do not know the frame type must ignore it (§10).
- **Logs.** One structured line for each non-trivial decision: affinity pending, fallback, an
  unlabelled record excluded, an affinity write failed. No new metrics in this slice.

## 7. Configuration and deployment paths

| Variable                            | Read by                    | Default                 | Meaning                                                                      |
| ----------------------------------- | -------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `SH_SANDBOX_TIERS`                  | control plane, supervisor  | unset                   | Comma-separated tier names. Unset: no tiers, no filtering.                   |
| `SH_SANDBOX_DEFAULT_TIER`           | control plane, supervisor  | unset                   | Required with more than one tier; must be one of them.                       |
| `SH_SANDBOX_AFFINITY_TTL_SECONDS`   | supervisor, relay          | `86400`                 | Affinity and detach-key TTL in seconds. Keep ≥ `SH_WORKSPACE_IDLE`.          |
| `SH_SANDBOX_AFFINITY_GRACE_SECONDS` | supervisor                 | `60`                    | How long an absent affine sandbox is waited for before fallback, in seconds. |
| `SANDBOX_TIER`                      | `worker`, `microvm-worker` | `container` / `microvm` | The worker's `moca.dev/tier` label. Empty: no label.                         |

- **`deploy/vm`, `deploy/compose`:** the env templates gain the variables, unset by default. A
  stack that sets nothing behaves as before, plus affinity.
- **`deploy/microvm/setup-microvm.sh`:** when it attaches a P4 worker to a co-located P6 stack that
  also runs containers, it adds `microvm` to `SH_SANDBOX_TIERS` and keeps the existing default.
  `P4-ON-P6.md`'s "A P4-only host" section and its entry in the limits list are rewritten.
- **`deploy/k8s/setup.sh`:** derives the tiers from what it deploys (`SH_SANDBOX_COUNT>0` adds
  `container`, `SH_P4_SANDBOX_IDS` adds `microvm`, default `container` when both), writes them to
  both the control plane's and the supervisor's settings, and **removes slice 2's
  one-tier-per-stack guard** (`setup.sh`, the `SH_SANDBOX_COUNT=0` requirement). P6.2's single-host
  limit is rewritten.
- An **env-parity test** asserts that every path sets `SH_SANDBOX_TIERS` and
  `SH_SANDBOX_DEFAULT_TIER` identically for the control plane and the supervisor.

## 8. Testing

- **Harness, unit.** A table test over `selectPoolSandbox` with fake record, lease and affinity
  stores, one case per row of §5 and per step of §4: tier filtering, unlabelled exclusion, affine
  saturated, affine absent within and past the grace, the harness-started grace clock, the
  first-turn `SET NX` race (win, lose-and-converge, lose twice), a failed affinity write, a failed
  affinity read, no tiers declared.
- **Relay, unit.** The detach key is written on teardown only if absent, and deleted on Hello before
  the presence put. Its failures are logged and change nothing else.
- **Workers, Go unit.** `SANDBOX_TIER` → `Hello.labels`, the defaults, and the empty value.
- **Control plane, unit.** Validation at creation, the stored default surviving a later default
  change, the exchange carrying the tier, an old record getting the default, discovery, the startup
  refusals.
- **mocactl, unit.** `--tier`, the picker, the notice for `workspace_reset`, ignoring an unknown
  frame type.
- **Integration, real Redis.** Two fake workers in each of two tiers behind a real relay. Across many
  sessions every turn stays in its tier and on its affine sandbox, and new sessions still spread by
  load. A relay restart mid-run moves no session.
- **Acceptance (#425's criteria).**
  1. **KVM rig, VM path:** one relay with container sandboxes and a P4 worker. P4 sessions land only
     on P4, container sessions only on containers.
  2. **KVM rig, two P4 workers** (two IDs, two workspace roots): a session's turn 2 sees turn 1's
     files across many sessions, and load spreads over both.
  3. **OpenShift, after P6.2 merges:** the mixed stack, with the one-tier guard gone.
  4. **CI (`k8s-kind-e2e`):** a new smoke claim with two container sandboxes, where every turn of a
     session sees the previous turn's files. Kind has no P4; this is the part CI can prove.

## 9. Alternative considered: shared workspace storage per tier

Put every tier's workspaces on storage all its sandboxes share (NFS or a ReadWriteMany PVC for P4,
`workspace_key`-scoped directories on a shared volume for containers), so any sandbox can serve any
turn. It spreads load best and survives a lost host without a reset. It is not this slice: P4
workspaces are host-side disks attached to Firecracker guests, so it needs a new storage substrate
plus locking for concurrent turns; the container tier would first have to honour `workspace_key`;
and it does not remove the need for tier filtering. Affinity is compatible with it later: a shared
store would make the grace period and the fallback lossless, and nothing else.

## 10. Risks and things to verify early

- ~~**Unknown SSE frame types in older clients.** Verify that the shipped mocactl ignores an unknown
  `event:` type.~~ **Resolved (v1.1):** mocactl already parses an unknown `event:` as `UnknownFrame` and ignores it. Older clients will ignore `workspace_reset`.
- **Pods in `both` discovery.** The pods path is the Knative-era inventory; treating pods as the
  default tier is a compatibility choice. Confirm no live deployment mixes pods with tiered records.
- **The grace default.** 60 s must exceed the worker's reattach backoff after a relay restart.
  Measure it on Kind and on the rig, and record the value.
- **Affinity holds a session on a busy sandbox.** Load spreads only across new sessions; a hot
  sandbox's sessions 503 rather than move. Accepted (§0), but watch it in the two-P4 acceptance run.

## 11. Delivery

Three PRs, in order:

1. **Harness, relay, workers:** `SANDBOX_TIER`, the detach key, `AffinityStore`, the §4 algorithm,
   `SandboxAffinityPendingError`, the `workspace_reset` frame, the runtime fields. With
   `SH_SANDBOX_TIERS` unset this is safe on its own, and it fixes the container-tier hop. It does not
   depend on P6.2.
2. **Control plane and mocactl:** the session's tier, the exchange, discovery, the API docs, `--tier`,
   the picker, the notice.
3. **Deployment wiring and docs:** `deploy/vm`, `deploy/compose`, `deploy/microvm`, `deploy/k8s`
   (after P6.2 merges: it edits `setup.sh`), `P4-ON-P6.md`, the README runbook, the env-parity test,
   the Kind smoke claim, and the acceptance runs recorded on rossoctl/moca#425.
