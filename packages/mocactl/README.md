# mocactl

A terminal client for the harness: log in, manage sessions and inference credentials, and watch
turns stream live. It talks only to the control plane's `/v1` API and the harness's `/v1/turn`,
so it works the same whatever runs behind those URLs. Design:
[`docs/specs/2026-09-25-mocactl-control-plane-client-design.md`](../../docs/specs/2026-09-25-mocactl-control-plane-client-design.md).

## Run it

**New here?** [QUICKSTART.md](QUICKSTART.md) goes from a fresh checkout to a streamed reply on a
local kind cluster, with one script doing the cluster wiring.

```bash
pnpm install
node packages/mocactl/bin/mocactl.mjs            # interactive; the first run walks you through setup
node packages/mocactl/bin/mocactl.mjs --setup    # re-run setup on a configured machine
```

`mocactl` needs one URL: the server's (the control plane). It comes from `--control-plane-url`, then
`SH_CONTROL_PLANE_URL`, then the saved config. The control plane says where the harness is
(`GET /v1/discovery`, set by its operator with `SH_PUBLIC_HARNESS_URL`), so there is nothing else to
configure. Onboarding checks the control plane and the harness it points at before saving the URL —
nothing is written to disk until both answer.

`--harness-url` / `SH_HARNESS_URL` override discovery (e.g. a harness behind a local port-forward);
onboarding never saves a discovered harness URL, so a harness the operator moves is followed.

## Keys

| Action                               | Slash                   | Keys                   |
| ------------------------------------ | ----------------------- | ---------------------- |
| Command palette                      | —                       | `ctrl+p`               |
| Sessions (resume, rename, delete)    | `/sessions`, `/resume`  | `ctrl+x l`             |
| New session                          | `/new`                  | `ctrl+x n`             |
| Rename session                       | `/rename <title>`       | `ctrl+x r`             |
| Credentials                          | `/credentials`          | `ctrl+x k`             |
| Toggle tool details / thinking       | `/details`, `/thinking` | `ctrl+x d`, `ctrl+x t` |
| Copy last reply / export to Markdown | `/copy`, `/export`      | `ctrl+x y`, `ctrl+x x` |
| Compose in `$EDITOR`                 | `/editor`               | `ctrl+x e`             |
| Theme, diagnostics                   | `/theme`, `/doctor`     | —                      |
| Help                                 | `/help`                 | `?` on an empty input  |
| Quit                                 | `/quit`                 | `ctrl+x q`, `ctrl+c`   |

`Enter` sends, `alt+enter` adds a newline, `↑`/`↓` walk your prompt history. `Esc` closes any
overlay (including a loading or error screen) and, on the chat view, cancels the running turn; a
second `Esc` within a second also clears queued messages (after a cancel, the next queued message
waits that second before it is sent). `$EDITOR` (or `$VISUAL`) runs with the
terminal suspended — if it cannot start, a toast says so and your draft is unchanged. It runs
without a shell: the value is split into words (quotes work, e.g. `code --wait` or
`"/path/with spaces/subl" -w`), but nothing is expanded, so write `$HOME/bin/ed` out in full, and
on Windows name an `.exe`. Override
keys in `config.json` under `keybinds`, e.g. `{ "session.new": "ctrl+x s" }`.

## Headless

```bash
mocactl login                               # device-flow login, prints the code
mocactl doctor [--json]                     # seven checks, one fix per failure; exit 1 on failure
mocactl run "prompt" [--session ID | --new] [--option inferenceCredential=NAME] [--json]
```

```bash
mocactl sessions [--json]                   # every session you own, all pages
mocactl sessions delete ID [--json]         # also drops its local history
mocactl credentials [--json]                # names, kinds, hosts and endpoints; never secrets
printf %s "$KEY" | mocactl credentials add NAME --host HOST [--host HOST ...] \
  [--kind KIND] [--consumer CONSUMER] [--endpoint URL] [--json]
mocactl credentials delete NAME [--json]
```

`mocactl run` continues the session `--session` names, or starts a new one (`--new`, the default).

`mocactl credentials add` reads the secret from stdin, never from the command line, so it stays
out of shell history and `ps`; it refuses a terminal on stdin (`read -rs KEY` first, or use
`/credentials` in the TUI). For a kind with one secret field (`bearer`, `api-key`,
`oauth2-token`) stdin is the secret itself, one line, its trailing newline dropped; for any other
kind it is one `field=value` per line (`basic`: `username=…` and `password=…`). `--kind` defaults
to `bearer` and `--consumer` to `inference`, as in the TUI form; `--host` takes a comma-separated
list too and is required. The TUI form's checks apply, and a problem names fields, never values.

Exit codes, for every command: `0` it worked, `1` it failed (the turn, or the control plane
refused), `2` a usage or setup problem (bad flags, not logged in, no destination for the turn),
`130` cancelled (Ctrl-C).

### Output

stdout carries only the result; every message goes to stderr, including "no sessions" for an
empty list. Without `--json` a listing is an aligned table with a header row, made terminal-safe.
Times are UTC. With `--json` stdout is one JSON document and one line; `run` and `doctor` keep
their own shapes. These shapes are stable: fields may be added, but none is renamed or removed.

| Command              | `--json` on stdout                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `sessions`           | `{"sessions":[{"sessionId","title","state","createdAt","lastTurnAt","turns"}]}`                    |
| `sessions delete`    | `{"sessionId","status"}`, `status` being `deleted`, or `accepted` while the control plane finishes |
| `credentials`        | `{"credentials":[{"name","kind","consumer","hosts","endpoint"}]}`                                  |
| `credentials add`    | `{"name","status":"stored"}`                                                                       |
| `credentials delete` | `{"name","status":"deleted"}`                                                                      |

`createdAt` and `lastTurnAt` are epoch milliseconds as the control plane sends them (`lastTurnAt`
is `null` before the first turn); `endpoint` is `null` when the deployment default applies.
`title` is this machine's: the first prompt, or a TUI rename, and `null` for a session with no
local history (the control plane stores no titles).

## Files

- `$XDG_CONFIG_HOME/mocactl/config.json` — endpoints, theme, toggles, keybinds, presets.
- `$XDG_CONFIG_HOME/mocactl/auth.json` — the 1-hour API token (mode 0600). No provider key is ever stored.
- `$XDG_STATE_HOME/mocactl/transcripts/` — local session history, per subject and per control plane
  (mode 0600). A session resumed from another machine shows no history — it belongs to a
  different transcript store.

Falls back to `~/.config/mocactl/` and `~/.local/state/mocactl/` when the `XDG_*` variables are unset.

## Troubleshooting

Run `mocactl doctor`. Its "harness located" line says where the harness was found and how. If the
control plane advertises none, its operator sets `SH_PUBLIC_HARNESS_URL` to the harness as clients
reach it (not the in-cluster address; behind a port-forward, the local one), e.g.
`kubectl set env deploy/sh-control-plane SH_PUBLIC_HARNESS_URL=http://localhost:18081`. A control
plane older than `/v1/discovery` needs upgrading, or `--harness-url` in the meantime.

If it reports that the harness does not trust this control plane, the harness is missing the
control plane's public keyset, the exchange token, or `SH_CONTROL_PLANE_URL`/`SH_REQUIRE_AUTH`. On
the VM/P6 path, re-run `sudo ./deploy/vm/setup-vm.sh`, which installs the control plane beside the
supervisor and wires all four (`deploy/vm/README.md`, "The control plane"). There the exchange token
is a systemd credential, not a `supervisor.env` line. On the Knative path they are set in
`deploy/knative/service.yaml`.

Resuming a session started on another machine shows no history: the control plane has no route
that returns a session's messages yet, so history is kept locally.

Creating a credential requires at least one destination host — the control plane rejects an empty
list.
