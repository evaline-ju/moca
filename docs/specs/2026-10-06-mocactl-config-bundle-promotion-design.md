# `mocactl promote` — config-bundle promotion through the control plane — Design

**Date:** 2026-10-06 · **Status:** Proposed (amended 2026-10-06, see below) · **ADR:** [ADR-0038](../adrs/0038-mocactl-config-bundle-promotion.md)
**Builds on (reuse, no redesign):** [ADR-0030](../adrs/0030-claude-code-workflow-promotion.md) /
[claude-code-workflow-promotion-design](2026-09-02-claude-code-workflow-promotion-design.md) (the
bundle format, preflight, secret-scan, digest, and sandbox-overlay materialization — unchanged);
[ADR-0036](../adrs/0036-tui-decoupled-http-client.md) /
[mocactl-control-plane-client-design](2026-09-25-mocactl-control-plane-client-design.md) (`mocactl`
itself, its `SESSION_OPTION_FIELDS` session-creation model, its command/overlay architecture);
[ADR-0033](../adrs/0033-multi-user-control-plane.md) (the control plane this now extends);
[ADR-0037](../adrs/0037-p6-on-kubernetes-substrate.md) /
[p6-on-kubernetes-slice1](2026-10-02-p6-on-kubernetes-slice1-design.md) /
[slice2](2026-10-04-p6-on-kubernetes-slice2-design.md) (the deployment this is motivated by: ordinary
users reaching a cluster-hosted control plane with no `kubectl`/Redis access of their own).

> **Amendment, 2026-10-06 — four corrections found by reading the code while planning.** Each had
> been stated as fact in the first version:
>
> 1. **`/v1/turn` does NOT apply `configRef` today.** `handleTurn`
>    (`packages/knative-server/src/server.ts:141`) parses only `sessionId` and `prompt`; the only code
>    that resolves a bundle and overlays it into a sandbox is `run-leaf.ts` (the batch `/runs` path).
>    The interactive path therefore needs real harness work (§2.6), not just a client-side field.
> 2. **The first version contradicted itself on where `configRef` travels.** §4 rejected a per-turn,
>    client-supplied `configRef`, yet §2.5 had `mocactl` send it in every `/v1/turn` body. The harness
>    now learns `configRef` from the control plane's per-turn credential exchange, which already reads
>    the `SessionRecord` (§2.4); `mocactl` never sends it to the harness.
> 3. **The control plane caps every request body at 64 KiB** (`packages/control-plane/src/server.ts:10`),
>    which a base64 bundle exceeds. Routes now declare their own body limit, and bundles get an
>    explicit size cap (§2.3).
> 4. **ADR-0036 forbids any `@moca/*` dependency in `mocactl`**, enforced by
>    `packages/mocactl/test/layering.test.ts`. Client-side building needs `@moca/config-bundle`; this
>    design takes a narrow, named exception for exactly that package (§2.5).
>
> Also corrected: there is no `mocactl session new` command — headless session creation is
> `mocactl run`, so the flag is `mocactl run --config <digest>` (§2.5).

> **The one-sentence thesis.** The config-bundle mechanism ADR-0030 built already does almost
> everything this needs — build, preflight, scan, digest, materialize — but it was wired to a direct
> `kubectl port-forward` + Redis tunnel that assumes a developer sitting on the cluster, and only to
> the batch `/runs` path. This design moves the upload hop behind the control plane's `/v1` HTTP API,
> records the digest on the session, and teaches the interactive `/v1/turn` path to apply it, so any
> `mocactl` user can promote a skills directory and start a session with it, with no cluster
> credentials at all.

---

## 1. Problem

ADR-0030's `/promote` is a Claude Code slash command that shells out to
`pnpm --dir <harness> promote`, which reads `.claude/skills` + `.claude/commands` from a developer's
own checkout, runs preflight/secret-scan, and uploads the resulting tar **directly to the cluster's
Redis** over a `kubectl port-forward` tunnel the operator has to hold open. That is a reasonable
shape for the one developer who already has `kubectl` access to the cluster running the harness.

It is not a reasonable shape for `mocactl`'s actual users. P6-on-Kubernetes (ADR-0037) stands up an
always-on, multi-user control plane that ordinary users reach only over its public `/v1` HTTP API
(ADR-0033) — they authenticate via device-flow login, hold an API token, and have no `kubectl`
context and no Redis credentials for the cluster at all. There is today no way for such a user to
get their own skills in front of a session: the only promotion path requires exactly the cluster
access MU1 was built to avoid handing out.

Three smaller gaps compound this:

- `buildBundle` requires an `entry` — one `.claude/commands/<name>.md` prompt name — because
  ADR-0030 was designed around headless/batch dispatch (`run-leaf.ts`), where one fixed prompt
  template is "the task." `mocactl` sessions are interactive chat with no such fixed first prompt.
- Neither `POST /v1/sessions` nor anything on the session record carries a `configRef`, so there is
  nowhere to say which bundle an interactive session runs on.
- The harness's interactive `/v1/turn` path ignores `configRef` entirely. `executeTurn`
  (`harness/src/run-turn.ts`) can accept an already-resolved `promotedConfig`, but fetching the
  bundle, overlaying it into the turn's sandbox and tearing that overlay down again lives only in
  `run-leaf.ts`.

## 2. Decision

We will add a **control-plane-mediated upload path** for the exact same content-addressed bundle
ADR-0030 already defines, record the resulting digest on the session at creation, hand it to the
harness through the per-turn credential exchange the harness already performs, and apply it on the
interactive `/v1/turn` path with the same resolve-and-overlay mechanism `/runs` uses. Nothing about
the bundle format, preflight, secret-scan, or sandbox materialization changes.

```
mocactl promote <dir>  ──┐
                          │  build bundle locally (@moca/config-bundle) — preflight + secret-scan
/promote <dir> (in-app) ─┤  run on the CLIENT, same as ADR-0030's /promote
                          │
                          ▼
                 POST /v1/config-bundles   (control plane, auth: api)          ← NEW
                          │  size cap, re-verifies digest, stores tar in Redis (putBundle)
                          ▼
                     { digest, uploaded }
                          │
                          ▼
        POST /v1/sessions { configRef: digest }   (control plane)              ← NEW optional field
                          │  records configRef on SessionRecord, like credentialName
                          ▼
            mocactl holds { sessionId, token }      (it never sends configRef to the harness)
                          │
                          ▼
   POST /v1/turn { sessionId, prompt }   (straight to the harness — body unchanged)
                          │
                          ▼
   harness → POST /internal/credentials (exchange, every authenticated turn — already exists)
                          │  response now also carries the session's configRef         ← NEW field
                          ▼
   executeTurn: fetch bundle, overlay into the turn's sandbox, run, tear the overlay down  ← NEW
                (the resolve/overlay/cleanup code is lifted out of run-leaf.ts and shared)
```

### 2.1 `@moca/config-bundle`: `entry` becomes optional

- `BuildBundleInput.entry` changes from `string` to `string | undefined`.
- When omitted, `checkEntry` is skipped and `checkExcludedPrompts` skips its `entry_excluded`
  branch — no `unknown_entry` / `entry_excluded` findings. Its `prompt_excluded` /
  `prompt_exclude_unmatched` warnings still run, because they are about exclusions, not the entry.
  `BundleLockfile.entry` is written as `''` rather than the field being made optional there, so every
  existing reader of the lockfile keeps a plain `string`.
- Preflight otherwise runs exactly as before (classification, secret-scan, binary checks). A bundle
  built this way may legitimately carry zero prompt templates.
- `harness/src/promote-cli.ts` (ADR-0030's CLI) keeps `--entry` **required** — that path is still
  headless/batch dispatch, where an entry prompt is the task. Only the new client-side path in
  `mocactl` omits it.

### 2.2 Moving the bundle store so the control plane can use it

`putBundle` / `getBundle` / `BundleRedisLike` / `bundleKey` and their errors currently live in
`harness/src/config-store.ts`. The control plane needs that exact logic (digest re-verification,
gzip/base64, Redis storage) for the new endpoint. Duplicating it would let the two copies drift;
depending on `@moca/harness` from `@moca/control-plane` runs the dependency the wrong way.

We move `config-store.ts` unchanged into `@moca/config-bundle` (which already owns `contentDigest`
and `untar`, the two functions it calls). Harness modules import it from there; the harness's
`./config-store` package export is removed (nothing outside the harness imports it). One constant is
added beside it: `MAX_BUNDLE_BYTES = 8 MiB`, the largest tar the control plane accepts (§2.3).

### 2.3 Control plane: `POST /v1/config-bundles`

New route, declared in `routes.ts` like every other:

```
POST /v1/config-bundles   auth: api   sessionScoped: false   operationId: 'putConfigBundle'
                          maxBodyBytes: 12 MiB
```

- **Per-route body limit.** `RouteSpec` gains an optional `maxBodyBytes`; the router's `readBody`
  uses it, defaulting to the existing 64 KiB. Only this route raises it. 12 MiB holds the base64 of a
  `MAX_BUNDLE_BYTES` tar (≈10.7 MiB) plus the JSON wrapper.
- **Request:** `{ digest: string, tar: string }` — `tar` base64-encoded.
- **Handler:** require the principal first (the route-enumeration test asserts every api route
  refuses a missing principal before reading its body); validate `digest` with `assertValidDigest`
  (`invalid_request` otherwise); decode base64 and refuse a decoded tar over `MAX_BUNDLE_BYTES`
  (`invalid_request`, message names the cap); call `putBundle(deps.bundles, digest, tar)`.
  `BundleDigestMismatchError` maps to `400 { error: 'digest_mismatch' }`.
- **Response:** `201 { digest, uploaded }` — `uploaded: false` means the digest already existed and
  only its TTL was refreshed.
- **Byte budget.** A NEW digest is charged its stored size (the gzip+base64 value, floored at
  4 KiB for its key and index overhead) to the subject that first stored it; admit, charge and store
  are serialized in-process (the control plane runs as a single replica), and the charge is recorded
  before the store and rolled back if it fails; one over the subject's `SH_BUNDLE_SUBJECT_BYTES` (32 MiB) or the deployment's
  `SH_BUNDLE_TOTAL_BYTES` (64 MiB) is refused with `429 bundle_quota_exceeded`. Re-uploading a stored
  digest is free. Entries (zsets `sh:cp:bundles:all` and `sh:cp:bundles:owner:<subjectHash>`, scored
  by expiry, plus hash `sh:cp:bundles:meta`) age out with the bundle's TTL.
- **Redis:** `CpDeps` gains `bundles: BundleRedisLike`, wired in `main.ts` to the same node-redis
  client `OwnershipIndex` already uses.
- **No ownership record.** Intentionally just content-addressed storage, structurally identical to
  what direct Redis access does today — the control plane mediates the write, it does not become a
  new authorization boundary over bundle contents.

### 2.4 Control plane: `configRef` on the session and in the exchange

- `POST /v1/sessions` body gains an optional `configRef`. The handler validates it with
  `assertValidDigest` (reused, not reimplemented) — a malformed value is a
  `400 { error: 'configRef_invalid' }` at creation time, before any turn is attempted. Reusing
  `knative-server`'s existing error code verbatim (not a differently-spelled sibling) is deliberate:
  it is the same concept — a malformed digest string — surfacing from a second call site.
- It does **not** check the digest actually exists in Redis at this point — that would add a
  round-trip for a check the harness performs on every turn anyway (see §3).
- `SessionRecord` (`ownership.ts`) gains `configRef: string | null`, alongside the existing
  `credentialName`, set once at creation and immutable for the session's lifetime.
- `createSession`, `getSession` and `listSessions` return `configRef` (`null` when none). The echo
  is not a liveness signal: it reflects what was recorded at creation, not whether that digest still
  exists in Redis — a session can echo a `configRef` that has since expired past the 30-day TTL,
  which surfaces only as `config_bundle_not_found` on the next turn (see §3).
- **The exchange carries it to the harness.** `exchangeCredential` already loads the `SessionRecord`
  on every authenticated turn; its `ExchangeResponse` gains `configRef?: string`, present only when
  the session has one. This is what makes "set once at creation" a guarantee rather than a record:
  the harness takes `configRef` from the control plane, never from the request body.

### 2.5 `mocactl`: shared promote core, three entry points

**Dependency exception to ADR-0036.** `mocactl` gains exactly one workspace dependency,
`@moca/config-bundle`. ADR-0036's rule exists to keep `mocactl` free of pi, server internals and
substrate assumptions; `@moca/config-bundle` is pure Node with zero runtime dependencies and none of
those. `layering.test.ts` changes from "no `@moca/*`" to an allow-list of that one package, so a
second exception still fails CI.

A single function, `promoteDirectory(dir, cp)` (`packages/mocactl/src/core/promote.ts`), used by all
callers below:

- **Directory resolution.** `~` and relative paths are expanded against the home directory and the
  process's working directory. If `<dir>/.claude` exists it is the config root (a project, as Claude
  Code lays it out); otherwise, if `<dir>/skills` or `<dir>/commands` exists, `<dir>` itself is the
  config root (the user pointed at a `.claude` directory). Anything else is refused before building:
  "no .claude/skills or .claude/commands under <dir>".
- Treats the config root as **one scope**: `roots: { userDir: <root> }`,
  `promptsDir: <root>/commands`. No `projectDir` and no `pluginDirs` — passing the same path as two
  scopes would double-count skills by name, and plugins are outside "a set of skills in a directory."
- Omits `entry` (§2.1), `memoryDir`, and `contextFiles`.
- Omits `inventory` — `mocactl` may run far from any `moca` checkout; preflight already degrades this
  to a warning.
- Runs `buildBundle` — same preflight/secret-scan gate as ADR-0030. A structural credential match or
  a blocking finding aborts before any network call. A bundle with zero skills and zero prompts is
  refused ("nothing to promote") rather than uploaded. A tar over `MAX_BUNDLE_BYTES` is refused
  locally with the same message the server would give.
- POSTs `{ digest, tar: base64 }` via a new `ControlPlaneApi.putConfigBundle()`.

**`mocactl promote <dir>`** — new top-level CLI command. Prints the summary (skills travelling,
dropped and why, warnings) BEFORE uploading — `promoteDirectory`'s `onBuilt` hook, the report on
stderr — then the digest. `--dry-run` builds and prints without uploading or a login. Exit codes:
2 = refused before upload (a usage error, not logged in, or preflight errors), 3 = a structural
credential match, 1 = anything else.

**`mocactl run "prompt" --config <digest>`** — the existing headless command gains `--config`, passed
as `CreateSessionRequest.configRef`. It applies only when `run` creates a session; combined with
`--session` it is a usage error, because a resumed session's bundle was fixed at its creation.

**In-app `/promote <dir>`** — a new builtin `Command`, **not** gated by `inSession`. On success it
stores the result as **pending, client-side-only state** and opens the `new-session` overlay, which
shows it as an info line ("config bundle sha256:… — N skills, M dropped"). The pending bundle applies
to the **next session created and is then cleared** (with exactly one inference credential and no
presets the overlay creates that session as soon as it opens, so `/promote <dir>` starts it right
away; the toast reads "promoted N skills, M commands — uploaded", plus a warning count pointing at
`mocactl promote <dir> --dry-run`): a bundle silently attaching to every later
session would be the surprise. `/promote --clear` drops it without creating a session. It is not
folded into `SESSION_OPTION_FIELDS`, which is "pick one of several server-known choices"; a freshly
built bundle has no server-side list to pick from.

**No turn-path change in `mocactl`.** `ActiveSession` and `HarnessClient.streamTurn` are untouched:
the harness learns `configRef` from the exchange (§2.4).

### 2.6 Harness: `/v1/turn` applies the session's `configRef`

- **Shared helper.** The resolve/overlay/cleanup sequence in `run-leaf.ts` (`runPromptLeaf`) moves,
  with its comments, into `harness/src/promoted-config.ts` as
  `attachPromotedConfig({ digest, sessionId, sandbox, redisUrl, deps })`, returning
  `{ promotedConfig, detach() }`. The memoised `getBundleRedis` client moves with it. `run-leaf.ts`
  calls the helper; its existing tests (`run-leaf-promoted.test.ts`) are the regression guard for
  the move.
  - Semantics carried over exactly: no sandbox ⇒ resolve only (pi's tools then run in this pod, where
    the pod-side path is the right one); a sandbox ⇒ overlay with the leased transport or a
    `KubectlTransport` built for the purpose; the overlay is considered **attempted** before the
    call, so a partial overlay is still torn down; teardown is best-effort and idempotent.
- **`executeTurn`** gains an optional `configRef`. After the sandbox is acquired and
  `assertServerSandbox` passes, and only when no pre-resolved `promotedConfig` was passed (the
  `/runs` path already resolves its own), it calls `attachPromotedConfig` and passes the result to the
  core; `detach()` runs in the existing `finally`, before the lease is released.
- **`knative-server`.** `TurnAuth` gains `configRef?: string`, taken from the exchange response
  (a present-but-non-string value is a control-plane fault: `credential_unavailable`). Both the sync
  and the SSE branches of `handleTurn` pass `configRef: auth?.configRef` to `executeTurn`. The
  unauthenticated `/turn` path has no session record and therefore never applies a bundle.
- The bundle is fetched before the first frame is streamed, so a missing bundle always surfaces as
  a plain HTTP error, never mid-stream.

## 3. Error handling

- **Preflight / secret-scan block (client-side, all callers):** unchanged from ADR-0030 — nothing is
  uploaded.
- **Bundle too large:** refused client-side, and server-side as `400 invalid_request` naming the
  cap. A body beyond the route's `maxBodyBytes` is the router's existing `invalid_request`.
- **Digest mismatch at upload:** `400 digest_mismatch`. Only reachable from a buggy/tampered client.
- **Malformed `configRef` at session creation:** `400 configRef_invalid` — the exact code
  `knative-server` already returns.
- **Valid digest, never uploaded or expired, at session creation:** the control plane checks the
  bundle exists and answers `404 config_bundle_not_found` ("no config bundle with that digest —
  promote the directory first"). Adopting a stored bundle, and every exchange of a session that has
  one (best effort), refreshes its 30-day TTL and budget entry, so a bundle in use does not age out.
- **Valid digest, not found/expired (30-day TTL) at turn time:** the harness's `BundleNotFoundError`
  maps to **`410 { error: 'config_bundle_not_found' }`** on both the sync and SSE paths (410: it
  existed and is gone). It fails the turn loudly rather than running it without its skills. `mocactl`
  maps that code, from either source, to "this session's config bundle is gone (expired or never uploaded) — promote the same directory again; if it changed, start a new session" (re-promoting the unchanged directory reproduces the same digest,
  because digests are deterministic, and so revives the session; a changed directory has a new
  digest, and a session's bundle is fixed at creation, so it needs a new session).
- **A corrupt stored bundle** (`BundleDigestMismatchError` on read) stays a 500: it is an operator
  fault, not something the user can fix.
- **In-app `/promote` failure:** reported via `h.notify(...)`; no pending bundle is set.

## 4. Alternatives considered

- **Server-side bundle building** — rejected: unscanned file contents would cross the network before
  any preflight/secret-scan runs, and the control plane would carry the classification/scan code for
  no other reason.
- **Owned bundles, like credentials** — rejected for this slice: more consistent with MU1/MU2's
  per-tenant model, but a new store and a check on every turn for a resource that is already an
  unguessable content hash kept free of real secrets by preflight. Deferred.
- **Per-turn client-supplied `configRef`** — rejected: nothing would stop a buggy client from
  switching bundles mid-session. The harness reads it from the exchange instead.
- **Putting `configRef` in the session token's claims** — rejected: the exchange already reads the
  session record on every turn, so a token claim would be a second copy of the same fact, and every
  re-minted token would have to carry it.
- **Session-scoped upload endpoint** (`POST /v1/sessions/{id}/config-bundle`) — rejected: you promote
  before the session exists, and one bundle should be reusable across sessions.
- **A synthetic/placeholder `entry`** — rejected in favor of making `entry` genuinely optional.
- **Vendoring `@moca/config-bundle` into `mocactl`** to keep ADR-0036 absolute — rejected: a stale
  copy of the secret scanner in the client is exactly the drift that matters.

## 5. Testing

- **`@moca/config-bundle`:** `buildBundle` with no `entry` produces no `unknown_entry`/
  `entry_excluded` findings and a lockfile with `entry: ''`, while exclusion warnings still appear;
  existing required-entry tests stay green. The relocated `config-store` tests move with the file.
- **control-plane:** per-route body limit (a 100 KiB body is refused on a default route and accepted
  on `putConfigBundle`); `putConfigBundle` success (`201`, both `uploaded` values), digest mismatch,
  malformed digest, oversize tar, missing principal; `createSession` round-tripping `configRef`
  through `getSession`/`listSessions`, `configRef_invalid`; the exchange response carrying
  `configRef` only when set. The OpenAPI document and error-code taxonomy tests are updated with the
  new route and codes.
- **harness:** `run-leaf-promoted.test.ts` unchanged and green after the extraction;
  `attachPromotedConfig` unit tests (no sandbox ⇒ no overlay; overlay failure ⇒ teardown then rethrow;
  `detach` idempotent); `executeTurn` with `configRef` attaches and detaches, and without it does
  neither.
- **knative-server:** turn-auth carries `configRef` from the exchange and refuses a non-string one;
  `turnErrorStatus` maps `BundleNotFoundError` to 410 with `config_bundle_not_found` on both paths.
- **`mocactl`:** `promoteDirectory` against fixture directories (project layout, `.claude` layout,
  neither, empty, `~` path, blocking secret); CLI exit codes for `mocactl promote`; `run --config`
  sends `configRef` and `run --config --session` is a usage error; `/promote` sets a one-shot pending
  bundle that the next `create` consumes, `/promote --clear` drops it, and a failure sets nothing;
  `config_bundle_not_found` maps to its message; the layering allow-list.
- **End-to-end** (`MOCACTL_LIVE_SMOKE=1`): `mocactl promote` a fixture skills directory against a
  running control plane, `mocactl run --config <digest>` a prompt that asks the model to name its
  skills, and assert the fixture skill's name appears in the reply.

## 6. Consequences / open questions

- Positive: ordinary `mocactl` users on a P6-on-Kubernetes deployment can promote and use their own
  skills with zero cluster credentials.
- Positive: the bundle format, preflight, secret-scan, digest and sandbox materialization are
  untouched, and the interactive path reuses the batch path's overlay code instead of growing a
  second one.
- Negative / accepted cost: a bundle's digest is a bearer capability — any session token can
  reference any digest it knows. Revisit if cross-tenant bundle reuse becomes an actual incident.
- Negative / accepted cost: every authenticated turn on a promoted session fetches and unpacks its
  bundle (the pod-side unpack is digest-cached; the sandbox overlay is refcounted). The cold-turn
  cost should be measured, as ADR-0030 already owes for `/runs`.
- Negative / accepted cost: `mocactl` takes one `@moca/*` dependency, an explicit, test-enforced
  exception to ADR-0036.
- Follow-up owed: `harness/src/promote-cli.ts` and `mocactl`'s `promoteDirectory` both map a
  Claude-Code-shaped directory into `BuildBundleInput`. If a third caller appears, factor the mapping
  into `@moca/config-bundle`.
- Follow-up owed: `GET /v1/config-bundles/{digest}` (metadata only) if bundle reuse across sessions
  turns out to matter in practice.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
