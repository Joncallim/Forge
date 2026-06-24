# Install And Uninstall

The README contains the quick install/uninstall summary. This page is the
detailed reference for what Forge puts on your machine and how to remove it
later.

## What Forge Installs

The installer supports macOS and Linux:

```bash
bash scripts/install.sh
```

On macOS it uses Homebrew. On Linux it uses the detected package manager:
`apt`, `dnf`, `yum`, `zypper`, or `pacman`. It installs PostgreSQL and Redis as
native local services, so Docker is not required.

It can install these pieces:

- Node.js, used to run the web app and worker.
- PostgreSQL 16, used as Forge's database.
- Redis, used as Forge's job queue.
- GitHub CLI, used for repository, issue, pull request, and Actions tooling.
- Ollama, optional, used for local AI.

It also creates local project files:

- `.env`, which contains local URLs and generated secrets.
- `FORGE_EMBED_WORKER=1`, so `npm run dev` starts the web app and task worker
  together by default.
- `FORGE_AGENT_WEB_SEARCH=1`, so architect planning can include no-key web
  research context.
- `FORGE_PASSKEYS_ENABLED=1`, which you can set to `0` before first account
  creation for password-only sign-in.
- `.forge/install-manifest`, which records only the packages Forge installed.
- `web/node_modules`, which contains JavaScript packages for this checkout.
- PostgreSQL and Redis data, which hold settings, credentials, sessions, and
  task history.

The installer records what was missing before Forge installed it. The uninstall
script uses that record to remove Forge-only packages without removing packages
you already had.

The web dependency step uses `npm ci` for a clean lockfile install and falls
back to `npm install` when an existing `node_modules` tree is present. It times
out and retries once instead of hanging forever. Tune the guard with:

```bash
FORGE_NPM_INSTALL_TIMEOUT_SECONDS=1200 bash scripts/install.sh
```

If an install is interrupted with Ctrl+C, re-run `bash scripts/install.sh`; the
installer preserves existing settings and resumes idempotent setup steps.

## Check Readiness Without Installing

Use this when you want to see whether the machine already has what Forge needs:

```bash
bash scripts/install.sh --check
```

This prints the detected OS, package manager, service mode, key tool status,
GitHub CLI authentication status, and local file readiness. It does not change
files, install packages, start services, or create databases.

## Uninstall Forge

Run this from the repository root on macOS or Linux:

```bash
bash scripts/uninstall.sh
```

By default, it asks whether to keep settings and credentials. Keeping them means
Forge can be reinstalled later without losing provider settings, encrypted API
keys, and task history.

The uninstall script supports Homebrew on macOS and `apt`, `dnf`, `yum`,
`zypper`, and `pacman` on Linux. It removes a package only when the install
manifest says Forge added it. If the package manager says another package still
needs it, the script leaves it installed.

## Keep Settings And Credentials

Use this when you may reinstall Forge later:

```bash
bash scripts/uninstall.sh --keep-data
```

This removes local build artifacts and Forge-only packages recorded by the
installer. It keeps:

- `.env`
- PostgreSQL data
- Redis data
- `.forge/install-manifest`

Large folders such as `web/node_modules` are removed with per-path progress and
a timeout guard. If a delete stalls, stop any running `npm run dev`, worker, or
file watcher processes and re-run uninstall. Tune the guard with:

```bash
FORGE_REMOVE_TIMEOUT_SECONDS=300 bash scripts/uninstall.sh
```

## Remove Everything Forge Created

Use this when you want a full local wipe:

```bash
bash scripts/uninstall.sh --remove-data
```

This removes local build artifacts, recorded Forge-only packages, `.env`,
recorded Ollama models, and Forge's local install state. It also
**drops the Forge application database** named in `DATABASE_URL` (default
`forge`), which clears saved logins, projects, and task history — so a fresh
install starts from a clean login. The drop runs whenever PostgreSQL is reachable,
even if the database existed before Forge installed.

By default it does **not** delete the local project folders Forge created. When
run interactively it asks whether to delete them, or you can opt in directly:

```bash
bash scripts/uninstall.sh --remove-data --remove-projects
```

This deletes recorded project folders that pass Forge's safety check, along
with their files. Folders are discovered from the workspace runtime registry
(`~/Documents/Forge/runtime/project-paths` by default), the legacy
`.forge/project-paths` file, and the `projects` table in the database. Unsafe
paths are skipped with a warning and may need manual cleanup. Use
`--keep-projects` to skip the prompt and always keep them.

It still does not remove Homebrew, Linux package managers, Docker
Desktop/Engine, packages that existed before Forge, or recorded packages that
the package manager says are still needed elsewhere.

## Preview First

To see what the script would do:

```bash
bash scripts/uninstall.sh --dry-run
```

For unattended runs:

```bash
bash scripts/uninstall.sh --keep-data --yes
bash scripts/uninstall.sh --remove-data --yes
```

## Older Installs

If your Forge install happened before `.forge/install-manifest` existed, the
uninstall script will not guess which packages are safe to remove. It will still
remove Forge-local build artifacts, but it will leave system packages alone.
