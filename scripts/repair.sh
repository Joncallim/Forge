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
FORGE_PRIVILEGE_SQL="$SCRIPT_DIR/reconcile-forge-app-privileges.sql"

DRY_RUN=0
SKIP_INSTALL=0
SKIP_DOCTOR=0
SKIP_MIGRATE=0
REPAIR_PSQL_ADMIN_RESOLUTION=unresolved
REPAIR_PSQL_ADMIN=()

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

last_install_manifest_value() {
  local key="$1" manifest="$WORKSPACE_ROOT/runtime/install/install-manifest"
  local line value=''
  [ -f "$manifest" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key"=*) value="${line#*=}" ;;
    esac
  done < "$manifest"
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

installed_service_mode_is_native() {
  local service_mode
  service_mode="$(last_install_manifest_value service_mode 2>/dev/null || true)"
  [ "$service_mode" = native ]
}

repair_trusted_linux_path_chain() {
  local path="$1" owner mode
  while :; do
    [ -e "$path" ] || [ -L "$path" ] || return 1
    owner="$(/usr/bin/stat -c '%U' "$path" 2>/dev/null || true)"
    [ "$owner" = root ] || return 1
    if [ ! -L "$path" ]; then
      mode="$(/usr/bin/stat -c '%a' "$path" 2>/dev/null || true)"
      [ -n "$mode" ] && [ $((8#$mode & 022)) -eq 0 ] || return 1
    fi
    [ "$path" = / ] && return 0
    path="${path%/*}"
    [ -n "$path" ] || path=/
  done
}

repair_trusted_linux_candidate() {
  local candidate="$1" canonical
  [ -x "$candidate" ] || return 1
  repair_trusted_linux_path_chain "$candidate" || return 1
  canonical="$(/usr/bin/readlink -f "$candidate" 2>/dev/null || true)"
  [ -n "$canonical" ] && [ -f "$canonical" ] || return 1
  repair_trusted_linux_path_chain "$canonical" || return 1
  printf '%s\n' "$canonical"
}

repair_trusted_linux_tool() {
  local tool="$1" candidate version
  if [ "$tool" = psql ]; then
    for version in 18 17 16; do
      for candidate in "/usr/lib/postgresql/$version/bin/psql" "/usr/pgsql-$version/bin/psql"; do
        repair_trusted_linux_candidate "$candidate" && return 0
      done
    done
  fi
  for candidate in "/usr/local/sbin/$tool" "/usr/local/bin/$tool" "/usr/sbin/$tool" "/usr/bin/$tool" "/sbin/$tool" "/bin/$tool"; do
    repair_trusted_linux_candidate "$candidate" && return 0
  done
  return 1
}

repair_canonical_darwin_candidate() {
  local candidate="$1" target directory links=0
  while [ -L "$candidate" ]; do
    links=$((links + 1))
    [ "$links" -le 32 ] || return 1
    target="$(/usr/bin/readlink "$candidate" 2>/dev/null || true)"
    [ -n "$target" ] || return 1
    case "$target" in
      /*) candidate="$target" ;;
      *) candidate="${candidate%/*}/$target" ;;
    esac
  done
  directory="$(cd -P "$(/usr/bin/dirname "$candidate")" 2>/dev/null && pwd)" || return 1
  candidate="$directory/$(/usr/bin/basename "$candidate")"
  [ -f "$candidate" ] && [ -x "$candidate" ] && [ ! -w "$candidate" ] || return 1
  printf '%s\n' "$candidate"
}

repair_trusted_darwin_psql() {
  local candidate
  for candidate in \
    /opt/homebrew/opt/postgresql@16/bin/psql \
    /opt/homebrew/bin/psql \
    /usr/local/opt/postgresql@16/bin/psql \
    /usr/local/bin/psql \
    /Applications/Postgres.app/Contents/Versions/16/bin/psql
  do
    repair_canonical_darwin_candidate "$candidate" && return 0
  done
  return 1
}

repair_test_psql() {
  local candidate="${FORGE_REPAIR_TEST_PSQL_BIN:-}"
  repair_library_test_route_enabled || return 1
  case "$candidate" in
    /*) [ -f "$candidate" ] && [ -x "$candidate" ] && [ ! -w "$candidate" ] || return 1 ;;
    *) return 1 ;;
  esac
  printf '%s\n' "$candidate"
}

repair_library_test_route_enabled() {
  [ "${FORGE_REPAIR_LIBRARY:-0}" = 1 ] \
    && [ "${BASH_SOURCE[0]}" != "$0" ] \
    && [ "${FORGE_REPAIR_TEST_ROUTE:-}" = current ]
}

probe_repair_psql_admin() {
  local is_superuser psql_status=0
  is_superuser="$("${REPAIR_PSQL_ADMIN[@]}" -d postgres -tAc \
    "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER AND rolsuper" \
    2>/dev/null)" || psql_status="$?"
  [ "$psql_status" -eq 0 ] && [ "$is_superuser" = 1 ]
}

resolve_repair_psql_admin() {
  local os_name socket_dir port psql_bin id_bin sudo_bin runuser_bin test_route=0
  if [ "$REPAIR_PSQL_ADMIN_RESOLUTION" = resolved ]; then
    [ "${#REPAIR_PSQL_ADMIN[@]}" -gt 0 ]
    return
  fi
  REPAIR_PSQL_ADMIN_RESOLUTION=resolved
  REPAIR_PSQL_ADMIN=()

  if repair_library_test_route_enabled; then
    test_route=1
    socket_dir="${FORGE_REPAIR_TEST_PSQL_SOCKET:-}"
    port="${FORGE_REPAIR_TEST_PSQL_PORT:-}"
    os_name="${FORGE_REPAIR_TEST_OS_NAME:-$(/usr/bin/uname -s 2>/dev/null || true)}"
  else
    os_name="$(/usr/bin/uname -s 2>/dev/null || true)"
    case "$os_name" in
      Darwin) socket_dir=/tmp ;;
      Linux) socket_dir=/var/run/postgresql ;;
      *) return 1 ;;
    esac
    port=5432
  fi
  case "$socket_dir" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$port" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || return 1
  [ -d "$socket_dir" ] || return 1
  if [ "$test_route" = 1 ] && [ -n "${FORGE_REPAIR_TEST_PSQL_BIN:-}" ]; then
    psql_bin="$(repair_test_psql 2>/dev/null || true)"
  elif [ "$os_name" = Darwin ]; then
    psql_bin="$(repair_trusted_darwin_psql 2>/dev/null || true)"
  else
    psql_bin="$(repair_trusted_linux_tool psql 2>/dev/null || true)"
  fi
  case "$psql_bin" in
    /*) [ -x "$psql_bin" ] || return 1 ;;
    *) return 1 ;;
  esac

  REPAIR_PSQL_ADMIN=(
    /usr/bin/env
    -u PGHOST -u PGHOSTADDR -u PGPORT -u PGDATABASE -u PGUSER
    -u PGPASSWORD -u PGPASSFILE -u PGSERVICE -u PGSERVICEFILE -u PGOPTIONS
    -u PGSSLMODE -u PGREQUIRESSL -u PGSSLCOMPRESSION -u PGSSLCERT -u PGSSLKEY
    -u PGSSLROOTCERT -u PGSSLCRL -u PGSSLCRLDIR -u PGSSLSNI -u PGREQUIREPEER
    -u PGCHANNELBINDING -u PGTARGETSESSIONATTRS -u PGLOADBALANCEHOSTS
    -u PGCONNECT_TIMEOUT -u PGAPPNAME -u PGCLIENTENCODING -u PGKRBSRVNAME
    -u PGGSSLIB -u PGGSSENCMODE
    "$psql_bin" -X -h "$socket_dir" -p "$port"
  )
  if probe_repair_psql_admin; then
    return 0
  fi

  # Every library-only test route is current-user-only, even when it selects a
  # trusted production psql. No test-controlled routing can reach elevation.
  if [ "$test_route" = 1 ]; then
    REPAIR_PSQL_ADMIN=()
    return 1
  fi

  if [ "$os_name" = Linux ]; then
    id_bin="$(repair_trusted_linux_tool id 2>/dev/null || true)"
  else
    id_bin=/usr/bin/id
  fi
  if [ -n "$id_bin" ] && "$id_bin" postgres >/dev/null 2>&1; then
    if [ "$os_name" = Linux ]; then
      sudo_bin="$(repair_trusted_linux_tool sudo 2>/dev/null || true)"
    else
      sudo_bin=""
    fi
    if [ -n "$sudo_bin" ]; then
      REPAIR_PSQL_ADMIN=(
        /usr/bin/env
        -u PGHOST -u PGHOSTADDR -u PGPORT -u PGDATABASE -u PGUSER
        -u PGPASSWORD -u PGPASSFILE -u PGSERVICE -u PGSERVICEFILE -u PGOPTIONS
        -u PGSSLMODE -u PGREQUIRESSL -u PGSSLCOMPRESSION -u PGSSLCERT -u PGSSLKEY
        -u PGSSLROOTCERT -u PGSSLCRL -u PGSSLCRLDIR -u PGSSLSNI -u PGREQUIREPEER
        -u PGCHANNELBINDING -u PGTARGETSESSIONATTRS -u PGLOADBALANCEHOSTS
        -u PGCONNECT_TIMEOUT -u PGAPPNAME -u PGCLIENTENCODING -u PGKRBSRVNAME
        -u PGGSSLIB -u PGGSSENCMODE
        "$sudo_bin" -n -u postgres "$psql_bin" -X -h "$socket_dir" -p "$port"
      )
      if probe_repair_psql_admin; then
        return 0
      fi
    fi

    if [ "$os_name" = Linux ]; then
      runuser_bin="$(repair_trusted_linux_tool runuser 2>/dev/null || true)"
    else
      runuser_bin=""
    fi
    if [ -n "$runuser_bin" ]; then
      REPAIR_PSQL_ADMIN=(
        /usr/bin/env
        -u PGHOST -u PGHOSTADDR -u PGPORT -u PGDATABASE -u PGUSER
        -u PGPASSWORD -u PGPASSFILE -u PGSERVICE -u PGSERVICEFILE -u PGOPTIONS
        -u PGSSLMODE -u PGREQUIRESSL -u PGSSLCOMPRESSION -u PGSSLCERT -u PGSSLKEY
        -u PGSSLROOTCERT -u PGSSLCRL -u PGSSLCRLDIR -u PGSSLSNI -u PGREQUIREPEER
        -u PGCHANNELBINDING -u PGTARGETSESSIONATTRS -u PGLOADBALANCEHOSTS
        -u PGCONNECT_TIMEOUT -u PGAPPNAME -u PGCLIENTENCODING -u PGKRBSRVNAME
        -u PGGSSLIB -u PGGSSENCMODE
        "$runuser_bin" -u postgres -- "$psql_bin" -X -h "$socket_dir" -p "$port"
      )
      if probe_repair_psql_admin; then
        return 0
      fi
    fi
  fi

  REPAIR_PSQL_ADMIN=()
  return 1
}

reconcile_forge_privileges() {
  local database_name="${1:-}"
  case "$database_name" in
    ''|*[!A-Za-z0-9_]*) die "unsafe local database name for privilege reconciliation" ;;
  esac

  if [ "$DRY_RUN" = "1" ]; then
    info "Would reconcile local forge app privileges in database $database_name."
    return 0
  fi

  if ! resolve_repair_psql_admin; then
    warn "Could not establish controlled native PostgreSQL administrator access; skipping app privilege reconciliation."
    return 0
  fi
  if "${REPAIR_PSQL_ADMIN[@]}" -d "$database_name" --set ON_ERROR_STOP=1 \
    --file "$FORGE_PRIVILEGE_SQL" >/dev/null 2>&1; then
    info "Ensured the forge role can read ordinary forge tables without protected-table DML access."
  else
    warn "Could not transactionally refresh forge app privileges (non-fatal). Re-run 'forge repair' after checking PostgreSQL administrator access."
  fi
  return 0
}

uri_safe_database_password() {
  local password="${1:-}" index=0 length character hex_pair
  length="${#password}"
  [ "$length" -gt 0 ] || return 1

  while [ "$index" -lt "$length" ]; do
    character="${password:$index:1}"
    case "$character" in
      [A-Za-z0-9._~]|'!'|'$'|'&'|"'"|'('|')'|'*'|'+'|','|';'|'='|':'|'-')
        index=$((index + 1))
        ;;
      '%')
        [ $((index + 2)) -lt "$length" ] || return 1
        hex_pair="${password:$((index + 1)):2}"
        case "$hex_pair" in
          [0-9A-Fa-f][0-9A-Fa-f]) ;;
          *) return 1 ;;
        esac
        index=$((index + 3))
        ;;
      *)
        return 1
        ;;
    esac
  done
}

native_forge_database_password() {
  local database_url="${1:-}" remainder encoded_password
  local target='@localhost:5432/forge'

  case "$database_url" in
    postgresql://forge:*) remainder="${database_url#postgresql://forge:}" ;;
    postgres://forge:*) remainder="${database_url#postgres://forge:}" ;;
    *) return 1 ;;
  esac
  case "$remainder" in
    *"$target") encoded_password="${remainder%"$target"}" ;;
    *) return 1 ;;
  esac
  uri_safe_database_password "$encoded_password" || return 1
  percent_decode_database_password "$encoded_password"
}

percent_decode_database_password() {
  local encoded="${1:-}"
  [ -n "$encoded" ] || return 1
  command -v node >/dev/null 2>&1 || return 1

  printf '%s' "$encoded" | node -e '
    const { readFileSync } = require("node:fs")
    try {
      const encoded = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(0))
      const decoded = decodeURIComponent(encoded)
      if (!decoded || /[\u0000-\u001f\u007f-\u009f]/u.test(decoded)) process.exit(1)
      process.stdout.write(decoded)
    } catch {
      process.exit(1)
    }
  '
}

is_native_forge_database_url() {
  native_forge_database_password "${1:-}" >/dev/null
}

should_reconcile_local_forge_privileges() {
  is_native_forge_database_url "${DATABASE_URL:-}"
  installed_service_mode_is_native
}

reconcile_local_forge_privileges_if_managed() {
  [ "$SKIP_MIGRATE" != "1" ] || return 0
  if ! is_native_forge_database_url "${DATABASE_URL:-}"; then
    if [ -n "${DATABASE_URL:-}" ]; then
      info "Skipping local forge privilege reconciliation for a custom DATABASE_URL."
    else
      info "Skipping local forge privilege reconciliation because DATABASE_URL is not set."
    fi
  elif ! installed_service_mode_is_native; then
    info "Skipping local forge privilege reconciliation because the install manifest does not end in service_mode=native."
  elif should_reconcile_local_forge_privileges; then
    reconcile_forge_privileges forge
  fi
}

if [ "${FORGE_REPAIR_LIBRARY:-0}" = 1 ] && [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

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

# A local administrator can restore ordinary app-table access without opening
# direct DML access to protected owner tables. Best-effort: no administrator
# connection leaves the database untouched.
reconcile_local_forge_privileges_if_managed

if [ "$SKIP_DOCTOR" = "1" ]; then
  warn "Skipping doctor by request."
else
  run "Running Forge doctor" bash -c 'cd "$1" && npm run doctor' _ "$WEB_DIR"
fi

info "Repair complete. Start Forge again with: forge"
