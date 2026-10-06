# `mocactl promote` — config-bundle promotion through the control plane — Design

**Date:** 2026-10-06 · **Status:** Proposed · **ADR:** [ADR-0038](../adrs/0038-mocactl-config-bundle-promotion.md)
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

> **The one-sentence thesis.** The config-bundle mechanism ADR-0030 built already does everything
> this needs — build, preflight, scan, digest, materialize — it was just wired to a direct
> `kubectl port-forward` + Redis tunnel that assumes a developer sitting on the cluster. This design
> moves the upload hop behind the control plane's existing `/v1` HTTP API so any `mocactl` user can
> promote a skills directory and start a session with it, with no cluster credentials at all.

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

Two smaller gaps compound this:

- `buildBundle` requires an `entry` — one `.claude/commands/<name>.md` prompt name — because
  ADR-0030 was designed around headless/batch dispatch (`run-leaf.ts`), where one fixed prompt
  template is "the task." `mocactl` sessions are interactive chat with no such fixed first prompt.
- `mocactl` creates sessions and streams turns against the harness already (ADR-0036), but neither
  `POST /v1/sessions` nor `POST /v1/turn`'s client-side call site carries a `configRef` today, even
  though the harness side (`knative-server`'s `/v1/turn` validation, `config-resolver.ts`'s unpack)
  already fully supports one — it was built for `run-leaf.ts`'s envelope and never wired to the
  interactive path.

## 2. Decision

We will add a **control-plane-mediated upload path** for the exact same content-addressed bundle
ADR-0030 already defines, and wire the resulting digest through `mocactl`'s existing session
lifecycle as `configRef`. Nothing about the bundle format, preflight, secret-scan, or sandbox
materialization changes — only how the tar gets from a user's machine into the same Redis store, and
how a `mocactl` session comes to reference it.

```
mocactl promote <dir>  ──┐
                          │  build bundle locally (@moca/config-bundle) — preflight + secret-scan
/promote <dir> (in-app) ─┤  run on the CLIENT, same as ADR-0030's /promote
                          │
                          ▼
                 POST /v1/config-bundles   (control plane, auth: api)   ← NEW
                          │  re-verifies digest, stores tar in Redis (putBundle, unchanged logic)
                          ▼
                     { digest, uploaded }
                          │
                          ▼
        POST /v1/sessions { configRef: digest }   (control plane)       ← NEW optional field
                          │  records configRef on SessionRecord, like credentialName
                          ▼
            mocactl holds { sessionId, token, configRef }
                          │
                          ▼
   POST /v1/turn { sessionId, prompt, configRef }   (straight to the harness — unchanged route)
                          │
                          ▼
   harness unpacks the digest's skills into the sandbox (config-resolver.ts — unchanged, already works)
```

The only new wire surface is `POST /v1/config-bundles` and an optional `configRef` on
`POST /v1/sessions`. Everything from "harness receives a turn carrying `configRef`" downward already
works today for the batch path; this design only extends who can produce a valid `configRef` and how
it reaches an interactive session.

### 2.1 `@moca/config-bundle`: `entry` becomes optional

- `BuildBundleInput.entry` changes from `string` to `string | undefined`.
- When omitted, `checkEntry` and `checkExcludedPrompts` are skipped entirely — no `unknown_entry` /
  `entry_excluded` findings — and `BundleLockfile.entry` is written as `''` rather than the field
  being made optional there, so every existing reader of the lockfile keeps a plain `string`.
- Preflight otherwise runs exactly as before (classification, secret-scan, binary checks): omitting
  `entry` only removes the one check that is meaningless without a fixed first prompt. A bundle built
  this way may legitimately carry zero prompt templates.
- `harness/src/promote-cli.ts` (ADR-0030's CLI) keeps `--entry` **required** — that path is still
  headless/batch dispatch, where an entry prompt is the task. Only the new client-side path in
  `mocactl` omits it.

### 2.2 Moving the bundle store so the control plane can use it

`putBundle` / `getBundle` / `BundleRedisLike` / `bundleKey` and their errors currently live in
`harness/src/config-store.ts` — a harness-internal module `@moca/config-bundle` doesn't own.
Control-plane needs that exact logic (digest re-verification, gzip/base64, Redis storage) for the new
endpoint. Duplicating it would let the two copies drift; depending on `@moca/harness` from
`@moca/control-plane` runs the dependency the wrong way (control plane is the lower-level service).

We move `config-store.ts` unchanged into `@moca/config-bundle` (which already owns `contentDigest`
and `untar`, the two functions it calls). `harness/src/config-resolver.ts` updates its import; no
behavior changes.

### 2.3 Control plane: `POST /v1/config-bundles`

New route, declared in `routes.ts` like every other:

```
POST /v1/config-bundles   auth: api   sessionScoped: false   operationId: 'putConfigBundle'
```

- **Request:** `{ digest: string, tar: string }` — `tar` base64-encoded, matching the encoding
  `putBundle` already uses internally. No multipart handling needed.
- **Handler:** decode base64 → `Buffer`; call `putBundle(redisClient, digest, buffer)` using the same
  Redis client `main.ts` already constructs for `OwnershipIndex`. `putBundle` already re-verifies the
  claimed digest against the tar's actual content before writing — a mismatch surfaces as
  `BundleDigestMismatchError`, mapped to `400 { error: 'digest_mismatch' }`.
- **Response:** `201 { digest, uploaded }` — `uploaded: false` means the digest already existed and
  only its TTL was refreshed, exactly the semantics `promote-cli.ts` already prints today.
- **No ownership record.** Per the scoping decision below, this is intentionally just
  content-addressed storage, structurally identical to what direct Redis access does today — the
  control plane is a mediator for the write, not a new authorization boundary over bundle contents.

### 2.4 Control plane: `configRef` on session creation

- `POST /v1/sessions` body gains an optional `configRef`. The handler validates it with
  `assertValidDigest` (reused, not reimplemented) — a malformed value is a `400 { error:
  'invalid_configRef' }` at creation time, before any turn is attempted.
- It does **not** check the digest actually exists in Redis at this point — that would add a
  round-trip for a check the harness already performs correctly on first turn (see §3).
- `SessionRecord` (`ownership.ts`) gains `configRef: string | null`, alongside the existing
  `credentialName`, set once at creation and immutable for the session's lifetime — the same pattern
  `credentialName` already establishes, chosen deliberately (§4 below) over letting a client swap
  bundles mid-session.
- `createSession` and `getSession` echo `configRef` back in their response bodies.

### 2.5 `mocactl`: shared promote core, two entry points

A single function, `promoteDirectory(dir, cp): Promise<PromoteResult>` (`packages/mocactl/src/core/promote.ts`),
used by both callers below:

- Treats `<dir>` as **one scope**, not a project/user split: `roots: { userDir: join(dir, '.claude') }`,
  `promptsDir: join(dir, '.claude', 'commands')`. ADR-0030's project-vs-`~/.claude` distinction exists
  because that path reuses a real developer checkout's two real scopes; "a set of skills in a
  directory" is one scope, and passing the same path as both `projectDir` and `userDir` would risk
  double-counting skills by name across scopes for no benefit.
- Omits `entry` (§2.1), `memoryDir`, and `contextFiles` — there is no live Claude Code project memory
  or `CLAUDE.md` chain to carry for a bare skills directory.
- Omits `inventory` — `mocactl` is a standalone client (ADR-0036) that may run far from any `moca`
  checkout, so there is no local `deploy/knative/sandbox-inventory/` to read. Preflight already
  degrades this to a warning ("cannot verify binaries"), not an error, exactly as it does today when
  no inventory file is found.
- Runs `buildBundle` — same preflight/secret-scan gate as ADR-0030, unchanged. A structural credential
  match or a blocking finding aborts before any network call is made.
- POSTs `{ digest, tar: base64 }` to the new endpoint via a `putConfigBundle()` method added to
  `ControlPlaneApi` (`api/control-plane.ts`), alongside the existing `createSession` etc.
- Returns `{ digest, uploaded, skillCount, droppedSkills, warnings }` for both callers to render.

**`mocactl promote <dir>`** — new top-level CLI command. Calls `promoteDirectory`, prints the same
kind of summary (skills travelling/dropped and why, secret-scan warnings, digest), and exits with the
same codes ADR-0030 already established (2 = preflight errors, 3 = a structural credential match).

**`mocactl session new --config <digest>`** — new flag on headless/scripted session creation, passed
straight through as `CreateSessionRequest.configRef`.

**In-app `/promote <dir>`** — a new builtin `Command` (`commands/builtin.ts`), **not** gated by
`inSession`: you promote before a session necessarily exists. `run(h, arg)` calls
`h.promoteBundle(arg)`. On success it stores the digest as **pending, client-side-only state** —
deliberately not folded into the `SESSION_OPTION_FIELDS` abstraction (`session-options.ts`), because
that abstraction is "pick one of several server-known choices" (today: inference credentials) and a
freshly-built bundle has no server-side "list of my bundles" to pick from; it is simply "the thing I
just built." It shows a notification with the digest/skill-count summary and opens the `new-session`
overlay with that pending digest pre-filled as an info line ("Config bundle: `sha256:…` — N skills, M
dropped"), with a way to clear it before confirming. `create()` in `app.tsx` includes `configRef` in
`CreateSessionRequest` whenever a pending digest is set.

**Turn wiring:** `ActiveSession` (`core/session-manager.ts`) stores the `configRef` returned by
`createSession`/`getSession` and includes it on every `streamTurn` call's body —
`HarnessClient.streamTurn` gains a `configRef` parameter sent alongside `sessionId`/`prompt`.
`/v1/turn` already accepts and validates it (`configRefValid`, unchanged).

## 3. Error handling

- **Preflight / secret-scan block (client-side, both callers):** unchanged from ADR-0030 — a
  structural credential match throws before any network call; blocking findings abort with the same
  exit code / "promote BLOCKED" messaging the existing CLI already uses.
- **Digest mismatch at upload:** `putBundle` already re-verifies digest vs. tar content server-side;
  a mismatch is `400 digest_mismatch`. Only reachable from a buggy/tampered client, kept as a cheap
  server-side check rather than trusting the caller's claim.
- **Malformed `configRef` at session creation:** `400 invalid_configRef`, same shape as
  `knative-server`'s existing `configRef_invalid` for `/v1/turn`, reused at creation time too.
- **Valid digest, not found/expired (30-day TTL) at turn time:** this surfaces downstream, on the
  harness, not at session creation — the control plane does not check Redis existence when recording
  `configRef` (§2.4). The harness's existing `BundleNotFoundError` already fails the turn loudly
  rather than silently dropping to no-skills; the one new piece is mapping that error text in
  `mocactl`'s `api/errors.ts` to a clear message ("config bundle expired or not found — re-run
  `/promote`") instead of a generic turn failure.
- **In-app `/promote` failure** (bad directory, no `.claude/skills` found, network error reaching the
  control plane): reported via `h.notify(...)`, same as other command failures. No pending digest is
  set, so a stale or empty state cannot silently flow into the next session.

## 4. Alternatives considered

- **Server-side bundle building** (control plane runs `buildBundle` from uploaded raw files) —
  rejected: unscanned file contents would cross the network before any preflight/secret-scan runs,
  and control plane would need the full `@moca/config-bundle` classification/scan dependency it has
  no other reason to carry. Client-side building keeps ADR-0030's "nothing sensitive leaves the
  machine until preflight passes" property intact.
- **Owned bundles, like credentials** (record uploader identity, check ownership before a session may
  reference a digest) — rejected for this slice: it is more consistent with MU1/MU2's per-tenant
  model, but adds a new ownership store and a check on every turn for a resource that is already an
  unguessable content hash and that preflight already keeps free of real secrets. Deferred as a
  follow-up if bundle sharing/leakage across tenants becomes a real concern.
- **Per-turn client-supplied `configRef`** (no control-plane session schema change; `mocactl` just
  resends the digest on every `/v1/turn` call) — rejected: nothing would stop a buggy client from
  switching bundles mid-session, and the control plane would have no record of what a session is
  actually running. Session-level, set-once-at-creation mirrors `credentialName`'s existing design and
  closes both gaps for one small schema addition.
- **Session-scoped upload endpoint** (`POST /v1/sessions/{id}/config-bundle`) — rejected: ties upload
  to a session that doesn't exist yet at the point you'd want to promote, and makes reusing one
  promoted bundle across multiple session starts awkward.
- **A synthetic/placeholder `entry`** just to satisfy `buildBundle`'s existing validation — rejected in
  favor of making `entry` genuinely optional (§2.1): a placeholder would be dead weight carried
  through the lockfile and digest forever, for a check that is meaningless without a real headless
  entry point.

## 5. Testing

- **`@moca/config-bundle`:** `buildBundle` with no `entry` produces no `unknown_entry`/
  `entry_excluded` findings and a lockfile with `entry: ''`; existing required-entry tests for the
  harness CLI path stay green. The relocated `config-store.ts` tests (fake `BundleRedisLike`) move
  with the file, behavior unchanged.
- **control-plane:** the route table's own authz-enumeration test picks up `POST /v1/config-bundles`
  automatically; handler tests for success (`201`, both `uploaded` values), digest mismatch (`400`),
  and `createSession`/`getSession` round-tripping `configRef` (including `invalid_configRef` and that
  audit records are unaffected by the new field).
- **`mocactl`:** `promoteDirectory` unit tests against a fixture directory with a fake
  `ControlPlaneApi`; CLI exit-code tests for `mocactl promote` mirroring
  `deploy/claude/tests/promote-command.test.sh`'s coverage (clean promote, preflight error,
  secret-scan block); an `ActiveSession`/`streamTurn` test asserting `configRef` flows from the
  `createSession` response into every turn body; an app-level test that a successful `/promote`
  populates the new-session overlay's pending digest and a failure does not.
- **End-to-end:** promote a small fixture skills directory via `mocactl promote` against a running
  control plane, start a session with `--config <digest>`, send one turn, and confirm the sandbox
  actually sees the promoted skill — same assertion style the existing P6 smoke tests already use for
  other config paths.

## 6. Consequences / open questions

- Positive: ordinary `mocactl` users on a P6-on-Kubernetes deployment can promote and use their own
  skills with zero cluster credentials — the gap this design exists to close.
- Positive: the bundle format, preflight, secret-scan, digest, and sandbox materialization are
  completely untouched; this is additive plumbing around an already-proven mechanism.
- Negative / accepted cost: a bundle's digest is a bearer capability — any session token can
  reference any digest it knows, with no per-tenant ownership check (§4). Acceptable because preflight
  already keeps real secrets out of bundles and a digest is not discoverable by guessing, but revisit
  if cross-tenant bundle reuse becomes an actual incident rather than a theoretical one.
- Follow-up owed: `harness/src/promote-cli.ts` and `mocactl promote` now both implement "read a
  Claude-Code-shaped directory into `BuildBundleInput`," independently, because the harness CLI's
  version is tangled with argv parsing and harness-module-relative inventory lookup that don't belong
  in `mocactl`. If a third caller appears, factor the shared "directory → `BuildBundleInput`" mapping
  (minus CLI concerns) into `@moca/config-bundle` itself rather than letting a third copy appear.
- Follow-up owed: `GET /v1/config-bundles/{digest}` (metadata only — skill names, size, upload time)
  would let `/promote`'s in-app flow show something richer than "the thing I just built" if bundle
  reuse across sessions turns out to matter in practice.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
