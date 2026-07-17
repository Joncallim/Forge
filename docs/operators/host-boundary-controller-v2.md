# Epic 172 host-boundary controller

Status: deployed disabled; Release/DevOps ownership

## What this protects

Epic 172 changes how Forge reads and writes a local repository. A normal test on a
developer laptop cannot prove that a crashed or hostile child process is contained.
This gate uses a short-lived Ubuntu virtual machine with separate operating-system
users, Linux control groups (cgroup v2), and a root-owned fence service.

The controller lives outside the repository checkout. Repository code cannot start
the controller, replace its root harness, access its private key, conclude its
GitHub Check Run, or enable Forge ingress or packet issuance. The checked-in
configuration is deliberately `disabled`. It describes the contract the external
controller must match; it is not controller authority.

macOS, Windows, a same-user container, and an ordinary self-hosted runner are useful
for development, but they are not trusted release proof for this gate.

## Before a trusted run

Release/DevOps must confirm all of the following outside the checkout:

1. The exact reviewed merge-queue commit is selected. A pull request branch and
   `pull_request_target` are not allowed.
2. The controller-created Check Run is named
   `forge/host-boundary-controller` and is pinned by repository rules to the audited
   controller GitHub App ID. A same-name GitHub Actions check does not count.
3. The single-job Ubuntu 24.04 image, Linux 6.8 or newer kernel, immutable root
   harness, PostgreSQL TLS fixture, action commits, and dependency cache match their
   reviewed digests.
4. Checkout code has no public-network route. The workflow token is read-only and
   has no `checks:write`; controller secrets never enter the checkout namespace.
5. The external controller is still disabled unless the exact release process has
   separately authorized this run. Deploying this repository branch does not enable
   it.

Verify the repository ruleset binding through the controller's fixed control
socket:

```text
npm run protocol:verify-host-boundary-controller-ruleset -- --repository <owner/repo> --app-id <github-app-id> --check forge/host-boundary-controller
```

The command is read-only. A blocked response means stop. Do not replace it with a
name-only check in the GitHub web interface.

## What the trusted job does

The external controller creates one expiring challenge bound to the controller run,
job, reviewed commit, image, boot, harness, and PostgreSQL TLS fixture. The checkout
may request only the harness's fixed preflight operation:

```text
npm run preflight:mcp:host-boundary
```

That command verifies the Ed25519 signature and exact Ubuntu/Linux facts, then
writes the signed envelope. It cannot manufacture facts or sign an envelope. The
external controller independently verifies the same envelope and rejects replay,
expiry, or any changed binding.

The five release suites are then run without retries. The host-boundary suite is:

```text
npm run test:mcp:host-boundary
```

It can ask the immutable harness to run only seven reviewed scenario IDs. Each
result is signed and bound to the preflight envelope. The runner cannot select an
arbitrary root command, path, user, socket, control group, or mount.

Runner success is advisory. The external controller keeps its required Check Run
pending until it has independently verified:

- the signed preflight envelope;
- all expected first-attempt suite IDs and a signed output-scan result;
- a signed zero-residue teardown envelope; and
- an out-of-band virtual-machine destruction or reimage receipt.

Only then may the controller sign the relevant S6 evidence input. S6 passes that
input to Step 0's canonical verifier and store; it does not copy the release graph,
signature code, signing-key lifecycle, or database recorder.

## Inspect a run

Use the reviewed run ID and commit. The response contains only typed state and
opaque fingerprints; it must not contain repository paths, request bodies, child
output, or credentials.

```text
npm run protocol:inspect-host-boundary-controller -- --run <controller-run-id> --sha <sha>
```

A pending runner process is not proof that the external Check Run is green. A green
GitHub Actions job is not a substitute for the exact-App controller check.

## Failure and rollback

Any missing test, skip, retry, timeout, stale signature, output-scan failure,
teardown residue, controller outage, or destruction failure makes the run fail.
The independent time-to-live watcher must destroy the virtual machine even if the
runner and root harness are gone.

On failure:

1. Keep every protocol-v2 activation, project ingress, queue intake, root writer,
   and packet issuance path disabled.
2. Do not record a green S6 receipt and do not treat runner output as evidence.
3. Inspect the external run with the exact command above.
4. Repair the external controller, image, harness, ruleset, or lower slice as
   appropriate. Do not patch policy into the S6 tests.
5. Retry only a terminal `failed` or `timed_out` controller run with the same
   reviewed commit and a named operator:

```text
npm run protocol:retry-host-boundary-controller-check -- --run <controller-run-id> --sha <sha> --actor <operator-id> --expected-state failed --apply
npm run protocol:retry-host-boundary-controller-check -- --run <controller-run-id> --sha <sha> --actor <operator-id> --expected-state timed_out --apply
```

Retry creates a fresh controller operation, challenge, virtual machine, and signed
evidence set. It cannot rerun a pending or successful operation and cannot reuse a
previous receipt.

If a later provisional enablement window has already opened, use the separate
S4-owned disable command and procedure immediately. S6 controller commands do not
open, extend, promote, or disable that database state.

## Rotate the controller verification key

The pending key reference is an opaque reference to an external secret store. Never
put a private key, certificate, public-key replacement payload, or secret value on
the command line or in this repository.

Preview and then apply the rotation:

```text
npm run protocol:rotate-host-boundary-controller-key -- --pending-key-ref <opaque-secret-ref> --actor <operator-id>
npm run protocol:rotate-host-boundary-controller-key -- --pending-key-ref <opaque-secret-ref> --actor <operator-id> --apply
```

Inspect the bounded dual-key rotation:

```text
npm run protocol:inspect-host-boundary-controller-key-rotation -- --rotation <rotation-id>
```

If verification cannot complete, discard only that pending rotation:

```text
npm run protocol:rotate-host-boundary-controller-key -- --rotation <rotation-id> --discard --actor <operator-id> --apply
```

Rotation never rewrites existing signed release evidence. A retired, future,
host-harness, or wrong-generation key cannot become Step 0 release authority.

## Diagnostics and retention

Raw child output, traces, screenshots, videos, archives, dumps, and opaque files
stay inside the disposable virtual machine and are destroyed with it. Only
schema-checked, path-free UTF-8 text or JSON tuples may leave the machine after the
sentinel scan. A scan hit suppresses the whole diagnostic bundle and fails the
controller check.

When reporting a failure, share only the opaque controller run ID, reviewed commit,
fixed message code, signed-manifest digest, and external Check Run URL. Do not paste
raw runner logs as a workaround.
