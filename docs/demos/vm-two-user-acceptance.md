# Two users, one VM — `mocactl` login and session ownership on P6

> **The claim:** two people, each on their own laptop with their own GitHub account, log in to the
> same P6 VM with `mocactl`. Each creates and resumes sessions, and neither can see or reach the
> other's. Another user's session is not "forbidden". It **does not exist** (404), and a session
> token for one session cannot drive a turn in another.

This is the acceptance run for VM demo B (#367), and the first manual run of the real GitHub device
flow (#362 item 4). It is written as a demo, so it can be performed. The epic's full walkthrough
(`vm-multi-user-demo.md`, after items A–D of #370) builds on it.

| A shared deployment usually needs                                | This needs                                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| An identity provider, per-user accounts, an admin to create them | One GitHub OAuth app (device flow enabled, no client secret). Anyone with a GitHub account logs in.   |
| Access checks in every handler                                   | One ownership choke point in the control plane, plus the harness's `token.sid == body.sessionId` rule |
| A way to hide other users' objects                               | Nothing extra: a non-owner gets the same 404 as for a session id that never existed                   |

**Tenancy: `MOCA_TENANCY` unset (`single`), as `deploy/vm` ships it.** On this release `single`
has no first-subject pin, so a second subject is served like the first. MI1 §6.6 plans a pin
under which `single` refuses every subject after the first (`403 single_tenant_deployment`). Once
that lands, this run needs `MOCA_TENANCY=multi`, and `multi` needs MI1 S5's sandbox owner binding.
Record the commit you ran against (Act 3).

**Automated sibling.** The same properties, without GitHub, with two minted subjects:
`packages/control-plane/test/two-subject.test.ts` and
`packages/knative-server/test/two-subject-turn.test.ts` (#371). Prefer them for a pass/fail; this
run proves the real login.

## Act 0 — Preconditions

### 0a. The VM (operator)

A VM brought up by `deploy/vm/setup-vm.sh` (item A, #366), with the control plane running and the
supervisor started. Use a GitHub OAuth app with **Enable Device Flow** ticked
(`deploy/vm/README.md`, "The GitHub OAuth app"). On the default SSH-tunnel topology:

```bash
sudo env SH_GITHUB_CLIENT_ID=Ov23li... SH_PUBLIC_HARNESS_URL=http://127.0.0.1:8080 \
  ./deploy/vm/setup-vm.sh
curl -s 127.0.0.1:8090/readyz; echo
grep -E '^SH_REQUIRE_AUTH=' /etc/serverless-harness/supervisor.env
grep -hE '^MOCA_TENANCY=' /etc/serverless-harness/*.env || echo 'MOCA_TENANCY unset'
```

Expected output:

```
ok
SH_REQUIRE_AUTH=true
MOCA_TENANCY unset
```

> Say: `SH_REQUIRE_AUTH=true` is what makes the harness demand a session token on every turn. Without
> it, the harness would accept an unauthenticated turn, and ownership would mean nothing past the
> control plane.

The VM needs outbound HTTPS to `github.com` and `api.github.com`. On a cloud host, **require IMDSv2
with hop limit 1**: container sandboxes have open egress in this round (#357).

### 0b. Each laptop (both users)

- `mocactl` installed (`packages/mocactl/README.md`), plus `curl` and `jq` for Act 2.
- A browser that reaches `https://github.com/login/device`.
- An SSH account on the VM and the tunnel open. **Both users forward the same local ports**,
  because the control plane advertises one harness URL to everyone:

  ```bash
  ssh -N -L 8090:127.0.0.1:8090 -L 8080:127.0.0.1:8080 <vm>
  export SH_CONTROL_PLANE_URL=http://127.0.0.1:8090
  ```

- An inference credential of your own: a gateway token or an Anthropic API key.

> Trap: to rehearse both users on **one** machine, give each its own `XDG_CONFIG_HOME` (e.g.
> `export XDG_CONFIG_HOME=/tmp/user1`). `mocactl` caches one identity per config directory, so a
> second login in the same one replaces the first.

## Act 1 — Each user logs in and runs a turn

Do all of Act 1 as user 1, then as user 2. The steps are identical.

### 1a. Log in

```bash
mocactl login
```

Expected: `mocactl` prints a code and waits. Open the URL, type the code, and approve the app:

```
Open https://github.com/login/device and enter the code ABCD-1234
logged in as Ada Lovelace
```

> If it prints `login failed: github device code failed: device_flow_disabled`, the OAuth app's
> **Enable Device Flow** box is unticked. `incorrect_client_credentials` means
> `SH_GITHUB_CLIENT_ID` is mistyped. Both are VM-side fixes: nothing the user does helps.

### 1b. Store an inference credential

Start `mocactl` (the first run is onboarding), or open **Credentials** with `ctrl+x k`, and add
one with consumer `inference`. The fields are in `packages/mocactl/QUICKSTART.md`, step 4. Kind
`bearer` for a gateway token, `api-key` for a raw Anthropic key.

> Say: each user's turns spend **their own** credential. The operator-key fallback is off.

### 1c. Doctor

```bash
mocactl doctor
```

Expected: all seven checks green:

```
✓ 1 control plane reachable
✓ 2 control plane ready
✓ 3 logged in
✓ 4 inference credential present
✓ 5 harness located — http://127.0.0.1:8080 (advertised by the control plane)
✓ 6 harness reachable
✓ 7 harness trusts this control plane
```

Doctor stops at the first failure and names the fix. Check 7 creates a scratch session and deletes
it, so it proves the harness verifies this control plane's tokens without running a model turn.

### 1d. One turn

```bash
mocactl run "hello — reply with one short sentence"
```

Expected: `session <id>` on stderr, then the reply. **Write the session id down.** Act 2 swaps
them between users. Run a second turn on the same session to show resume:

```bash
mocactl run "what did I just say?" --session <id>
```

## Act 2 — Neither can see or reach the other's

Both users set up a header file from their own login cache. It keeps the API token off every
command line:

```bash
AUTH="${XDG_CONFIG_HOME:-$HOME/.config}/mocactl/auth.json"
CP=http://127.0.0.1:8090 HARNESS=http://127.0.0.1:8080
API_HDR="$(mktemp)"; jq -r '"Authorization: Bearer " + .apiToken' "$AUTH" >"$API_HDR"
curl -s -H @"$API_HDR" "$CP/v1/me"; echo
```

Expected: `{"subject":"github:<numeric id>","tenant":"github:<numeric id>","roles":[]}`. The two
users' subjects differ.

Exchange session ids: user 1's is `$MINE` on user 1's laptop and `$THEIRS` on user 2's, and vice
versa.

### 2a. Session lists are disjoint

```bash
curl -s -H @"$API_HDR" "$CP/v1/sessions" | jq -r '.sessions[].sessionId'
```

Also open **Sessions** in `mocactl` (`ctrl+x l`). Expected: each user sees only the sessions they
created in Act 1. `$THEIRS` appears in neither view.

### 2b. Another user's session is 404, for reading and deleting

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H @"$API_HDR" "$CP/v1/sessions/$THEIRS"
curl -s -o /dev/null -w '%{http_code}\n' -H @"$API_HDR" -X DELETE "$CP/v1/sessions/$THEIRS"
curl -s -o /dev/null -w '%{http_code}\n' -H @"$API_HDR" -X POST "$CP/v1/sessions/$THEIRS/token"
curl -s -o /dev/null -w '%{http_code}\n' -H @"$API_HDR" "$CP/v1/sessions/sess-does-not-exist"
```

Expected: `404` four times. Then the owner checks that the DELETE did nothing:
`curl -s -o /dev/null -w '%{http_code}\n' -H @"$API_HDR" "$CP/v1/sessions/$MINE"` prints `200`.

> Say: the fourth line is the point. Another user's session and a session that never existed get
> the same answer, so the API cannot be used to learn which session ids exist. A 403 would confirm
> the id is real.

### 2c. A token for my session cannot drive a turn in theirs

Mint a session token for **your own** session, then present it for the other user's session id:

```bash
TURN_HDR="$(mktemp)"
curl -s -X POST -H @"$API_HDR" "$CP/v1/sessions/$MINE/token" |
  jq -r '"Authorization: Bearer " + .token' >"$TURN_HDR"
curl -s -w '\n%{http_code}\n' -H @"$TURN_HDR" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg s "$THEIRS" '{sessionId: $s, prompt: "hello"}')" "$HARNESS/v1/turn"
```

Expected (HTTP 400, and no model call is made):

```
{"error":"session_mismatch","message":"token does not name this session","sessionId":"<theirs>"}
400
```

The same token with `sessionId: $MINE` runs a normal turn. The harness checks exactly one rule,
`token.sid == body.sessionId`, and the control plane mints a token only for a session its caller
owns (2b's third line).

## Act 3 — Record the run

Copy this into the run's report (the issue, or the PR that closes it):

| Item                                      | User 1 | User 2 |
| ----------------------------------------- | ------ | ------ |
| Commit / release on the VM                |        |        |
| `MOCA_TENANCY`                            | unset  | unset  |
| 1a `mocactl login` (subject)              |        |        |
| 1c `doctor` all seven green               |        |        |
| 1d `run` + resume                         |        |        |
| 2a own list excludes the other's sessions |        |        |
| 2b GET / DELETE / token / unknown → 404   |        |        |
| 2c cross-session turn → 400 mismatch      |        |        |
| Anything unexpected (add to the fix list) |        |        |

## What just happened

1. Two real GitHub identities logged in through the device flow. The subject is each account's
   numeric id, and the control plane stored no GitHub token.
2. Each user's session list is scoped to its owner at the index (`listByOwner`), not filtered
   after the fact.
3. Every session-scoped route goes through one ownership check that answers 404, so another user's
   session looks exactly like a session that does not exist.
4. The harness refuses a turn whose token names a different session, so a leaked session token
   reaches one session, not the deployment.

## Notes and limits — what this run does **not** claim

- **Session ownership is enforced. Sandbox isolation between users is not.** On the container
  tier, every user's turns lease the same shared sandbox containers
  (`harness/src/select-sandbox.ts:376-434` has no owner filter). The container worker ignores
  `workspace_key` (`remote-worker/internal/exec/runner.go:98`), so all users share `/workspace`,
  the Unix user and the process list. A file user 1's agent writes is readable by user 2's agent.
  The fix is MI1 S5, owner binding (`docs/specs/2026-09-28-moca-multi-user-isolation-design.md`
  §9).
- **Direct credential mode.** With no injector on this VM, a user's real inference secret reaches
  the shared worker for the duration of a turn. MI1 S2's grants replace this.
- **Open egress.** Sandboxes reach the internet, including cloud instance metadata unless IMDSv2
  with hop limit 1 is enforced on the host (#357).
- **Plain HTTP.** The tunnel is the confidentiality. The allowlist topology sends tokens in clear.
- **Anyone with a GitHub account who can reach the control plane can log in.** There is no user
  allowlist. The tunnel (SSH accounts) or the firewall allowlist is the gate.
- **Tenancy as of this writing:** `MOCA_TENANCY` unset. See the top of this page for when that
  stops working.

## Fix list

Found while preparing this run, checked against `main` @ 6836941. Add what the live run finds.

| #   | Finding                                                                                                                                                                                                                                                                            | Status                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | **`/resources` without kubectl.** On a VM, `/v1/sessions/{id}/resources` answers `sandbox.phase: "unknown"`, and `mocactl` never calls the route, so nothing breaks. The route also reports `harness.mode: "knative"` on P6: `resources.ts` guesses the mode from the pod name.    | Cosmetic. Make the mode honest when the route gains a VM consumer.                                    |
| 2   | **Token expiry mid-demo.** Session tokens (5 min) re-mint on their own. An expired API token (1 h) makes the TUI open its login overlay and replay the prompt, and makes headless `mocactl run` say to run `mocactl login`. So a demo longer than an hour asks for a second login. | Works as designed. For a long demo, set `SH_API_TOKEN_TTL_SECONDS` in `control-plane.env` beforehand. |
| 3   | **One identity per `XDG_CONFIG_HOME`.** Two users on one machine overwrite each other's `auth.json`.                                                                                                                                                                               | #404: `mocactl --profile`.                                                                            |
| 4   | **`device_flow_disabled` has no hint.** The login error is GitHub's code, verbatim. It is diagnosable with this page or the QUICKSTART, but not on its own.                                                                                                                        | #405: map both codes to the fix.                                                                      |
| 5   | **No headless `sessions` or `credentials` command.** Act 2 lists sessions with `curl`, and credentials can be added only in the TUI.                                                                                                                                               | #406: `mocactl sessions [--json]`.                                                                    |
| 6   | **MI1 S2 first-subject pin.** Once it lands, this run under `MOCA_TENANCY=single` refuses user 2 with `403 single_tenant_deployment`.                                                                                                                                              | #407: blocks this run once S2 merges; re-pin tenancy then.                                            |
| 7   | **Shared `/workspace` on the container tier.** User 2's agent can see user 1's clone ("Notes and limits").                                                                                                                                                                         | #408: per-session directory (not a boundary).                                                         |

## Cleanup

On each laptop: `rm -f "$API_HDR" "$TURN_HDR"`. Delete this run's sessions in **Sessions**
(`ctrl+x l`, then `d`), and remove `"${XDG_CONFIG_HOME:-$HOME/.config}/mocactl/auth.json"` to log
out. On GitHub, each user can revoke the app under **Settings → Applications → Authorized OAuth
Apps**. The operator can delete the OAuth app when the demo is over. The control plane keeps no
GitHub token, so there is nothing to revoke on the VM.
