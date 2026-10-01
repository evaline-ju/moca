# Two users, one VM, two sandbox tiers: the MOCA VM demo

> **The claim:** one Linux VM runs the whole stack: the P6 supervisor, relay, control plane and
> Redis, container sandboxes, and the P4 Firecracker microVM worker. Two people, each on their own
> laptop with their own GitHub account, log in with `mocactl`. Each one's agent researches live
> internet content with `curl` and `git` in its sandbox, spending that user's own inference
> credential, and neither user can see or reach the other's sessions. Then the same VM switches
> to the microVM tier, and every tool call runs in a fresh Firecracker VM over a per-session
> workspace.

**Status: drafted, not yet performed end to end.** Every step comes from a verified piece:
the two-user acceptance runbook ([`vm-two-user-acceptance.md`](./vm-two-user-acceptance.md), #403),
the P4 tier on a P6 host ([`deploy/microvm/P4-ON-P6.md`](../../deploy/microvm/P4-ON-P6.md),
#376 and #409), and the research turn ("A research turn" in
[`deploy/vm/README.md`](../../deploy/vm/README.md), and `deploy/vm/research-smoke.sh`, from #368
via #411, which this page needs merged first). The whole sequence on one VM, with two
real GitHub accounts, has not been run. Expected output marked _illustrative_ is the shape to
look for, not a recorded run. Act 5 is the record to fill in, and the first run replaces this
paragraph.

| A shared agent deployment usually needs                          | This needs                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A Kubernetes cluster, an identity provider, per-user accounts    | One VM under systemd, and one GitHub OAuth app (device flow on, no client secret)            |
| A shared model key, or a secrets service to hand out user keys   | Each user stores their own credential; the control plane resolves it per turn, and audits it |
| A separate fleet, or a separate deployment, for VM-grade sandbox | The P4 microVM worker on the same host, attached to the same relay under its own relay token |
| Access checks in every handler                                   | One ownership check in the control plane: another user's session answers 404, like a bad id  |

**Roles.** The **operator** has a shell on the VM. **User 1** and **user 2** each have a laptop, a
GitHub account, and an SSH account restricted to the tunnel (0c). The operator can also play
user 1.

**Order matters.** The container tier comes first (Acts 1 to 3), the microVM tier last (Act 4).
A host serves one tier at a time, and going back to containers means re-running `setup-vm.sh`,
which recreates Redis and forgets every session (#410). Switching to P4 needs no re-run, so it is
the one switch made during the demo.

**Tenancy: `MOCA_TENANCY` unset (`single`), as `deploy/vm` ships it.** On this release `single`
has no first-subject pin, so user 2 is served like user 1. Once MI1 S2's pin lands, `single`
refuses every subject after the first (`403 single_tenant_deployment`), and this demo needs
`MOCA_TENANCY=multi`, which needs MI1 S5's sandbox owner binding (#407). Record the commit you ran
against (Act 5).

**Automated siblings.** Prefer these for a pass/fail; the demo is for convincing a room.

- Two subjects, no GitHub: `packages/control-plane/test/two-subject.test.ts` and
  `packages/knative-server/test/two-subject-turn.test.ts` (#371).
- The research turn: `deploy/vm/research-smoke.sh` (#411, `VM_RESEARCH_SMOKE=1`).
- The P4 tier with auth on: `deploy/microvm/p4-turn-smoke.sh --auth` (#409).

## Act 0 — Preparation (operator, the day before)

### 0a. P6 with the control plane and the GitHub OAuth app

Bring the VM up with `deploy/vm/setup-vm.sh` and a GitHub OAuth app with **Enable Device Flow**
ticked (`deploy/vm/README.md`, "Bring it up" and "The GitHub OAuth app"). On the SSH-tunnel
topology, pass both control-plane settings. On a fresh VM this is the **second** run, once
`SH_RELAY_TOKEN` is set:

```bash
cd /opt/serverless-harness
sudo env SH_GITHUB_CLIENT_ID=<client id> SH_PUBLIC_HARNESS_URL=http://127.0.0.1:8080 \
  ./deploy/vm/setup-vm.sh
```

**Lengthen the login for the demo.** An API token lasts an hour (`SH_API_TOKEN_TTL_SECONDS=3600`).
When it lapses mid-demo, the interactive UI opens its login overlay and replays the prompt, and a
headless `mocactl run` stops with "your login has expired — run `mocactl login`". Both recover,
but a second device-flow login in front of a room costs a minute. Set four hours instead:

```bash
sudoedit /etc/serverless-harness/control-plane.env   # SH_API_TOKEN_TTL_SECONDS=14400
sudo systemctl restart sh-control-plane
```

Only tokens minted after the restart get the new lifetime, so the users log in after this (Act 1).
Session tokens (300 s) re-mint on their own and need nothing.

**On a cloud host, require IMDSv2 with a hop limit of 1.** Container sandboxes have open egress in
this round, instance metadata included (#357). The research act depends on that egress, so this is
not optional. The VM also needs outbound HTTPS to `github.com` and `api.github.com`, and the
sandboxes to `github.com` and `nodejs.org`.

### 0b. Install the P4 tier, rehearse it, then park it

The microVM worker is installed now, while nobody depends on the sessions, and stopped until
Act 4. Follow `deploy/microvm/P4-ON-P6.md`:

1. **Build the golden snapshot** ("Build the golden snapshot"). The container sandboxes can keep
   running for this.
2. **Remove the container sandboxes and install the worker.** `setup-microvm.sh` refuses while
   any `sh-sandbox-*` container exists:

   ```bash
   sudo podman rm -f $(sudo podman ps -a --format '{{.Names}}' --filter 'name=^sh-sandbox-')
   cd /opt/serverless-harness && sudo deploy/microvm/setup-microvm.sh        # on a host under 24 GiB: MICROVM_MAX_COMMITTED_MB=8192
   ```

3. **Rehearse it:** `p4-turn-smoke.sh --auth --failure-paths` ("Automated check"), then its
   cleanup.
4. **Park it, and bring the containers back.** This `setup-vm.sh` re-run recreates Redis and so
   forgets every session (#410). That is harmless now, and is why it happens today:

   ```bash
   sudo systemctl disable --now microvm-worker.service
   sudo podman exec sh-redis redis-cli HDEL sh:sandbox:records moca_microvm_0
   cd /opt/serverless-harness && sudo ./deploy/vm/setup-vm.sh
   ```

The relay keeps the worker's token: `setup-vm.sh` leaves `setup-microvm.sh`'s relay drop-in in
place. So in Act 4, starting the worker is enough to attach it.

**Rehearse the research turn** on the container tier ("A research turn" in `deploy/vm/README.md`),
with a key of your own. This needs #411's smoke:

```bash
cd /opt/serverless-harness
sudo install -m 0600 /dev/null /root/inference-key && sudoedit /root/inference-key
sudo VM_RESEARCH_SMOKE=1 RESEARCH_CREDENTIAL_FILE=/root/inference-key ./deploy/vm/research-smoke.sh
sudo rm -f /root/inference-key
```

> Trap: from here until Cleanup, **do not re-run `setup-vm.sh`.** Every re-run loses every user's
> sessions (#410), and a re-run while the microVM worker is enabled starts the containers next to
> it, so both tiers attach and sessions hop between them.

### 0c. The participants' SSH accounts

Restrict each participant's account to the two forwarded ports: `vm-two-user-acceptance.md`, 0a,
"Restrict the participants' SSH accounts to the tunnel". Loopback Redis holds the ownership index
with no authentication, so an unrestricted account could take over any session.

### 0d. Check what is running (operator, on the day)

```bash
curl -s 127.0.0.1:8090/readyz; echo
sudo sh <<'EOF'
pid=$(systemctl show -p MainPID --value sh-supervisor.service)
[ "${pid:-0}" -gt 0 ] || { echo 'sh-supervisor is not running' >&2; exit 1; }
env=$(tr '\0' '\n' <"/proc/$pid/environ") || exit 1
printf '%s\n' "$env" | grep -E '^SH_REQUIRE_AUTH=' || echo 'SH_REQUIRE_AUTH unset'
printf '%s\n' "$env" | grep -E '^MOCA_TENANCY=' || echo 'MOCA_TENANCY unset'
pid=$(systemctl show -p MainPID --value sh-control-plane.service)
[ "${pid:-0}" -gt 0 ] || { echo 'sh-control-plane is not running' >&2; exit 1; }
env=$(tr '\0' '\n' <"/proc/$pid/environ") || exit 1
printf '%s\n' "$env" | grep -E '^SH_ALLOW_OPERATOR_FALLBACK=' || echo 'SH_ALLOW_OPERATOR_FALLBACK unset'
printf '%s\n' "$env" | grep -E '^SH_API_TOKEN_TTL_SECONDS=' || echo 'SH_API_TOKEN_TTL_SECONDS unset'
EOF
systemctl is-enabled microvm-worker.service
sudo podman exec sh-redis redis-cli HKEYS sh:sandbox:records
```

Expected output:

```
ok
SH_REQUIRE_AUTH=true
MOCA_TENANCY unset
SH_ALLOW_OPERATOR_FALLBACK unset
SH_API_TOKEN_TTL_SECONDS=14400
disabled
sh-sandbox-0
sh-sandbox-1
```

The script reads the **running** processes, not their env files, and exits before printing more
if it cannot. `SH_ALLOW_OPERATOR_FALLBACK=false` passes too: the fallback is on only at `true`,
and with it off every turn has to spend its user's own credential. The last line is the tier: two
container sandboxes, and no `moca_microvm_0`.

## Act 1 — Two users log in

Do all of Act 1 as user 1, then as user 2. Each laptop needs `mocactl`
(`packages/mocactl/README.md`), `jq`, a browser, and an inference credential of its user's own: a
gateway token or an Anthropic API key. (The blocks run on the laptops have no `#` comments, so
they paste cleanly into macOS's default zsh.)

### 1a. Open the tunnel

```bash
ssh -f -N -M -S ~/.ssh/moca-tunnel -o ExitOnForwardFailure=yes \
  -L 8090:127.0.0.1:8090 -L 8080:127.0.0.1:8080 <account>@<vm>
export SH_CONTROL_PLANE_URL=http://127.0.0.1:8090
```

Both users forward the **same** local ports, because the control plane advertises one harness URL
(`http://127.0.0.1:8080`) to everyone. Prove the account is restricted before going on
(`vm-two-user-acceptance.md`, 0b):

```bash
ssh <account>@<vm> true
printf 'PING\r\n' | ssh -W 127.0.0.1:6379 <account>@<vm>
```

Expected: `This account is currently not available.`, then `administratively prohibited: open
failed`. A `+PONG` means 0c does not apply to this account: stop and fix it.

> Trap: to rehearse both users on one machine, give each its own `XDG_CONFIG_HOME`
> (`export XDG_CONFIG_HOME=/tmp/user1`). `mocactl` keeps one identity per config directory (#404),
> and open the tunnel once only.

### 1b. Log in

```bash
mocactl login
```

Expected: a code, then, once it is entered at `https://github.com/login/device` and the app
approved:

```
Open https://github.com/login/device and enter the code ABCD-1234
logged in as <your GitHub name>
```

> If it prints `login failed: github device code failed: device_flow_disabled`, the OAuth app's
> **Enable Device Flow** box is unticked. `... failed: Not Found` means `SH_GITHUB_CLIENT_ID` is
> mistyped. Both are fixed on the VM and on GitHub; nothing the user does helps, and neither
> message says so yet (#405).

### 1c. Store your own inference credential

Start `mocactl`, open **Credentials** with `ctrl+x k`, and add one with consumer `inference`:

- **An Anthropic API key** (`sk-ant-api…`): kind `api-key`, destination host `api.anthropic.com`,
  gateway endpoint `https://api.anthropic.com` (no `/v1`), and the key pasted as is into the
  **API key** field.
- **A gateway token:** kind `bearer`, with the fields in `packages/mocactl/QUICKSTART.md`, step 4.

> Say: this key is yours, not the operator's. The control plane stores it encrypted, and resolves
> it for each of your turns. There is no shared model key on this VM: the operator-key fallback is
> off (0d).

### 1d. Doctor

```bash
mocactl doctor
```

Expected: all seven checks green, ending `✓ 7 harness trusts this control plane`. Doctor stops at
the first failure and names the fix.

## Act 2 — Research from the sandbox

The agent's bash tool runs in a container sandbox on the VM. The sandbox reaches the internet, so
the agent can clone a repository and fetch a file, and answer from what it found rather than from
memory.

### 2a. User 1 asks a question only the live internet can answer

The prompt is `deploy/vm/README.md`'s, with the directory made per user: on the container tier
the users share `/workspace` (2d), and `git clone` refuses a directory that already exists. User 1
uses `research-user1`, user 2 `research-user2`:

```bash
D=research-user1
P="This is a research task. Use your bash tool for every step, and do not answer from memory.
1. Run: git clone --depth 1 https://github.com/rossoctl/moca /workspace/$D/moca
2. Run: curl -fsSL -o /workspace/$D/node-releases.json https://nodejs.org/dist/index.json
   The file is large: do not print it. Read what you need from it with head, grep or python3.
3. Find the commit the clone checked out, and the newest Node.js release in the fetched file (its
   first entry) with its release date.
Reply with one short paragraph saying what you found, then end with exactly these three lines:
COMMIT=<the first 12 characters of the commit hash>
NODE_VERSION=<the version, for example v1.2.3>
NODE_DATE=<its date, YYYY-MM-DD>"
mocactl run "$P" --json | jq -j '
  if .type == "tool_use" then "\n$ \(.args.command // .args)\n"
  elif .type == "tool_result" and .isError then "  (that command failed)\n"
  elif .type == "text" then .delta
  elif .type == "error" then "\nerror: \(.errorMessage // .stopReason)\n"
  else empty end'
```

`--json` streams the turn's frames, so the room sees each command as the agent runs it. Plain
`mocactl run` prints only the answer. Expected (_illustrative_):

```
session 6f1c…
$ git clone --depth 1 https://github.com/rossoctl/moca /workspace/research-user1/moca
$ curl -fsSL -o /workspace/research-user1/node-releases.json https://nodejs.org/dist/index.json
$ cd /workspace/research-user1/moca && git rev-parse HEAD
$ python3 -c "import json; r=json.load(open('/workspace/research-user1/node-releases.json'))[0]; print(r['version'], r['date'])"
The clone checked out … and the newest Node.js release is …
COMMIT=<12 hex digits>
NODE_VERSION=v<x.y.z>
NODE_DATE=<YYYY-MM-DD>
```

**Write the session id down** (`session <id>`, on stderr). Act 3 uses it.

### 2b. Check the answer against the world

On any machine:

```bash
git ls-remote https://github.com/rossoctl/moca HEAD | cut -c1-12
curl -fsSL https://nodejs.org/dist/index.json | jq -r '.[0] | "\(.version) \(.date)"'
```

Expected: the same commit and release as the agent's last three lines.

> Say: neither value can come from a model's memory. The clone's HEAD changes with every merge, and
> the newest Node.js release every few weeks. The file is about 330 KB, past the 50 KB of output
> the agent is shown, which is why the prompt says `curl -o` and then `grep`: the agent reads the
> file in pieces, as a person would.

### 2c. User 2 does the same, on their own key

User 2 runs 2a with `D=research-user2`, then 2b. Then the operator shows whose credential each turn
spent:

```bash
sudo podman exec sh-redis redis-cli XREVRANGE sh:cp:audit + - COUNT 6
```

Expected (_illustrative_): entries with `decision credential_issued`, the two users' `subject`
values (`github:<numeric id>`), their own `sessionId`s, and each user's own credential **name**.
The audit stream records names, never values.

> Say: two users, two subjects, two keys. Each turn resolved its owner's credential at the control
> plane, and with the operator-key fallback off, a user with no credential gets no turn at all.

### 2d. The honest beat: the container tier shares one filesystem

```bash
for c in sh-sandbox-0 sh-sandbox-1; do echo "$c:"; sudo podman exec "$c" ls /workspace; done
```

Expected: the users' research directories, each in whichever container its turn leased, possibly
both in one.

> Say: this is the limit to say out loud. Session **ownership** is enforced (Act 3), but the
> container tier has no sandbox isolation between users. Both users' turns lease the same
> containers, which share `/workspace`, the Unix user and the process list, so user 2's agent could
> read user 1's clone. Act 4's tier gives each session its own workspace. The real fix, owner
> binding, is MI1 S5.

## Act 3 — Neither can see or reach the other's sessions

### 3a. Session lists are disjoint

Each user opens **Sessions** in `mocactl` (`ctrl+x l`). Expected: their own sessions from Act 2,
and nothing of the other user's.

### 3b. Another user's session does not exist

User 1 sends their session id from 2a to user 2. User 2 tries to resume it, and then a session id
that never existed:

```bash
mocactl run "what did you find?" --session <user 1's session id>; echo "exit $?"
mocactl run "what did you find?" --session sess-does-not-exist; echo "exit $?"
```

Expected, both times:

```
that session no longer exists, or is not yours
exit 1
```

Then user 1 resumes it, to show it was real:

```bash
mocactl run "In one sentence: what did you find?" --session <your session id>
```

Expected: an answer that recalls the commit and the Node.js release.

> Say: another user's session and a session that never existed get the same answer, a 404 from the
> control plane's ownership check. A 403 would confirm the id is real. The full API-level checks
> (DELETE, token re-mint, and a session token presented against another session) are
> `vm-two-user-acceptance.md`, Act 2. Run them here if the room wants the proof at the wire.

## Act 4 — The same VM, a microVM per tool call

### 4a. One question on the container tier

User 1:

```bash
mocactl run "Run uname -a in your sandbox and reply with its output only."
```

Expected: the **VM's own kernel**, because a container shares its host's.

### 4b. Switch the host to the microVM tier (operator)

Both users stay idle: removing the containers fails any turn running in them.

```bash
sudo podman rm -f sh-sandbox-0 sh-sandbox-1
sudo systemctl enable --now microvm-worker.service
sudo timeout 60 sh -c 'until [ "$(podman exec sh-redis redis-cli HEXISTS sh:sandbox:records moca_microvm_0)" = 1 ]; do sleep 1; done' &&
  sudo podman exec sh-redis redis-cli HKEYS sh:sandbox:records
```

Expected: `moca_microvm_0`, alone. A container's presence record goes when its worker
disconnects, so no record of the removed containers is left behind to be leased.

> Say: nothing was reinstalled, and no session was lost. The users stay logged in, and their
> sessions and credentials are where they were. Only the place where tool calls run changed.

### 4c. The same question, on a microVM

User 1, as in 4a:

```bash
mocactl run "Run uname -a in your sandbox and reply with its output only."
```

Expected: `Linux (none) …`, the guest's kernel (`6.18.44+` on the verified rig), not the VM's.

### 4d. A session's workspace outlives its VMs

User 1 starts a new session with a multi-tool turn, then resumes it:

```bash
mocactl run "In your sandbox: write uname -a and python3 --version to notes.txt, git init, commit it, and tell me the hash."
mocactl run "Show git log --oneline and notes.txt." --session <the id it printed>
```

Expected: turn 2 shows turn 1's commit and file. Then the operator shows where the tool calls ran:

```bash
sudo journalctl -u microvm-worker --since -10min | grep 'vmpool: exec' | grep 'workspace_key="<the id>"'
sudo ls /srv/workspaces/
```

Expected: one line per tool call, each with its own `vm=`, all under the session's id, and the
session's directory under `/srv/workspaces`. The line names the workspace and the VM, never the
command.

```
vmpool: exec req=… workspace_key="<the id>" vm=vm-13 cold="first-exec" exit=0 err=<nil>
vmpool: exec req=… workspace_key="<the id>" vm=vm-15 cold="exhausted" exit=0 err=<nil>
```

> Say: every tool call got a fresh Firecracker VM, which was destroyed when the call returned. The
> session's files live in a workspace the next VM mounts, so turn 2 picks up where turn 1 left off.

### 4e. User 2 gets a workspace of their own

User 2 runs 4d's two turns in a new session of their own. The operator's `ls /srv/workspaces/`
then shows two directories, one per session, and user 2's journal lines name only user 2's id.

> Say: compare 2d. On this tier each session has its own workspace, so user 2's agent cannot see
> user 1's files. It is not yet a security boundary: anyone holding the relay's exec token can name
> any workspace (no grant binding, MI1 S4).

### 4f. The microVM has no network

User 1:

```bash
mocactl run "Run: curl -sS -o /dev/null -w '%{http_code}' https://nodejs.org/dist/index.json; then tell me the exact output or error."
```

Expected: a curl error (the exact text is for the first run to record). The guest has no network
device, no DNS and no NAT (#277). Act 2's research works only on the container tier, and this
tier works on local content.

## Act 5 — Record the run

Copy this into the run's report (#370, or the PR that closes it):

| Item                                                          | Result |
| ------------------------------------------------------------- | ------ |
| Commit on the VM; instance type; Firecracker version          |        |
| 0b `p4-turn-smoke.sh --auth --failure-paths` (n/n)            |        |
| 0b `research-smoke.sh` (n/n)                                  |        |
| 0d running config as expected; two container records only     |        |
| 1a both accounts: no shell, Redis forward prohibited          |        |
| 1b user 1 / user 2 subjects                                   |        |
| 1d both `doctor` all seven green                              |        |
| 2a/2b user 1's answer equals `ls-remote` and `index.json`     |        |
| 2c user 2's answer equals them; audit shows two own creds     |        |
| 2d where the two research directories landed                  |        |
| 3a lists disjoint; 3b both refusals identical, owner resumes  |        |
| 4a container `uname -a`; 4c guest `uname -a`                  |        |
| 4d turn 2 saw turn 1's commit; Execs and distinct `vm=` count |        |
| 4e two workspaces, user 2's lines name only user 2's id       |        |
| 4f the guest's curl error                                     |        |
| Elapsed time; anything unexpected (add to the fix list)       |        |

## What just happened

1. One VM ran the whole stack under systemd: no cluster, and no extra service per user.
2. Two real GitHub identities logged in through the device flow. Each subject is the account's
   numeric id, and the control plane kept no GitHub token.
3. Each agent researched live content from its sandbox, and its answer matched the world, not a
   model's memory.
4. Each user's turns spent that user's own credential, resolved per turn and audited by name.
5. Another user's session is indistinguishable from one that never existed.
6. The same host switched to the microVM tier without reinstalling or losing a session. Every tool
   call ran in its own Firecracker VM, and each session kept its own workspace across them.

## Notes and limits — what this demo does **not** claim

Say these in the room. They are what stops someone over-promising.

- **No sandbox isolation between users on the container tier.** Every user's turns lease the same
  sandbox containers, which share `/workspace`, the Unix user and the process list (2d;
  `remote-worker/internal/exec/runner.go` ignores `workspace_key`, #408). The fix is MI1 S5, owner
  binding.
- **Direct credential mode.** With no injector on this VM, a user's real inference secret reaches
  the shared sandbox worker for the length of a turn. MI1 S2's grants replace this.
- **Open egress.** Container sandboxes reach the whole internet, including cloud instance metadata
  unless the host enforces IMDSv2 with hop limit 1 (#357). Egress control is MI1 S5's
  `moca-egress`.
- **P4 has no internet** (#277) **and no grant binding** (MI1 S4). Its workspaces are per session,
  but any holder of the relay's exec token can target any of them.
- **One tier per host.** A session re-selects its sandbox every turn, and presence records carry no
  tier label, so with both tiers attached a session can hop between them and lose its files.
  Choosing the tier per session is not built.
- **Plain HTTP.** The SSH tunnel is the confidentiality. There is no TLS.
- **Ownership holds at the API only.** Redis (`127.0.0.1:6379`) and the supervisor's admin listener
  (`:8081`) have no authentication. Anyone with a shell on the VM, or unrestricted forwarding, is
  trusted with every session. That is why 0c restricts the participants' accounts.
- **Anyone with a GitHub account who reaches the control plane can log in.** There is no user
  allowlist: the SSH accounts are the gate.
- **Tenancy as of this writing:** `MOCA_TENANCY` unset, with no first-subject pin. See the top of
  this page for when that stops working (#407).
- **A `setup-vm.sh` re-run forgets every session** (#410).

## Fix list

Found while writing this runbook, on top of `vm-two-user-acceptance.md`'s list. Add what the live
run finds.

| #   | Finding                                                                                                                                                                                                         | Status                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | **Login expiry mid-demo.** The 1-hour API token makes a long demo ask for a second device-flow login. The TUI recovers by itself (login overlay, prompt replayed); headless `mocactl run` says to log in again. | Works as designed. 0a sets `SH_API_TOKEN_TTL_SECONDS=14400`.     |
| 2   | **`device_flow_disabled` and `Not Found` carry no hint.** The login error is GitHub's, verbatim.                                                                                                                | #405.                                                            |
| 3   | **The switch back to containers loses every session.** It needs a `setup-vm.sh` re-run, which recreates `sh-redis` with no volume.                                                                              | #410. The demo switches once, to P4, and only Cleanup goes back. |
| 4   | **No headless view of a turn's tool calls.** 2a needs `--json` and `jq` to show the room the commands.                                                                                                          | Open. A `mocactl run --show-tools` would replace the filter.     |
| 5   | **One identity per `XDG_CONFIG_HOME`.** Two users rehearsing on one machine overwrite each other's login.                                                                                                       | #404: `mocactl --profile`.                                       |
| 6   | **MI1 S2's first-subject pin** will refuse user 2 under `single`.                                                                                                                                               | #407.                                                            |

## Cleanup

**On each laptop:** delete this run's sessions in **Sessions** (`ctrl+x l`, then `d`), remove
`"${XDG_CONFIG_HOME:-$HOME/.config}/mocactl/auth.json"` to log out, and close the tunnel with
`ssh -S ~/.ssh/moca-tunnel -O exit <account>@<vm>`. Each user can delete their credential in
**Credentials** first, and revoke the app on GitHub under **Settings → Applications → Authorized
OAuth Apps**.

**On the VM**, put the container tier back. Stop the worker **first**, so the re-run does not start
the containers next to it. The re-run recreates Redis, which also drops whatever sessions are left
(#410):

```bash
sudo systemctl disable --now microvm-worker.service
sudo podman exec sh-redis redis-cli HDEL sh:sandbox:records moca_microvm_0
cd /opt/serverless-harness && sudo ./deploy/vm/setup-vm.sh
```

Then restore what 0a changed: remove `SH_API_TOKEN_TTL_SECONDS` from `control-plane.env` and
`sudo systemctl restart sh-control-plane`. The research directories go with the containers, which
the re-run recreated. The microVM workspaces under `/srv/workspaces` stay until idle reclaim (8 h);
to remove the P4 tier entirely, follow `deploy/microvm/P4-ON-P6.md`, "Uninstall". Remove the
participants' SSH accounts and their `Match` block, and delete the OAuth app when the demo is over.
