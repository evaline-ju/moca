# P6 on Kubernetes, slice 2: external P4 microVM hosts attached to an in-cluster relay over TLS — Design

Version: 1.0 — October 4, 2026
Status: Proposed
Milestone: **P6.2**, registered in [the milestone registry](README.md). This is slice 2 of epic rossoctl/moca#426, issue rossoctl/moca#424.

Builds on these; it reuses them and redesigns nothing:

- [P6.1 / slice 1](2026-10-02-p6-on-kubernetes-slice1-design.md), merged in rossoctl/moca#427: the `deploy/k8s/` stack, `setup.sh`, `smoke.sh`, and the ghostunnel L4 sidecar plus passthrough-Route pattern;
- [P4](2026-09-09-p4-microvm-sandbox-design.md): the `microvm-worker`, golden snapshots, and per-session workspaces;
- `deploy/microvm/P4-ON-P6.md`: today's P4-on-VM installer;
- [MI1](2026-09-28-moca-multi-user-isolation-design.md) §5 R5/R8: the exec token is distinct from the sandbox tokens, and the attach listener is split from the exec listener;
- [ADR-0037](../adrs/0037-p6-on-kubernetes-substrate.md): P6 on Kubernetes is a substrate.

> **The one-sentence thesis.** P4 is the only part of MOCA that still needs KVM. This slice lets a
> KVM host outside the cluster run `microvm-worker` against the in-cluster relay, reaching it
> through the same L4 TLS sidecar and passthrough Route pattern slice 1 uses for the supervisor.
> The cluster is the authority for the host's token, and adding or revoking a host never
> restarts the relay.

---

## 0. Decisions taken during design

| Question                                      | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The P4 host for the acceptance run            | **The shared KVM rig** (`ec2-user@3.235.29.220`), which already has Firecracker, the golden snapshot and `microvm-worker` from rossoctl/moca#369. Its owner is alerted first, and every change is recorded in a manifest and restored afterwards.                                                                                                                                                                                             |
| How the worker trusts the relay's certificate | **`RELAY_CA_FILE`**: a PEM bundle the worker trusts **in addition to** the system roots. Added to `microvm-worker` and, for symmetry, to `cmd/worker`.                                                                                                                                                                                                                                                                                        |
| Which side creates the token                  | **The cluster.** `deploy/k8s/setup.sh` generates each P4 host's token into a relay Secret, and writes a 0600 bundle for the host. `setup-microvm.sh --remote <bundle>` installs the worker from that bundle.                                                                                                                                                                                                                                  |
| How the relay is exposed                      | **A ghostunnel sidecar in the relay pod, behind a passthrough Route** (approach A). Rejected: the relay terminating TLS itself (a second security-sensitive code path, plus certificate reload code, and a different pattern from the supervisor); a `LoadBalancer` Service (a cloud LB per stack, and it bypasses slice 1's Route-host and certificate flow). The same sidecar port can sit behind a `LoadBalancer` on other clusters later. |
| Token reload                                  | **Read the token from a mounted Secret directory on each attach.** There is no watcher: attaches are rare, and the kubelet refreshes mounted Secrets within about a minute.                                                                                                                                                                                                                                                                   |

## 1. Scope

**In scope:** everything in §2–§8:

- relay token-directory reload, and its exec-token check;
- `RELAY_CA_FILE` in both workers;
- the OpenShift relay sidecar, Service, Route and NetworkPolicy;
- the `setup.sh` P4 inputs, tokens, certificate and bundles;
- `setup-microvm.sh --remote`;
- `smoke.sh --tier p4`;
- tests, docs, and the live acceptance run on the running OpenShift stack plus the shared rig.

**Out of scope:**

- **More than one tier per stack, or more than one P4 host per stack.** That is slice 3, rossoctl/moca#425. Until then, `selectPoolSandbox` has no tier label and no session affinity (rossoctl/moca#424, "Limits").
- **External P4 on Kind or plain Kubernetes.** It needs a router or an LB; follow-up.
- **cert-manager.**
- **P4 guest networking** (#277); the P4 acts have no research turns.
- **Live revocation** (§2.3).

## 2. Relay

### 2.1 Tokens from a directory (`packages/sandbox-relay/src/main.ts`)

With `SH_RELAY_TOKEN_DIR` set, `makeDefaultValidateToken` resolves a sandbox's expected token **on each attach**, in this order:

1. **The file `<dir>/<sandboxId>`**, if it exists. One trailing newline is stripped. An empty file counts as **no token**.
2. **`SH_RELAY_TOKEN_<sandboxId>`**, from the environment, as today.
3. **`SH_RELAY_TOKEN`**, from the environment, as today.

The rules around that lookup:

- **A missing file is not an error.** `ENOENT` means this ID has no directory token, and the lookup falls through to steps 2–3. That is how in-cluster sandbox pods keep authenticating with `SH_RELAY_TOKEN`.
- **Fail closed on every other read problem.** A read that fails with anything other than `ENOENT` (permissions, I/O, a directory where a file should be) does **not** fall through, and the attach is refused. The relay logs `relay token for <id> unreadable`, never the value. An **empty** file is likewise no token and no fallthrough: the ID is listed but has no usable token, so the attach is refused.
- **The ID rule.** Only `sandboxId`s matching `^[A-Za-z_][A-Za-z0-9_]*$` are looked up at all; any other ID is refused. This is the rule `setup-microvm.sh` already enforces for the VM path's environment-variable names, and it also rules out path traversal.
- **Comparison.** The comparison stays constant-time and length-checked.

### 2.2 Exec-token separation under reload (MI1 R5)

The boot-time check in `makeExecTokenValidator` stays as it is. In addition, a token read from the directory that equals `MOCA_RELAY_EXEC_TOKEN` is **refused on that attach**. The relay logs `relay token for <id> equals the exec token; refused`. A misconfigured Secret therefore cannot turn a sandbox's credential into a caller's credential.

### 2.3 Adding and revoking a host

- **Adding.** A new key in the Secret appears in the mounted directory within the kubelet's sync period, about a minute. The host's next attach then succeeds. The relay pod is not restarted, so every attached sandbox stays connected.
- **Revoking.** Removing a key takes effect on that host's **next** attach. A host that is already attached stays attached until its stream drops. To cut it off at once, restart the relay (a `Recreate` Deployment), which drops every attached sandbox. The README states this.

### 2.4 OpenShift overlay additions (`deploy/k8s/overlays/ocp`)

| Object                                    | Spec                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay pod sidecar `tls`                   | The same digest-pinned ghostunnel image as the supervisor's, run as `server --listen 0.0.0.0:8444 --target 127.0.0.1:9443 --cert /tls/tls.crt --key /tls/tls.key --disable-authentication`. Secret `moca-relay-tls` is mounted at `/tls` with mode 0440. Hardening matches the supervisor sidecar: UID 65532 from the pod, `readOnlyRootFilesystem`, `drop: [ALL]`, no privilege escalation, and a `tcpSocket` readiness probe. |
| Service `sandbox-relay-tls`               | Port `https` 8444 → the sidecar.                                                                                                                                                                                                                                                                                                                                                                                                |
| Route `moca-relay`                        | `tls.termination: passthrough`, `insecureEdgeTerminationPolicy: None`, pointing at `sandbox-relay-tls:https`. It carries the annotation `haproxy.router.openshift.io/timeout: 5m`, which is above the worker's 30 s gRPC keepalive (`remote-worker/internal/session/dial.go`). `setup.sh`'s generated overlay sets the host to `moca-relay-moca.<apps domain>`.                                                                 |
| NetworkPolicy `sandbox-relay-from-router` | An additive policy admitting the router namespace (`policy-group.network.openshift.io/ingress`) to TCP **8444 only**. The exec port 9444 gets no new ingress.                                                                                                                                                                                                                                                                   |

These objects are rendered only when there is at least one P4 host. §4.6 explains how.

### 2.5 Base addition (`deploy/k8s/base/relay.yaml`)

- **The mount.** The relay Deployment mounts Secret `moca-relay-sandbox-tokens` at `/run/relay-tokens`, read-only, with `defaultMode: 256` (0400) and `optional: true`. It sets `SH_RELAY_TOKEN_DIR=/run/relay-tokens`.
- **Why `optional`.** A stack with no P4 hosts, and so no Secret, runs exactly as in slice 1.
- **What doesn't change.** The in-cluster attach path for sandbox pods keeps using `SH_RELAY_TOKEN`: those pods have no file in the directory, so §2.1's `ENOENT` fallthrough reaches the global token.

**Why the external path cannot reach SandboxExec:** the sidecar forwards to the **attach** listener at `127.0.0.1:9443`. Since MI1 S1 / slice 1, that listener does not serve SandboxExec at all, because `MOCA_RELAY_EXEC_ADDR` splits it onto `:9444`.

## 3. Workers (`remote-worker`)

`RELAY_CA_FILE` is added to `cmd/microvm-worker/main.go` and `cmd/worker/main.go`.

- **Trust.** When it is set, the PEM certificates in the file are appended to a copy of the system cert pool, and `tls.Config{MinVersion: TLS12, RootCAs: pool}` is used. The pool is added to the system roots, never replaces them, so an operator certificate signed by a public CA still verifies with or without the file.
- **The TLS server name** comes from `RELAY_ADDR`'s host, which is grpc-go's default. There is no override.
- **Refused at start**, with `log.Fatalf` naming the variable, in the same posture as an invalid `RELAY_TLS`:
  - an unreadable file;
  - a file that contains no PEM certificate;
  - `RELAY_CA_FILE` set while `RELAY_TLS` is not `true`.
- **Shared code.** Both binaries use one helper in `remote-worker/internal/session`, so they cannot diverge.

## 4. `deploy/k8s/setup.sh` (cluster side)

### 4.1 Inputs

- **`SH_P4_SANDBOX_IDS`** is a new comma-separated list of P4 sandbox IDs. It is **sticky**: stored in `moca-setup`, like `--image` and `SH_SANDBOX_COUNT`. An explicitly empty value clears it.
- Each ID must match `^[A-Za-z_][A-Za-z0-9_]*$`, and duplicates are refused.
- `--relay-tls-cert FILE` and `--relay-tls-key FILE` (OCP only) supply an operator certificate for the relay Route host.

### 4.2 One tier per stack (until slice 3)

A non-empty `SH_P4_SANDBOX_IDS` together with `SH_SANDBOX_COUNT > 0` is **refused**. The message names both values and the fix (`SH_SANDBOX_COUNT=0`). P4 IDs on `--target kind` or `kind-ci` are refused too: there is no router, so the external path is OpenShift-only in this slice.

### 4.3 Tokens

- **The Secret.** Secret `moca-relay-sandbox-tokens`, in namespace `moca`, holds one key per ID: a 32-byte hex value from `openssl rand -hex 32`. It is written through the existing off-argv `apply_secret`, server-side.
- **Generated once.** An existing key is kept, so tokens are never rotated. Keys for IDs no longer listed are **removed**, which is revocation.
- **Fail closed.** The read uses `--ignore-not-found` with no error swallowing: an API error aborts the run, and nothing is regenerated.
- **Separation.** A generated token that happens to equal `MOCA_RELAY_EXEC_TOKEN` is regenerated. These tokens never reach `moca-sandbox`.

### 4.4 Relay certificate

The relay Route host `moca-relay-moca.<apps domain>` gets the same treatment as the supervisor host:

- with `--relay-tls-cert`, that certificate is installed into Secret `moca-relay-tls`;
- otherwise a self-signed certificate is generated once, valid for 825 days with the SAN set to the host, and kept on every re-run;
- the CA is written to `deploy/k8s/.generated/ocp/moca-relay-ca.crt`.

### 4.5 Bundles

For each ID, `setup.sh` writes `deploy/k8s/.generated/ocp/p4/<id>/`. The directory is mode 0700, the files mode 0600, and all of it is gitignored. It contains:

- `worker.env`, holding `RELAY_ADDR=moca-relay-moca.<apps domain>:443`, `RELAY_TLS=true`, `SANDBOX_ID=<id>` and `SANDBOX_TOKEN=<token>`;
- `relay-ca.crt`, the relay CA, which is absent when an operator certificate was given.

The token reaches the file through bash's builtin `printf` and never appears on argv. Bundles for IDs no longer listed are deleted. `setup.sh` prints, for each ID, the bundle path and the exact `scp -r` and `sudo deploy/microvm/setup-microvm.sh --remote <dir>` commands.

### 4.6 Rendering

The generated overlay adds the §2.4 objects only when the ID list is non-empty. They live in a component `deploy/k8s/overlays/ocp/p4-relay/`, which the generated kustomization lists under `components:`. It also patches the `moca-relay` Route host. With no P4 IDs, the render is identical to slice 1's; a manifest test pins this.

## 5. `deploy/microvm/setup-microvm.sh --remote <bundle-dir>` (KVM host side)

**Unchanged:**

- the binary, unit and slice installation;
- the `MICROVM_MAX_COMMITTED_MB` drop-in;
- the snapshot and `/dev/kvm` checks;
- the "re-running changes nothing" behaviour.

**What remote mode does:**

- **Validates the bundle:** `worker.env` exists and holds `RELAY_ADDR`, `RELAY_TLS=true`, `SANDBOX_ID` matching the ID rule, and a 64-hex `SANDBOX_TOKEN`; `relay-ca.crt` is optional.
- **Renders `microvm-worker.env`** with the existing `render_env`:
  - `set RELAY_ADDR`, `set RELAY_TLS true` and `set SANDBOX_ID`;
  - `set SANDBOX_TOKEN` from the bundle;
  - `keep SH_WORKSPACE_IDLE`;
  - `set RELAY_CA_FILE /etc/serverless-harness/microvm-relay-ca.crt` when the bundle carries a CA, which is copied there with mode 0644 since it is not secret. Otherwise the line is removed.

  The cluster is the token authority, so the bundle's token **replaces** a stale local one. That is the one place where the host-side "generated once" rule gives way.

- **Points the worker at the network instead of the local relay.** The worker drop-in `50-moca-p6.conf` is replaced by `50-moca-remote.conf`, which loads the worker env file with `After=` and `Wants=network-online.target` and does not refer to `sh-relay.service`.
- **Touches nothing local:** no relay drop-in, no `microvm-relay.env` (a stale one is left in place, so switching back works), no `podman`, no Redis, and no requirement for an installed P6. The P4-only container check is skipped, because the host's own P6 is not used.
- **Checks the attach.** It records `start="$(date '+%Y-%m-%d %H:%M:%S')"`, restarts the worker, and then polls `journalctl -u microvm-worker --since "$start"` for `attached, serving execs` for up to `MICROVM_ATTACH_TIMEOUT` seconds. On a timeout it dies, pointing at that journal, which carries the TLS or auth error.
- **Switching back.** Running the script again without `--remote` restores local-relay mode:
  - `50-moca-p6.conf` comes back;
  - the local token comes back from `microvm-relay.env`, the relay's copy;
  - `RELAY_CA_FILE` is removed;
  - the local P6 relay is restarted only if its own drop-in changed, as today.

## 6. `deploy/k8s/smoke.sh --tier p4`

`--tier container` stays the default and runs today's 11 claims. `--tier p4`, which is OpenShift only, runs these claims:

1. The supervisor is ready.
2. Every ID in `SH_P4_SANDBOX_IDS`, read from `moca-setup`, is in `sh:sandbox:records`, and no container-sandbox record is there.
3. An authenticated turn runs `uname -r; echo p4-proof | tee proof.txt`. The tool-result preview shows a kernel that is **not** the cluster node's RHCOS kernel, `p4-proof` comes back, and the turn ends with its done frame.
4. A second turn in the same session runs `cat proof.txt` and gets back `p4-proof`, so the workspace persisted.
5. The control plane is ready, and an unauthenticated `/turn` is refused (as the container tier's claims 5–6).
6. **Through the external Route**, an Attach call presenting a deliberately wrong token gets `UNAUTHENTICATED`, which proves the TLS path reaches the relay's attach listener without using any real sandbox token. A SandboxExec call made with the real exec token gets `UNIMPLEMENTED` or `UNAVAILABLE`, never `OK`. This is done by a small Node gRPC client run inside the control-plane pod, which already has `@grpc/grpc-js`. The exec token is passed through the environment of a `kubectl exec`, never argv.
7. Adding a P4 host left the relay pod's restart count and start time unchanged. The smoke compares them before and after a `setup.sh` run that adds a scratch ID. That run is skipped unless `SMOKE_P4_ADD_ID` is set.

The mock model gains scripts for claims 3–4, `K8S-SMOKE-P4-WRITE` and `K8S-SMOKE-P4-READ`. With a real model, the prompts state their commands outright, as in slice 1.

## 7. Testing

- **Relay (vitest):**
  - reading a token from the directory, covering the trailing newline, an empty file, a missing file and a non-ENOENT error;
  - falling back to the environment;
  - refusing an ID that fails the ID rule;
  - refusing a directory token equal to the exec token;
  - a token written into the directory after the relay starts being accepted on the next attach, with the same relay instance.
- **Go:** `RELAY_CA_FILE`, against an in-test TLS gRPC server with a self-signed certificate:
  - the dial succeeds with the CA file and fails without it;
  - a bad file and a CA file without `RELAY_TLS` both fail at start;
  - both binaries go through the shared helper.
- **Manifests (vitest over `kubectl kustomize`):**
  - the `p4-relay` component's sidecar arguments, digest and hardening;
  - Route `moca-relay`: passthrough, the timeout annotation, and its target;
  - the NetworkPolicy, which admits the router to 8444 only;
  - the base's optional token mount;
  - a generated OCP overlay **with** P4 IDs, which includes the component and the host patch;
  - one **without** P4 IDs, which renders identically to slice 1's.
- **`setup.test.sh`:**
  - P4 IDs are sticky, and an explicit empty value clears them;
  - tokens are generated once and kept;
  - a removed ID removes its key and its bundle;
  - both tiers together are refused, and P4 IDs on kind are refused;
  - the ID rule and duplicates;
  - bundle modes are 0700 and 0600;
  - no token anywhere in the argv log, raw or base64;
  - the relay certificate is kept on a re-run, and `--relay-tls-cert` replaces it;
  - a failed read of the token Secret aborts and regenerates nothing.
- **`setup-microvm.test.sh`** (remote cases):
  - no `podman`, `sh-relay` or Redis calls;
  - the env is rendered from the bundle;
  - the CA file is installed;
  - the drop-in is swapped;
  - the journal check passes on success and dies on a timeout;
  - an invalid bundle is refused;
  - the switch back to local mode restores the local token and drop-in.
- **The live acceptance run** (§8).

## 8. Acceptance (README runbook, recorded on rossoctl/moca#424)

Run on the OpenShift 4.20.8 stack left running after slice 1, plus the shared KVM rig:

1. **Before touching the rig:** alert its owner, and start a manifest recording what was found, each change and each restore. This is the rig's standing rule.
2. **Switch the stack to P4-only:**
   ```
   SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=moca_microvm_0 deploy/k8s/setup.sh --target ocp --image <branch image>
   ```
   This runs on an image built in-cluster from this branch, as in slice 1. It removes the sandbox pods and adds the relay Route.
3. **Install the bundle on the rig:** `scp` the bundle to the rig, then run `sudo deploy/microvm/setup-microvm.sh --remote <bundle>` from the rig's checkout of this branch, shipped as a full git bundle per the rig's procedure.
4. **Run the P4 smoke:** `smoke.sh --target ocp --tier p4` with a real model. All claims must pass, including claim 7 with `SMOKE_P4_ADD_ID`.
5. **Run `mocactl`** for both slice-1 users: each writes a file in one turn and reads it back in a second turn of the same session. The tool output names the guest kernel.
6. **Restore everything:**
   - the rig: `setup-microvm.sh` without `--remote`, back on its own relay, with the attach checked;
   - the stack: `SH_P4_SANDBOX_IDS= SH_SANDBOX_COUNT=2 setup.sh …`, back to slice 1's state.

   The manifest is then closed.

**Done means:** §7 is green in CI, and §8 is performed and recorded, with every claim passing and both restores verified.

## 9. Risks and things to verify early

| Risk                                                                        | How it is verified                                                                                               | Fallback                                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| The router's passthrough idle timeout kills Attach between keepalives.      | Live: an attached worker stays attached for more than 10 minutes while idle, and the relay log shows one attach. | Raise the Route timeout annotation, or lower the worker keepalive (`dial.go`). |
| The kubelet's Secret refresh is slower than expected.                       | Live claim 7 measures add-to-attach time.                                                                        | Document the measured time; the smoke waits for up to 3 minutes.               |
| The rig's outbound access to `*.apps.moca1.kubestellar.org:443` is blocked. | Before step 3, run `curl -v` from the rig against the relay host.                                                | Open egress on the rig, or use an LB address.                                  |
| The shared rig's local P6 and its remote worker conflict.                   | The test proves that remote mode touches no P6 file, and the manifest records the rig's state.                   | Restore from the manifest.                                                     |

## 10. Deliverables

```
packages/sandbox-relay/src/main.ts (+ test)       §2.1–2.2
remote-worker/internal/session/tls.go (+ test), cmd/{microvm-worker,worker}/main.go   §3
deploy/k8s/base/relay.yaml                        §2.5
deploy/k8s/overlays/ocp/p4-relay/ (component)     §2.4
deploy/k8s/setup.sh, tests/setup.test.sh          §4
deploy/k8s/smoke.sh, deploy/microvm/mock-anthropic.mjs   §6
deploy/microvm/setup-microvm.sh, tests/setup-microvm.test.sh   §5
packages/supervisor/test/k8s/*                    §7 manifests
deploy/k8s/README.md ("P4 on Kubernetes"), deploy/microvm/P4-ON-P6.md (pointer)
docs/specs/README.md                              P6.2 row
```
