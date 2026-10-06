# ADR-0038: Promote config bundles through the control plane, not a direct Redis tunnel

- **Status:** Proposed <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-10-06
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-10-06-mocactl-config-bundle-promotion-design.md`](../specs/2026-10-06-mocactl-config-bundle-promotion-design.md)

## Context

ADR-0030 built config-bundle promotion — build a Claude-Code-shaped `.claude/skills` +
`.claude/commands` directory into a content-addressed tar, preflight/secret-scan it, upload to Redis,
reference it from a turn as `configRef: sha256:…`. The only shipped uploader is a Claude Code slash
command that shells out to `pnpm --dir <harness> promote`, which writes to the cluster's Redis
directly over a `kubectl port-forward` tunnel the caller holds open. That fits the one developer who
already has `kubectl` access to the cluster.

ADR-0037 and the P6-on-Kubernetes slices stand up an always-on, multi-user control plane (ADR-0033)
that ordinary users reach only over its public `/v1` HTTP API — device-flow login, an API token, no
`kubectl` context, no Redis credentials. `mocactl` (ADR-0036) is that API's terminal client, and it
already creates sessions and streams turns against the harness. But there is no way for a `mocactl`
user to get their own skills into a session: the only promotion path requires exactly the cluster
access MU1 exists to avoid handing out, and neither `POST /v1/sessions` nor `mocactl`'s turn call
carries a `configRef` at all today, even though the harness side already fully supports one.

Separately, `buildBundle` requires an `entry` (one `.claude/commands/<name>.md` prompt), because
ADR-0030 was designed around headless/batch dispatch where one fixed prompt is "the task." `mocactl`
sessions are interactive chat with no such fixed first prompt, so that requirement doesn't transfer.

## Decision

We will add a control-plane-mediated upload for the **same** bundle ADR-0030 already defines — no
format, preflight, secret-scan, or sandbox-materialization change — and wire the resulting digest
through `mocactl`'s session lifecycle:

1. **`POST /v1/config-bundles`** (new control-plane route, `auth: api`): accepts a client-built
   `{ digest, tar }` (base64), re-verifies the digest against the tar server-side, and stores it in
   Redis via the existing `putBundle` logic — relocated from `harness/src/config-store.ts` into
   `@moca/config-bundle` so control-plane can call it without depending on the harness package.
2. **`configRef` becomes an optional field on `POST /v1/sessions`**, validated and recorded once on
   `SessionRecord` at creation (mirroring `credentialName`'s existing immutable-per-session design),
   and echoed back by `createSession`/`getSession`.
3. **`mocactl` builds the bundle client-side** (`@moca/config-bundle`, same preflight/secret-scan gate
   as ADR-0030's CLI) via a shared `promoteDirectory` core used by a new `mocactl promote <dir>` CLI
   command, a new `mocactl session new --config <digest>` flag, and a new in-app `/promote <dir>`
   command that feeds the digest into the new-session overlay.
4. **`entry` becomes optional** in `BuildBundleInput`/`buildBundle` — omitting it skips only the
   entry-specific preflight checks; a bundle with no entry may legitimately carry zero prompt
   templates, which is the normal case for an interactive-only promotion.
5. **No bundle ownership record.** A digest stays a bare content-addressed key, exactly as it is in
   Redis today; any session token that knows a digest may reference it. The control plane mediates
   the write so a user never needs cluster credentials — it does not become a new authorization
   boundary over bundle contents.

### Alternatives considered

- **Server-side bundle building** (control plane runs `buildBundle` from uploaded raw files) — rejected: unscanned file contents would cross the network before any secret-scan runs, breaking ADR-0030's "nothing sensitive leaves the machine until preflight passes" property.
- **Owned bundles, like credentials** (uploader identity recorded, ownership checked per session) — deferred, not rejected outright: more consistent with MU1/MU2's per-tenant model, but adds a new store and a check on every turn for a resource that is already an unguessable hash and already kept secret-free by preflight.
- **Per-turn client-supplied `configRef`** (no session schema change; resend the digest on every `/v1/turn` call) — rejected: nothing would stop a client bug from swapping bundles mid-session, and the control plane would have no record of what a session is running.
- **A synthetic/placeholder `entry`** to satisfy the existing validation unchanged — rejected in favor of making `entry` genuinely optional, since a placeholder would be dead weight carried through the lockfile and digest forever.

## Consequences

- Positive: a `mocactl` user on a P6-on-Kubernetes deployment can promote and use their own skills
  with zero cluster credentials — the gap this decision closes — while the bundle mechanism itself
  (format, preflight, secret-scan, digest, sandbox materialization) stays exactly as ADR-0030 proved
  it.
- Positive: `configRef` set once at session creation, immutable for the session's life, follows the
  same shape `credentialName` already established — no new session-lifecycle concept.
- Negative / accepted cost: a bundle digest is a bearer capability with no per-tenant ownership check
  — any session token that knows a digest can reference it. Accepted because preflight already keeps
  real secrets out and a digest isn't guessable; revisit if cross-tenant bundle reuse becomes a real
  incident rather than a theoretical one.
- Negative / accepted cost: "read a Claude-Code-shaped directory into `BuildBundleInput`" now has two
  independent implementations — the harness CLI's (tangled with argv parsing and
  harness-module-relative inventory lookup) and `mocactl`'s (a single flat scope, no inventory, no
  entry). Acceptable for two callers; a third should prompt factoring the shared mapping into
  `@moca/config-bundle` itself.
- Follow-up owed: `GET /v1/config-bundles/{digest}` (metadata only) if bundle reuse across sessions
  turns out to matter enough that "the thing I just built" isn't a good enough affordance in the
  in-app `/promote` flow.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
