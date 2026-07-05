# ADR 0007: Filesystem MCP Bounded Context Grants

## Status

Accepted

## Context

Forge needs filesystem-aware package execution, but issuing live filesystem MCP
tool handles to implementation workers would expand the runtime write/read
surface before the sandbox broker is ready. The first supported boundary is
therefore a project-scoped, read-only context packet assembled by Forge itself.

## Decision

Forge treats filesystem MCP access as an explicit operator grant. The first
approval happens from a work package because the package says exactly which
filesystem capabilities it needs. Operators can choose either a one-time grant
for that package or a project-level grant that applies to later packages in the
same project when they ask for the same or narrower capabilities.

- Architect plans may propose `filesystem.project.read`,
  `filesystem.project.list`, and `filesystem.project.search`.
- Operators approve, edit, or deny those proposed grants before execution.
- `Allow once` creates an `effective` package grant phase with
  `grantMode: "allow_once"`. The executor consumes it after the next bounded
  context packet is issued, so another retry or later package must ask again.
- `Always allow` creates an approved project filesystem grant in the project's
  MCP config with `grantMode: "always_allow"`. Future work packages in that
  project can inherit this grant automatically if their required filesystem
  capabilities are covered by the project grant.
- Before issuing runtime context from a project-level grant, the executor checks
  the current project MCP config again. Removing or narrowing the project grant
  stops later context packets, including for packages that were materialized
  while the project grant still existed.
- Approved package-local and project-inherited grants become an `effective`
  package grant phase with `runtimeEnforcement: "bounded_context_packet"`.
- The executor receives only a bounded, read-only project context packet.
- Live MCP filesystem tool handles are not issued in this beta boundary.
- `filesystem.project.write` is not supported; package writes remain confined to
  `.forge/task-runs/...` sandbox output.
- Required denied or missing filesystem grants block execution with task logs and
  runtime audit rows.
- The task page warns before project-level approval is saved. This warning must
  stay visible near the `Always allow` action because that choice reduces future
  prompts for the same project.

Every filesystem packet decision is auditable by task, work package, optional
agent run, optional grant approval id, status, requested capabilities, approved
capabilities, root, included file count, byte count, omitted count, and redaction
summary. Audit rows must not persist raw file contents.

Project-level approval does not widen the beta security boundary. It only saves
the operator's decision for the same project and covered capabilities. It still
does not grant live MCP handles, write access, credentials, access to another
project, or any capability outside the safe filesystem allowlist.

## Consequences

This closes the MCP Filesystem epic for the safe beta path: installation/status,
approval, runtime enforcement, and auditability are implemented without exposing
arbitrary host filesystem access to agents.

Future live filesystem MCP execution needs a separate design for hard process
sandboxing, path-scoped tool brokering, write approval, and adversarial prompt
injection handling.
