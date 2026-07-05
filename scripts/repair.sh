#!/usr/bin/env bash
#
# Repair common local Forge runtime breakage without touching user data.
#
# Typical fixes:
# - stale/corrupt Next.js dev/build cache under web/.next
# - interrupted npm install leaving missing files inside web/node_modules/next
# - unapplied local database migrations when DATABASE_URL is available
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$REPO_ROOT/web"

DRY_RUN=0
SKIP_INSTALL=0
SKIP_DOCTOR=0
SKIP_MIGRATE=0

usage() {
  cat <<'EOF'
Forge repair

Usage:
  forge repair [options]
  bash scripts/repair.sh [options]

Options:
  --dry-run        Print repair actions without changing files
  --skip-install   Do not reinstall web dependencies
  --skip-migrate   Do not run database migrations
  --skip-doctor    Do not run the runtime doctor
  -h, --help       Show this help

Repair removes generated Next.js caches, verifies the pinned Next.js package,
repairs missing web dependencies when needed, applies migrations when
DATABASE_URL is available from the workspace env or local/dev repo/web dotenv
fallbacks, and runs the Forge doctor.
EOF
}

info() {
  printf '[repair] %s\n' "$1"
}

warn() {
  printf '[repair] warning: %s\n' "$1" >&2
}

die() {
  printf '[repair] %s\n' "$1" >&2
  exit 1
}

run() {
  local label="$1"
  shift
  if [ "$DRY_RUN" = "1" ]; then
    printf '[repair] would run: %s:' "$label"
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  info "$label"
  "$@"
}

remove_path() {
  local path="$1"
  if [ ! -e "$path" ]; then
    info "Already clean: ${path#$REPO_ROOT/}"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    info "Would remove ${path#$REPO_ROOT/}"
    return 0
  fi
  info "Removing ${path#$REPO_ROOT/}"
  rm -rf "$path"
}

expand_home_path() {
  case "${1:-}" in
    "~") [ -n "${HOME:-}" ] && printf '%s\n' "$HOME" ;;
    "~/"*) [ -n "${HOME:-}" ] && printf '%s/%s\n' "$HOME" "${1#\~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

workspace_root() {
  local root settings_file
  root="${FORGE_WORKSPACE_ROOT:-}"
  if [ -z "$root" ] && [ -n "${HOME:-}" ]; then
    settings_file="$HOME/Documents/Forge/global-settings.json"
    if [ -f "$settings_file" ]; then
      root="$(sed -n 's/^[[:space:]]*"workspaceRoot"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$settings_file" | head -n1)"
    fi
  fi
  [ -n "$root" ] || root="~/Documents/Forge"
  expand_home_path "$root"
}

env_key_allowed() {
  case "$1" in
    DATABASE_URL|REDIS_URL|SESSION_SECRET|FORGE_ENCRYPTION_KEY|\
    NEXT_PUBLIC_APP_URL|NEXT_TELEMETRY_DISABLED|\
    WEBAUTHN_RP_ID|WEBAUTHN_RP_NAME|WEBAUTHN_ORIGIN|\
    FORGE_EMBED_WORKER|FORGE_AGENT_WEB_SEARCH|FORGE_WORKER_CLAIM_TIMEOUT_SECONDS|\
    FORGE_WORKER_MAX_ATTEMPTS|FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS|\
    FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS|FORGE_PASSKEYS_ENABLED|FORGE_DISABLE_PASSKEYS|\
    FORGE_TRUST_PROXY|FORGE_REQUIRE_GITHUB_CLI|FORGE_WORKSPACE_DISPLAY_ROOT|\
    FORGE_MCPS_ROOT|FORGE_AGENT_CONFIG_DIR|FORGE_ZERO_CONFIG_MODEL|FORGE_OLLAMA_BASE_URL|\
    ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|GOOGLE_API_KEY|\
    OPENROUTER_API_KEY|XAI_API_KEY|DEEPSEEK_API_KEY|MOONSHOT_API_KEY|ZHIPU_API_KEY|\
    GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|FORGE_GITHUB_TOKEN)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

export_env_file() {
  local file="$1" line key value
  [ -f "$file" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in
      ''|\#*) continue ;;
      *=*) ;;
      *) continue ;;
    esac

    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    case "$key" in
      ''|*[!A-Za-z0-9_]*|[0-9]*) continue ;;
    esac
    env_key_allowed "$key" || continue

    if [ -z "${!key+x}" ]; then
      value="${value%\"}"; value="${value#\"}"
      value="${value%\'}"; value="${value#\'}"
      export "$key=$value"
    fi
  done < "$file"
}

next_required_files_missing() {
  local missing=0 file
  for file in \
    "$WEB_DIR/node_modules/next/dist/client/flight-data-helpers.js" \
    "$WEB_DIR/node_modules/next/dist/client/use-merged-ref.js" \
    "$WEB_DIR/node_modules/next/dist/client/normalize-trailing-slash.js" \
    "$WEB_DIR/node_modules/next/dist/client/app-next-turbopack.js" \
    "$WEB_DIR/node_modules/next/dist/client/navigation-build-id.js"
  do
    if [ ! -f "$file" ]; then
      warn "Missing Next.js package file: ${file#$WEB_DIR/}"
      missing=1
    fi
  done
  return "$missing"
}

install_dependencies() {
  if [ "$SKIP_INSTALL" = "1" ]; then
    warn "Skipping dependency repair by request."
    return 0
  fi
  command -v npm >/dev/null 2>&1 || die "npm is required to repair web dependencies."
  run "Installing web dependencies" bash -c 'cd "$1" && npm install' _ "$WEB_DIR"
}

load_database_url_from_env_file() {
  local file="$1" line key value
  [ -z "${DATABASE_URL:-}" ] || return 0
  [ -f "$file" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in
      ''|\#*) continue ;;
      *=*) ;;
      *) continue ;;
    esac

    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    [ "$key" = "DATABASE_URL" ] || continue

    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    [ -n "$value" ] || continue
    export DATABASE_URL="$value"
    info "Loaded DATABASE_URL from ${file#$REPO_ROOT/}."
    return 0
  done < "$file"
}

load_database_url_from_local_fallbacks() {
  local file
  for file in \
    "$REPO_ROOT/.env.development.local" \
    "$REPO_ROOT/.env.local" \
    "$REPO_ROOT/.env.development" \
    "$REPO_ROOT/.env" \
    "$WEB_DIR/.env.development.local" \
    "$WEB_DIR/.env.local" \
    "$WEB_DIR/.env.development" \
    "$WEB_DIR/.env"
  do
    load_database_url_from_env_file "$file"
    [ -z "${DATABASE_URL:-}" ] || return 0
  done
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-doctor) SKIP_DOCTOR=1 ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
  shift
done

[ -f "$WEB_DIR/package.json" ] || die "could not find web/package.json under $REPO_ROOT"

WORKSPACE_ROOT="$(workspace_root)"
ENV_FILE="${FORGE_ENV_FILE:-$WORKSPACE_ROOT/config/forge.env}"
export FORGE_ENV_FILE="$ENV_FILE"
if [ -z "${FORGE_WORKSPACE_ROOT+x}" ]; then
  export FORGE_WORKSPACE_ROOT="$WORKSPACE_ROOT"
fi
export_env_file "$ENV_FILE"

info "Repairing Forge checkout at $REPO_ROOT"
info "Using workspace root $FORGE_WORKSPACE_ROOT"
if [ -f "$ENV_FILE" ]; then
  info "Using environment file $ENV_FILE"
else
  warn "Environment file not found at $ENV_FILE"
fi

if pgrep -f 'next dev|next-server|npm run dev' >/dev/null 2>&1; then
  warn "A Forge/Next dev server appears to be running. Stop it before restarting after repair."
fi

remove_path "$WEB_DIR/.next"
remove_path "$WEB_DIR/node_modules/.cache"

if [ ! -d "$WEB_DIR/node_modules" ]; then
  warn "web/node_modules is missing."
  install_dependencies
elif next_required_files_missing; then
  info "Pinned Next.js package files are present."
else
  install_dependencies
  if next_required_files_missing; then
    info "Next.js package files were restored."
  else
    warn "Next.js package files are still missing after npm install."
    warn "Try removing web/node_modules and rerunning forge repair if this persists."
  fi
fi

run "Cleaning local conflict-copy artifacts" bash -c 'cd "$1" && npm run clean:conflict-copies' _ "$WEB_DIR"

load_database_url_from_local_fallbacks

if [ "$SKIP_MIGRATE" = "1" ]; then
  warn "Skipping database migrations by request."
elif [ -n "${DATABASE_URL:-}" ]; then
  run "Applying database migrations" bash -c 'cd "$1" && npm run db:migrate' _ "$WEB_DIR"
else
  warn "DATABASE_URL is not set; skipping database migrations."
fi

# If a migration was ever applied by a non-forge role, newer tables (e.g. the
# filesystem MCP audit tables) become unreadable to the forge app role, which the
# app logs as "table is not readable". When a local admin psql connection is
# reachable, re-grant table privileges to forge so those tables are readable
# again. Best-effort: no admin connection means we leave the database untouched.
if [ "$SKIP_MIGRATE" != "1" ] && command -v psql >/dev/null 2>&1 \
  && psql -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
  if psql -d postgres -d forge -c 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO forge; GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO forge;' >/dev/null 2>&1; then
    info "Ensured the forge role can read all forge tables."
  fi
fi

if [ "$SKIP_DOCTOR" = "1" ]; then
  warn "Skipping doctor by request."
else
  run "Running Forge doctor" bash -c 'cd "$1" && npm run doctor' _ "$WEB_DIR"
fi

info "Repair complete. Start Forge again with: forge"
