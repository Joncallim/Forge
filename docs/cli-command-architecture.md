# CLI Command Architecture

## Summary

Forge now has a small global `forge` launcher for day-to-day local operation.
The launcher is intentionally thin: it resolves this checkout and delegates to
the existing install, uninstall, web, and recovery scripts instead of copying
their logic.

The first implemented command set is:

```bash
forge
forge upgrade
forge uninstall
forge reset-credentials
```

`forget` is not a command. If it appears in notes or issues, treat it as a typo
for `forge`.

## Current Command Taxonomy

| Command | Behavior | Source of truth |
|---|---|---|
| `forge` | Starts the local dashboard and embedded worker. | `web/package.json` -> `npm run dev` |
| `forge dev` | Alias for `forge`. | `web/package.json` -> `npm run dev` |
| `forge upgrade` | Syncs dependencies, migrations, agent seeds, and checks after pulling changes. | `scripts/install.sh --upgrade` |
| `forge uninstall` | Removes Forge runtime pieces and passes uninstall flags through unchanged. | `scripts/uninstall.sh` |
| `forge reset-credentials` | Prompts for a new local account password and clears password-login throttles. | `web/scripts/reset-password.ts --stdin` |
| `forge doctor` | Runs runtime readiness checks. | `web/scripts/doctor.ts` |
| `forge help` | Prints launcher help. | `bin/forge` |

The launcher may add more commands later, but broad reset commands remain out of
scope until each destructive or credential-affecting action has an explicit
contract.

## Install And Link Model

The repository-owned launcher lives at:

```text
bin/forge
```

`scripts/install.sh` links it as `forge` in a writable PATH directory. If no
preferred PATH directory is writable, it falls back to `~/.local/bin` and warns
when that directory is not on PATH.

Advanced users and tests can choose a link location with:

```bash
FORGE_CLI_LINK_DIR=/path/on/PATH bash scripts/install.sh
```

The uninstall script removes only symlinks that point back to this checkout's
`bin/forge`. It does not remove unrelated commands named `forge`.

## Ownership And Routing

The CLI routes to existing workflows rather than replacing them.

| Area | Primary owner | Current source of truth |
|---|---|---|
| CLI taxonomy and command contracts | Architect | This document and future ADRs |
| Install, upgrade, uninstall, machine checks | DevOps | `scripts/install.sh`, `scripts/uninstall.sh` |
| Web app runtime | Frontend / Backend | `web/package.json` scripts |
| Worker runtime | Backend | `web/package.json`, `web/worker/` |
| Credential recovery | Backend | `web/scripts/reset-password.ts` |
| Tests and validation | QA | `web/package.json` scripts and shell dry-runs |
| User-facing docs | Documentation | `README.md`, `docs/`, `web/README.md` |

Routing rule: `bin/forge` may orchestrate existing scripts, but it must not fork
installer, uninstaller, database, worker, or authentication logic.

## Non-Goals

- Do not publish a global npm package yet.
- Do not add a Homebrew formula yet.
- Do not introduce a separate installer framework.
- Do not make `forge uninstall` more destructive than `scripts/uninstall.sh`.
- Do not add a `forget` compatibility alias.
- Do not accept password arguments through `forge reset-credentials`; shell
  history and process argv are not acceptable places for recovery secrets.

## Verification

Minimum checks for CLI changes:

```bash
bin/forge help
FORGE_CLI_LINK_DIR="$(mktemp -d)" bash scripts/install.sh --dry-run
bash scripts/uninstall.sh --dry-run
cd /tmp && /path/to/Forge/bin/forge help
cd web && npm test -- auth
cd web && npm run lint
```

When validating the real linked command, run it from outside the repository:

```bash
cd /tmp
forge help
forge doctor
```
