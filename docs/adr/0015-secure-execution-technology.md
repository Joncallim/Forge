# ADR 0015: Secure Execution Technology Selection

**Status:** Proposed (pending conformance proof)
**Date:** 2026-09-04
**Supersedes:** None

## Context

Forge VNext requires a secure execution envelope for agent runs, capability adapters, and Operations. The current fail-closed boundary (no OS-enforced sandbox) is acceptable for the beta but cannot support the VNext vision of installable Workforces with bounded authority.

The choice of sandbox technology must follow from the security conformance profile, not from branding or ecosystem familiarity.

## Decision

### 1. Freeze the conformance profile first

Before selecting a specific sandbox technology, the following conformance requirements are frozen:

| # | Requirement | How to verify |
|---|---|---|
| S1 | Host home directory is inaccessible | Attempt read outside sandbox root |
| S2 | Ungranted repositories are inaccessible | Attempt read of another project's directory |
| S3 | SSH keys are inaccessible | Attempt read of ~/.ssh |
| S4 | Container runtime sockets are inaccessible | Attempt connect to docker/containerd socket |
| S5 | Forge database credentials are inaccessible | Attempt read of Forge config/environment |
| S6 | Environment variables are filtered | Only allowed env vars present |
| S7 | Network is denied by default | Outbound connect fails without explicit grant |
| S8 | Host localhost/LAN is denied | Connect to host services fails |
| S9 | Internet is denied unless explicitly granted | External connect fails without explicit egress policy |
| S10 | Only explicit writable mounts are writable | Write outside approved paths fails |
| S11 | Symlink/mount escape is blocked | Symlink to outside path cannot bypass restrictions |
| S12 | /proc/device exposure is bounded | Sensitive host device info not accessible |
| S13 | No privileged execution mode | Cannot escalate to root/privileged inside sandbox |
| S14 | CPU limit is enforced | Process cannot exceed allocated CPU |
| S15 | RAM limit is enforced | Process cannot exceed allocated RAM |
| S16 | Disk limit is enforced | Process cannot exceed allocated disk space |
| S17 | PID/process limit is enforced | Process cannot fork-bomb |
| S18 | Wall-clock timeout is enforced | Process is killed after deadline |
| S19 | Child process containment | Spawned children remain inside the same sandbox |
| S20 | Cancellation kills workers | Signal/API call terminates the worker process tree |
| S21 | Revocation prevents new side effects | After revoke, no new operations can start |
| S22 | Teardown removes residual processes | After cancellation, no processes remain |
| S23 | Unsupported hosts fail closed | On unsupported OS, execution is denied, not silently weakened |

### 2. Selection rule

Choose the lowest-complexity technology that fully passes the conformance profile without weakening exceptions.

### 3. First supported target

The first supported host platform is **Linux** (amd64/arm64).

Cross-platform security MUST NOT be faked. If a platform cannot meet the conformance profile, execution on that platform is denied (fail-closed).

### 4. Candidate evaluation

#### Candidate A: Rootless hardened container (Docker/podman with user namespaces, seccomp, cgroups)

- **Strengths**: Mature technology, strong isolation, well-understood security model, expected to support all S1-S23 requirements.
- **Weaknesses**: Requires container runtime installed; daemon dependency; image management overhead.
- **Verdict**: Preferred first candidate. Must pass hostile conformance proof before acceptance.

#### Candidate B: MicroVM (Firecracker)

- **Strengths**: Stronger isolation boundary, hardware-level virtualization, good for multi-tenant scenarios.
- **Weaknesses**: Higher complexity, slower startup, heavier resource footprint, more operational overhead.
- **Verdict**: Use only if rootless containers cannot meet the conformance profile.

#### Candidate C: gVisor

- **Strengths**: Application-layer kernel, no hardware virtualization needed, good security.
- **Weaknesses**: Performance overhead, compatibility limitations, smaller ecosystem.
- **Verdict**: Acceptable alternative if rootless containers unavailable, but prefer rootless containers first.

#### Candidate D: Bare namespaces + seccomp (DIY)

- **Strengths**: Minimal dependencies, full control.
- **Weaknesses**: High maintenance burden, easy to misconfigure, no ecosystem tooling.
- **Verdict**: Acceptable only for experimental/prototype use; not for production.

### 5. Decision

#### 5.1 Conformance profile frozen

The S1-S23 sandbox conformance profile (section 1) is **frozen** and binding on all implementation. No sandbox technology may be deployed unless it passes all non-waivable conformance requirements on the target host.

#### 5.2 Technology selection

**Rootless hardened containers (Docker/podman with user namespaces, seccomp profiles, cgroups v2)** are the **preferred first candidate**.

This technology decision is **Accepted in principle pending conformance proof**. It becomes fully Accepted only after hostile conformance proof demonstrates that all S1-S23 requirements are met on the supported Linux host (amd64/arm64).

If rootless containers fail any non-waivable security requirement during conformance testing, evaluate the next candidate:

1. Rootless hardened containers (preferred, lowest complexity).
2. gVisor (application-layer kernel, stronger isolation).
3. MicroVM (Firecracker) (hardware-level virtualization, strongest isolation).
4. Bare namespaces + seccomp (prototype only, not for production).

No weakening exceptions are permitted simply to keep the preferred technology. If rootless containers cannot meet the profile, the next candidate MUST be evaluated.

Implementation details (exact container image, seccomp profile, cgroup configuration, orchestration) are deferred to the implementation phase.

### 6. What this does not decide

- The exact container image/runtime configuration.
- The orchestration layer for sandbox lifecycle.
- Whether each Agent Run gets a fresh container or containers are reused.
- Multi-OS sandbox support.
- The sandbox's network proxy/firewall implementation.

## Consequences

### Positive

- Conformance-driven selection ensures security requirements drive technology choice, not vice versa.
- Rootless containers are well-understood and widely deployed.
- Migration path to stronger isolation (microVM/gVisor) is available if needed.
- The conformance profile is frozen independently of any technology vendor.

### Costs

- Container runtime must be installed on the host.
- Image management adds operational complexity.
- Startup latency is higher than no sandbox.
- Hostile conformance proof is required before technology acceptance, which may reveal gaps requiring fallback to a stronger technology.

These costs are accepted because the alternative (no OS-enforced sandbox) cannot meet the VNext security requirements.

### Risk

If rootless containers fail conformance testing, the fallback technologies (gVisor, microVM) have higher operational complexity and startup latency. This risk is accepted because the conformance profile is non-negotiable for VNext security goals.

## References

- SPEC-0008 — Conformance Test Standard v1
- SPEC-0013 — Agentic Threat Model v1
- SPEC-0015 — Reliability / SLO Profile v1 (Hard Invariant S15/S22)
