#!/usr/bin/env bash
#
# Forge — one-command macOS installer (Homebrew-native, no Docker).
#
# Installs and starts Postgres + Redis via Homebrew, generates all infra
# secrets, writes a complete repo-root .env (no manual editing), then prepares
# and verifies the web app. Provider API keys are NOT requested here — you add
# those in the web UI when you pick a provider.
#
# Usage:   bash scripts/install-mac.sh
# Re-runnable: every step is idempotent, so it is safe to run again.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
PG_FORMULA="postgresql@16"

# Zero-config local AI via Ollama. Set FORGE_SKIP_OLLAMA=1 to skip this and
# configure cloud providers in the web UI instead.
SKIP_OLLAMA="${FORGE_SKIP_OLLAMA:-0}"
ZERO_CONFIG_MODEL="${FORGE_ZERO_CONFIG_MODEL:-qwen2.5-coder:7b}"
export FORGE_ZERO_CONFIG_MODEL="$ZERO_CONFIG_MODEL"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '\033[1;33m    warning:\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 0. Sanity checks
# ---------------------------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. See README.md for other platforms."

bold "Forge installer (macOS)"
info "Repo: $REPO_ROOT"

# ---------------------------------------------------------------------------
# 1. Homebrew
# ---------------------------------------------------------------------------
step "Checking Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  info "Homebrew not found — installing (you may be prompted for your password)..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Make brew available on the current shell (Apple Silicon vs Intel prefix).
  if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
  if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
else
  info "Homebrew found: $(brew --version | head -1)"
fi
command -v brew >/dev/null 2>&1 || die "Homebrew is still not on PATH. Open a new terminal and re-run."

# ---------------------------------------------------------------------------
# 2. Dependencies: Node, Postgres, Redis
# ---------------------------------------------------------------------------
step "Installing dependencies (node, $PG_FORMULA, redis)"
brew_install_if_missing() {
  local formula="$1"
  if brew list "$formula" >/dev/null 2>&1; then
    info "$formula already installed"
  else
    info "installing $formula..."
    brew install "$formula"
  fi
}
brew_install_if_missing node
brew_install_if_missing "$PG_FORMULA"
brew_install_if_missing redis
if [ "$SKIP_OLLAMA" != "1" ]; then
  brew_install_if_missing ollama
fi

# postgresql@16 is keg-only — put its client binaries (psql, pg_isready) on PATH
# for this script. We also remind the user to add it to their shell profile.
PG_BIN="$(brew --prefix "$PG_FORMULA")/bin"
export PATH="$PG_BIN:$PATH"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 20 ] || warn "Node $(node -v 2>/dev/null) detected; Forge targets Node 20+. Consider 'brew upgrade node'."

# ---------------------------------------------------------------------------
# 3. Start services
# ---------------------------------------------------------------------------
step "Starting Postgres and Redis (brew services)"
brew services start "$PG_FORMULA" >/dev/null
brew services start redis >/dev/null

info "Waiting for Postgres to accept connections..."
for _ in $(seq 1 30); do
  if pg_isready -q -h localhost -p 5432 >/dev/null 2>&1; then break; fi
  sleep 1
done
pg_isready -q -h localhost -p 5432 || die "Postgres did not become ready. Check: brew services list"
info "Postgres is ready."

if [ "$SKIP_OLLAMA" != "1" ]; then
  step "Starting Ollama (local AI runtime)"
  brew services start ollama >/dev/null
  info "Waiting for Ollama to accept connections..."
  for _ in $(seq 1 30); do
    if curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1; then break; fi
    sleep 1
  done
  if curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1; then
    info "Ollama is ready."
  else
    warn "Ollama did not become ready — skipping model pull. Start it later with: brew services start ollama"
    SKIP_OLLAMA=1
  fi
fi

# ---------------------------------------------------------------------------
# 4. Create the forge role + database (idempotent)
# ---------------------------------------------------------------------------
step "Provisioning the 'forge' database"
# A fresh .env gets a freshly generated DB password; if .env already has one we
# reuse it so the role password and DATABASE_URL stay in sync across re-runs.
if [ -f "$ENV_FILE" ] && grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  DB_PASSWORD="$(sed -n 's#^DATABASE_URL=postgresql://forge:\([^@]*\)@.*#\1#p' "$ENV_FILE" | head -1)"
fi
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -hex 16)}"

# Connect to the default 'postgres' maintenance DB as the current macOS superuser.
if ! psql -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='forge'" | grep -q 1; then
  psql -d postgres -c "CREATE ROLE forge LOGIN PASSWORD '$DB_PASSWORD';" >/dev/null
  info "Created role 'forge'."
else
  psql -d postgres -c "ALTER ROLE forge PASSWORD '$DB_PASSWORD';" >/dev/null
  info "Role 'forge' exists — password synced."
fi
if ! psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='forge'" | grep -q 1; then
  psql -d postgres -c "CREATE DATABASE forge OWNER forge;" >/dev/null
  info "Created database 'forge'."
else
  info "Database 'forge' exists."
fi

# ---------------------------------------------------------------------------
# 5. Write .env with generated secrets (no manual editing)
# ---------------------------------------------------------------------------
step "Writing $ENV_FILE"
if [ -f "$ENV_FILE" ]; then
  info ".env already exists — leaving it untouched."
else
  SESSION_SECRET="$(openssl rand -hex 32)"
  cat > "$ENV_FILE" <<EOF
# Generated by scripts/install-mac.sh — infra secrets are filled in for you.
# Provider API keys are entered in the Forge web UI, not here.

# PostgreSQL (Homebrew-native, no Docker)
DATABASE_URL=postgresql://forge:${DB_PASSWORD}@localhost:5432/forge

# Redis (Homebrew-native, no Docker)
REDIS_URL=redis://localhost:6379/0

# Web UI
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_TELEMETRY_DISABLED=1

# Worker
FORGE_WORKER_CLAIM_TIMEOUT_SECONDS=5

# Session — auto-generated 32-byte hex HMAC secret
SESSION_SECRET=${SESSION_SECRET}

# WebAuthn / Passkeys (localhost dev defaults)
WEBAUTHN_RP_ID=localhost
WEBAUTHN_RP_NAME=Forge
WEBAUTHN_ORIGIN=http://localhost:3000
EOF
  chmod 600 "$ENV_FILE"
  info "Wrote .env with generated SESSION_SECRET and DB password (chmod 600)."
fi

# ---------------------------------------------------------------------------
# 6. Prepare the web app
# ---------------------------------------------------------------------------
step "Installing web dependencies and preparing the database"
cd "$REPO_ROOT/web"
npm install
npm run db:migrate
npm run db:seed-agents

# Zero-config local AI: pull the model and seed the matching providers so the
# app can run AI immediately with no API keys. Order matters — this runs after
# db:seed-agents so the agent rows exist to be linked to the provider.
if [ "$SKIP_OLLAMA" != "1" ]; then
  step "Setting up zero-config local AI"
  info "Pulling model $ZERO_CONFIG_MODEL (first time can take a few minutes)..."
  ollama pull "$ZERO_CONFIG_MODEL"
  npm run db:seed-providers
else
  info "Skipping local AI setup — configure providers in the web UI (Providers page)."
fi

step "Running the doctor"
npm run doctor

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
step "Install complete"
cat <<EOF

  Forge is installed. Postgres and Redis are running as background services.

  Start the app (two terminals, both from web/):

    cd web && npm run dev       # web UI at http://localhost:3000
    cd web && npm run worker    # task worker

  Then open http://localhost:3000 and register your passkey.
EOF

if [ "$SKIP_OLLAMA" != "1" ]; then
  cat <<EOF

  Local AI is ready — the '$ZERO_CONFIG_MODEL' model is pulled and all agents are
  wired to it, so you can submit a task with no API keys. To use cloud models
  instead, add a provider (and its key) on the Providers page.
EOF
else
  cat <<EOF

  No AI provider is configured yet. Open the Providers page to add one (cloud
  providers need an API key; a local Ollama provider needs no key).
EOF
fi

cat <<EOF

  Tip: to use 'psql' yourself, add this to your shell profile:
    export PATH="$PG_BIN:\$PATH"
EOF
