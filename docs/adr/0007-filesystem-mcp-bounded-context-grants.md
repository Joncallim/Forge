# ADR 0007: Filesystem MCP Bounded Context Grants

## Status

Accepted

## Context

Forge needs filesystem-aware package execution, but issuing live filesystem MCP
tool handles to implementation workers would expand the runtime write/read
surface before the sandbox broker is ready. The first supported boundary is
therefore a project-scoped, read-only context packet assembled by Forge itself.

## Decision

Forge treats filesystem MCP access as an explicit package-local grant.

- Architect plans may propose `filesystem.project.read`,
  `filesystem.project.list`, and `filesystem.project.search`.
- Operators approve, edit, or deny those proposed grants before execution.
- Approved grants become an `effective` package grant phase with
  `runtimeEnforcement: "bounded_context_packet"`.
- The executor receives only a bounded, read-only project context packet.
- Live MCP filesystem tool handles are not issued in this beta boundary.
- `filesystem.project.write` is not supported; package writes remain confined to
  `.forge/task-runs/...` sandbox output.
- Required denied or missing filesystem grants block execution with task logs and
  runtime audit rows.

Every filesystem packet decision is auditable by task, work package, optional
agent run, optional grant approval id, status, requested capabilities, approved
capabilities, root, included file count, byte count, omitted count, and redaction
summary. Audit rows must not persist raw file contents.

## Consequences

This closes the MCP Filesystem epic for the safe beta path: installation/status,
approval, runtime enforcement, and auditability are implemented without exposing
arbitrary host filesystem access to agents.

Future live filesystem MCP execution needs a separate design for hard process
sandboxing, path-scoped tool brokering, write approval, and adversarial prompt
injection handling.
