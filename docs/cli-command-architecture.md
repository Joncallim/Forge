# CLI Command Architecture

## Plain-English Summary

Forge should eventually have a simple command-line experience, but it should not
get a global `forge` launcher yet.

Today, the supported way to run Forge is still the existing scripts and npm
commands:

```bash
bash scripts/install.sh
cd web
npm run dev
```

This document reserves the future command shape so Forge does not grow one-off
shortcuts that later need to be replaced. It explains what future CLI commands
should mean, who owns each command area, and what must stay unchanged until the
full CLI is ready.

## Operational Understanding

### Current supported workflows

Use the existing install and lifecycle scripts for now:

```bash
bash scripts/install.sh
bash scripts/install.sh --check
bash scripts/install.sh --upgrade
bash scripts/uninstall.sh
```

Use the existing web commands from `web/`:

```bash
npm run dev
npm run worker
npm run doctor
npm run test:providers
```

`npm run dev` remains the normal local startup command. It starts the web app
and, by default, the embedded worker.

`npm run worker` remains a standalone worker command for split deployments where
`FORGE_EMBED_WORKER=0` is set on the web process.

### Future command taxonomy

The future CLI should group commands by user intent, not by repository folder:

| Command area | Future command examples | Purpose |
|---|---|---|
| Start and open Forge | `forge`, `forge dev`, `forge open` | Start the local app and help the user reach the dashboard. |
| Readiness and repair | `forge doctor`, `forge logs`, `forge reset` | Check local setup, inspect failures, and recover from common problems. |
| Install lifecycle | `forge install`, `forge update`, `forge uninstall` | Wrap the supported install, upgrade, and uninstall flows. |
| Runtime control | `forge worker`, `forge status` | Inspect or run background execution separately when needed. |
| Information | `forge version`, `forge help` | Show version, environment, and command help. |

These are reserved names, not implemented commands.

### What users should expect later

A future global command should work from any directory, hide internal folder
layout, and print the active local URL when it starts Forge:

```text
Starting Forge...

Local: http://localhost:3000
```

The exact default action, port discovery behavior, install method, and process
behavior remain open decisions.

## Technical Details

### Ownership and routing

The future CLI should route to existing workflows instead of replacing them.

| Area | Primary owner | Current source of truth |
|---|---|---|
| CLI taxonomy and command contracts | Architect | This document and future ADRs. |
| Install, upgrade, uninstall, machine checks | DevOps | `scripts/install.sh`, `scripts/uninstall.sh`. |
| Web app runtime | Frontend / Backend | `web/package.json` scripts: `dev`, `build`, `start`. |
| Worker runtime | Backend | `web/package.json` scripts: `worker`, `worker:dev`; `web/worker/`. |
| Database commands | Backend | `web/package.json` scripts: `db:*`. |
| Tests and validation | QA | `web/package.json` scripts: `test`, `e2e`, `lint`, `test:providers`. |
| User-facing docs | Documentation | `docs/` and README cross-links. |

Routing rule: a future `forge` command may orchestrate existing scripts, but it
should not duplicate their logic. For example, `forge doctor` should call the
same readiness checks as `npm run doctor`, and `forge install` should preserve
the behavior of `bash scripts/install.sh`.

### Non-goals for this issue

Do not implement any of these as part of issue #45:

- A global `forge` executable.
- A package `bin` entry.
- A Homebrew formula.
- A shell alias installer.
- A symlink into `/usr/local/bin` or another global path.
- A replacement for `scripts/install.sh`, `scripts/uninstall.sh`, or
  `web/package.json` scripts.
- A new startup flow that changes how `npm run dev` or `npm run worker` works.

Shell aliases and local wrapper scripts are acceptable for individual
developers, but they are not the product CLI.

### Acceptance criteria mapping

| Issue #45 acceptance criterion | Status after adding this doc |
|---|---|
| CLI architecture documented. | Satisfied by this document. |
| Command taxonomy agreed. | Partially satisfied: taxonomy proposed and reserved for review. |
| Global `forge` command supported. | Not satisfied; intentionally deferred. |
| Startup URL displayed in terminal. | Not satisfied; reserved for future CLI implementation. |
| Works from any directory. | Not satisfied; depends on future global launcher design. |
| Documentation updated. | Satisfied when this document and cross-links are added. |
| Existing developer workflows preserved. | Satisfied by keeping scripts and npm commands authoritative. |

## Reference Material

### Current command references

- Install and uninstall: [`install-uninstall.md`](install-uninstall.md)
- Worker behavior: [`worker-process.md`](worker-process.md)
- Terminal installer planning: [`terminal-installer-plan.md`](terminal-installer-plan.md)
- Package scripts: [`../web/package.json`](../web/package.json)
- Install script: [`../scripts/install.sh`](../scripts/install.sh)
- Uninstall script: [`../scripts/uninstall.sh`](../scripts/uninstall.sh)
- Doctor script: [`../web/scripts/doctor.ts`](../web/scripts/doctor.ts)
- Provider test script: [`../web/scripts/test-providers.ts`](../web/scripts/test-providers.ts)

### Open decisions

- Should the eventual launcher be distributed through npm, Homebrew, the install
  script, or another channel?
- Should `forge` start the app by default, open an interactive menu, or only
  print help?
- Should `forge dev` run the embedded worker by default, matching `npm run dev`?
- How should the CLI discover an existing Forge checkout when run outside the
  repository?
- How should the CLI choose or display the active port if `3000` is unavailable?
- Should `forge logs` read process logs, worker events, database task events, or
  all three?
- Which reset actions are safe enough for `forge reset`, and which require
  separate explicit flags?
