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
`apt`, `dnf`, `yum`, `zypper`, or `pacman`. It can also start PostgreSQL and
Redis with Docker Compose:

```bash
bash scripts/install.sh --service-mode docker
```

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
- Docker volumes
- `.forge/install-manifest`

## Remove Everything Forge Created

Use this when you want a full local wipe:

```bash
bash scripts/uninstall.sh --remove-data
```

This removes local build artifacts, recorded Forge-only packages, `.env`,
Docker volumes, recorded PostgreSQL database objects, recorded Ollama models,
and Forge's local install state.

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
remove Forge-local build artifacts and Docker services, but it will leave
system packages alone.
