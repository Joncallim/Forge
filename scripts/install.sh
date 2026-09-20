#!/usr/bin/env bash
#
# Forge cross-platform installer.
#
# Supports macOS and Linux from one entrypoint. The script is intentionally
# conservative: it preserves existing settings, records what it installed, and
# only manages the local Forge database when the configured DATABASE_URL points
# at the default local Forge database.
#
# Usage:
#   bash scripts/install.sh
#   bash scripts/install.sh --skip-ollama
#   bash scripts/install.sh --service-mode docker
#   bash scripts/install.sh --dry-run
#   bash scripts/install.sh --upgrade
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd -P "${BASH_SOURCE[0]%/*}" && pwd)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"
FORGE_PRIVILEGE_SQL="$SCRIPT_DIR/reconcile-forge-app-privileges.sql"
expand_home_path_early() {
  case "${1:-}" in
    "~") [ -n "${HOME:-}" ] && printf '%s\n' "$HOME" ;;
    "~/"*) [ -n "${HOME:-}" ] && printf '%s/%s\n' "$HOME" "${1#\~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}
workspace_root_early() {
  local root settings_file
  root="${FORGE_WORKSPACE_ROOT:-}"
  if [ -z "$root" ] && [ -n "${HOME:-}" ]; then
    settings_file="$HOME/Documents/Forge/global-settings.json"
    if [ -f "$settings_file" ]; then
      root="$(sed -n 's/^[[:space:]]*"workspaceRoot"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$settings_file" | head -n1)"
    fi
  fi
  [ -n "$root" ] || root="~/Documents/Forge"
  expand_home_path_early "$root"
}
WORKSPACE_ROOT="$(workspace_root_early)"
ENV_FILE="${FORGE_ENV_FILE:-$WORKSPACE_ROOT/config/forge.env}"
INSTALL_STATE_DIR="${FORGE_INSTALL_STATE_DIR:-$WORKSPACE_ROOT/runtime/install}"
INSTALL_MANIFEST="$INSTALL_STATE_DIR/install-manifest"
INSTALL_LOG="$INSTALL_STATE_DIR/install.log"
LOG_DIR="${FORGE_LOG_DIR:-$WORKSPACE_ROOT/logs}"
OLLAMA_LOG="$LOG_DIR/ollama.log"

OS_NAME="${FORGE_OS_OVERRIDE:-$(uname -s)}"
DRY_RUN="${FORGE_DRY_RUN:-0}"
CHECK_ONLY="${FORGE_CHECK_ONLY:-0}"
YES="${FORGE_ASSUME_YES:-0}"
SKIP_OLLAMA="${FORGE_SKIP_OLLAMA:-0}"
UPGRADE_MODE="${FORGE_UPGRADE:-0}"
PROMPT_UPGRADE_MODE="${FORGE_PROMPT_UPGRADE_MODE:-keep}"
WITH_OLLAMA=0
ZERO_CONFIG_MODEL="${FORGE_ZERO_CONFIG_MODEL:-qwen2.5-coder:7b}"
SERVICE_MODE="${FORGE_SERVICE_MODE:-auto}"
PACKAGE_MANAGER_OVERRIDE="${FORGE_PACKAGE_MANAGER_OVERRIDE:-}"
NPM_INSTALL_TIMEOUT_SECONDS="${FORGE_NPM_INSTALL_TIMEOUT_SECONDS:-900}"
PACKAGE_MANAGER=""
SUDO=()
APT_UPDATED=0
MANAGE_LOCAL_DB=1
PG_FORMULA="postgresql@16"
PG_BIN=""
MANAGED_LOCAL_ADMIN_RESOLUTION=unresolved
MANAGED_LOCAL_ADMIN_MODE=""
MANAGED_LOCAL_ADMIN_SOCKET=""
MANAGED_LOCAL_ADMIN_PORT=""
MANAGED_LOCAL_ADMIN_USER=""
MANAGED_LOCAL_PSQL_ADMIN=()
POSTGRES_ENV_UNSET_ARGS=(
  -u PGHOST -u PGHOSTADDR -u PGPORT -u PGDATABASE -u PGUSER
  -u PGPASSWORD -u PGPASSFILE -u PGSERVICE -u PGSERVICEFILE -u PGOPTIONS
  -u PGSSLMODE -u PGREQUIRESSL -u PGSSLCOMPRESSION -u PGSSLCERT -u PGSSLKEY
  -u PGSSLROOTCERT -u PGSSLCRL -u PGSSLCRLDIR -u PGSSLSNI -u PGREQUIREPEER
  -u PGCHANNELBINDING -u PGTARGETSESSIONATTRS -u PGLOADBALANCEHOSTS
  -u PGCONNECT_TIMEOUT -u PGAPPNAME -u PGCLIENTENCODING -u PGKRBSRVNAME
  -u PGGSSLIB -u PGGSSENCMODE
)
LOCK_DIR="$INSTALL_STATE_DIR/install.lock"
INSTALL_LOCK_HELD=0
TEMP_FILES=""
TEMP_DIRS=""
NATIVE_ENV_SNAPSHOT_DIR=""
NATIVE_ENV_SNAPSHOT_FD=""
NATIVE_ENV_BYTES=""
NATIVE_ENV_SHA256=""

export FORGE_ZERO_CONFIG_MODEL="$ZERO_CONFIG_MODEL"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '\033[1;33m    warning:\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

truthy() {
  case "${1:-}" in
    1|true|TRUE|True|yes|YES|Yes|on|ON|On) return 0 ;;
    *) return 1 ;;
  esac
}

DRY_RUN="$(truthy "$DRY_RUN" && printf 1 || printf 0)"
CHECK_ONLY="$(truthy "$CHECK_ONLY" && printf 1 || printf 0)"
YES="$(truthy "$YES" && printf 1 || printf 0)"
SKIP_OLLAMA="$(truthy "$SKIP_OLLAMA" && printf 1 || printf 0)"
UPGRADE_MODE="$(truthy "$UPGRADE_MODE" && printf 1 || printf 0)"

usage() {
  cat <<'EOF'
Forge installer for macOS and Linux.

Day-to-day workflow:
  After `git pull`, run `bash scripts/install.sh --upgrade` to sync
  dependencies and apply new database migrations without reinstalling
  system packages.

Options:
  --skip-ollama          Do not install or configure local Ollama AI.
  --with-ollama          Install/configure Ollama even if FORGE_SKIP_OLLAMA=1.
  --service-mode MODE    auto, native, or docker. Default: auto.
                         native uses Homebrew on macOS and system packages on Linux.
                         docker starts only PostgreSQL and Redis via Docker Compose.
  --upgrade              Lightweight mode for machines that already have Forge
                         installed: skips Homebrew/package-manager installs and
                         the Ollama install step, but still starts services,
                         provisions the database, writes the env file, runs
                         npm install/db:migrate/db:seed-agents, and runs the
                         doctor. Implies --yes. Skips the Ollama model pull
                         unless --with-ollama is also passed.
  --prompt-mode MODE     keep or overwrite local workspace prompts on upgrade.
                         Default: keep.
  --keep-prompts         Preserve local workspace prompts. Same as
                         --prompt-mode keep.
  --overwrite-prompts    Replace local workspace prompts from repository
                         defaults after backing them up.
  --yes, -y              Assume yes for package manager prompts where supported.
  --check                Inspect local readiness without changing the machine.
  --dry-run              Print the planned work without changing the machine.
  --help, -h             Show this help.

Environment:
  FORGE_SKIP_OLLAMA=1
  FORGE_ZERO_CONFIG_MODEL=qwen2.5-coder:7b
  FORGE_SERVICE_MODE=auto|native|docker
  FORGE_PROMPT_UPGRADE_MODE=keep|overwrite
  FORGE_CHECK_ONLY=1
  FORGE_DRY_RUN=1
  FORGE_UPGRADE=1
  FORGE_OS_OVERRIDE=Darwin|Linux              # dry-run/testing helper
  FORGE_PACKAGE_MANAGER_OVERRIDE=apt|brew     # dry-run/testing helper
  FORGE_ENV_FILE=/path/to/.env                # testing/advanced helper
  FORGE_INSTALL_STATE_DIR=/path/to/state      # testing/advanced helper
  FORGE_CLI_LINK_DIR=/path/on/PATH            # testing/advanced helper
  FORGE_NPM_INSTALL_TIMEOUT_SECONDS=900       # npm install/ci timeout guard
EOF
}

on_error() {
  local exit_code="$?"
  local line_no="${1:-unknown}"
  printf '\n' >&2
  if [ "$DRY_RUN" != "1" ]; then
    printf 'Install log: %s\n' "$INSTALL_LOG" >&2
  fi
  die "Installer failed near line $line_no. Re-run with --dry-run to preview, or check the last step above."
  exit "$exit_code"
}
trap 'on_error "$LINENO"' ERR

cleanup() {
  local file directory
  if [ -n "${NATIVE_ENV_SNAPSHOT_FD:-}" ]; then
    # This descriptor is allocated by Bash itself below. Closing it here keeps
    # a failed elevated-controller launch from retaining a secret-bearing FD.
    { exec {NATIVE_ENV_SNAPSHOT_FD}<&-; } 2>/dev/null || true
    NATIVE_ENV_SNAPSHOT_FD=""
  fi
  for file in $TEMP_FILES; do
    [ -n "$file" ] && rm -f "$file" 2>/dev/null || true
  done
  for directory in $TEMP_DIRS; do
    case "$directory" in
      "${TMPDIR:-/tmp}"/forge-managed-helper.*|"${TMPDIR:-/tmp}"/forge-native-env.*) /bin/rm -rf -- "$directory" 2>/dev/null || true ;;
    esac
  done

  if [ "$DRY_RUN" != "1" ] && [ "$INSTALL_LOCK_HELD" = 1 ] && [ -d "$LOCK_DIR" ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
    INSTALL_LOCK_HELD=0
  fi
}
trap cleanup EXIT

if ! { [ "${FORGE_INSTALL_LIBRARY:-0}" = "1" ] && [ "${BASH_SOURCE[0]}" != "$0" ]; }; then
  while [ "$#" -gt 0 ]; do
    case "$1" in
    --skip-ollama)
      SKIP_OLLAMA=1
      ;;
    --with-ollama)
      SKIP_OLLAMA=0
      WITH_OLLAMA=1
      ;;
    --upgrade)
      UPGRADE_MODE=1
      YES=1
      ;;
    --prompt-mode)
      shift
      [ "$#" -gt 0 ] || die "--prompt-mode requires keep or overwrite"
      PROMPT_UPGRADE_MODE="$1"
      ;;
    --keep-prompts)
      PROMPT_UPGRADE_MODE="keep"
      ;;
    --overwrite-prompts)
      PROMPT_UPGRADE_MODE="overwrite"
      ;;
    --service-mode)
      shift
      [ "$#" -gt 0 ] || die "--service-mode requires auto, native, or docker"
      SERVICE_MODE="$1"
      ;;
    --yes|-y)
      YES=1
      ;;
    --check)
      CHECK_ONLY=1
      DRY_RUN=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
    esac
    shift
  done
fi

case "$SERVICE_MODE" in
  auto|native|docker) ;;
  *) die "Unsupported service mode: $SERVICE_MODE" ;;
esac

case "$PROMPT_UPGRADE_MODE" in
  keep|overwrite) ;;
  *) die "Unsupported prompt mode: $PROMPT_UPGRADE_MODE" ;;
esac

case "$NPM_INSTALL_TIMEOUT_SECONDS" in
  ''|*[!0-9]*)
    die "FORGE_NPM_INSTALL_TIMEOUT_SECONDS must be a positive integer."
    ;;
  *)
    [ "$NPM_INSTALL_TIMEOUT_SECONDS" -gt 0 ] || die "FORGE_NPM_INSTALL_TIMEOUT_SECONDS must be a positive integer."
    ;;
esac

run() {
  local description="$1"
  shift
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] $description"
    return 0
  fi
  "$@"
}

run_quiet() {
  local description="$1"
  shift
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] $description"
    return 0
  fi
  ensure_install_state
  {
    printf '\n[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$description"
    printf 'Command:'
    printf ' %q' "$@"
    printf '\n'
  } >> "$INSTALL_LOG" 2>&1
  chmod 600 "$INSTALL_LOG" 2>/dev/null || true
  "$@" >> "$INSTALL_LOG" 2>&1
}

run_quiet_redacted() {
  local description="$1"
  shift
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] $description"
    return 0
  fi
  ensure_install_state
  {
    printf '\n[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$description"
    printf 'Command: [redacted: contains generated secret]\n'
  } >> "$INSTALL_LOG" 2>&1
  chmod 600 "$INSTALL_LOG" 2>/dev/null || true
  "$@" >> "$INSTALL_LOG" 2>&1
}

run_quiet_redacted_stdin() {
  local description="$1"
  local stdin_payload="$2"
  shift 2
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] $description"
    return 0
  fi
  ensure_install_state
  {
    printf '\n[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$description"
    printf 'Command: [redacted: stdin contains generated secret]\n'
  } >> "$INSTALL_LOG" 2>&1
  chmod 600 "$INSTALL_LOG" 2>/dev/null || true
  printf '%s\n' "$stdin_payload" | "$@" >> "$INSTALL_LOG" 2>&1
}

run_with_timeout() {
  local description="$1"
  local timeout_seconds="$2"
  shift 2

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] $description"
    return 0
  fi

  local attempt max_attempts pid elapsed exit_code timed_out
  max_attempts=2
  attempt=1

  while [ "$attempt" -le "$max_attempts" ]; do
    info "$description (attempt $attempt/$max_attempts; timeout ${timeout_seconds}s)"
    "$@" &
    pid="$!"
    elapsed=0
    timed_out=0

    while kill -0 "$pid" 2>/dev/null; do
      sleep 5
      elapsed=$((elapsed + 5))
      if [ $((elapsed % 30)) -eq 0 ]; then
        info "Still running after ${elapsed}s: $description"
      fi
      if [ "$elapsed" -ge "$timeout_seconds" ]; then
        timed_out=1
        warn "$description timed out after ${timeout_seconds}s. Stopping it and retrying if possible."
        kill -TERM "$pid" 2>/dev/null || true
        sleep 5
        kill -KILL "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        exit_code=124
        break
      fi
    done

    if [ "$timed_out" = "0" ]; then
      if wait "$pid"; then
        return 0
      else
        exit_code="$?"
      fi
    fi

    if [ "$attempt" -lt "$max_attempts" ]; then
      warn "$description failed. Retrying once."
    fi
    attempt=$((attempt + 1))
  done

  return "$exit_code"
}

ensure_install_state() {
  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi

  mkdir -p "$INSTALL_STATE_DIR"
  mkdir -p "$LOG_DIR"
  chmod 700 "$INSTALL_STATE_DIR" 2>/dev/null || true
  chmod 700 "$LOG_DIR" 2>/dev/null || true
  if [ ! -f "$INSTALL_MANIFEST" ]; then
    {
      printf '# Forge install manifest\n'
      printf '# Used by uninstall helpers to remove only Forge-installed items.\n'
      printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf 'installer=scripts/install.sh\n'
    } > "$INSTALL_MANIFEST"
    chmod 600 "$INSTALL_MANIFEST" 2>/dev/null || true
  fi
}

manifest_has() {
  local key="$1"
  local value="$2"
  [ -f "$INSTALL_MANIFEST" ] && grep -Fqx "$key=$value" "$INSTALL_MANIFEST"
}

record_manifest() {
  local key="$1"
  local value="$2"
  [ "$DRY_RUN" = "1" ] && return 0
  ensure_install_state
  if ! manifest_has "$key" "$value"; then
    printf '%s=%s\n' "$key" "$value" >> "$INSTALL_MANIFEST"
  fi
}

record_current_manifest_value() {
  local key="$1"
  local value="$2"
  local replacement
  [ "$DRY_RUN" = "1" ] && return 0
  ensure_install_state
  replacement="$(mktemp "${INSTALL_MANIFEST}.tmp.XXXXXX")"
  TEMP_FILES="${TEMP_FILES} ${replacement}"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key"=*) continue ;;
    esac
    printf '%s\n' "$line"
  done < "$INSTALL_MANIFEST" > "$replacement"
  printf '%s=%s\n' "$key" "$value" >> "$replacement"
  chmod 600 "$replacement" 2>/dev/null || true
  mv "$replacement" "$INSTALL_MANIFEST"
}

make_temp_file() {
  local file
  file="$(mktemp)"
  TEMP_FILES="${TEMP_FILES} ${file}"
  printf '%s\n' "$file"
}

env_value() {
  local key="$1"
  local file="${2:-$ENV_FILE}"
  [ -f "$file" ] || return 0
  sed -n "s/^${key}=//p" "$file" | head -1
}

initial_env_value() {
  local key="$1" value
  value="$(env_value "$key")"
  if [ -z "$value" ] && [ ! -f "$ENV_FILE" ] && [ -f "$REPO_ROOT/.env" ]; then
    value="$(env_value "$key" "$REPO_ROOT/.env")"
  fi
  printf '%s' "$value"
}

placeholder_value() {
  case "${1:-}" in
    ''|change_me|change-me|password|your_password|paste_the_generated_value_here|change_me_generate_separately|change_me_generate_with_openssl_rand_hex_32)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

placeholder_database_url() {
  case "${1:-}" in
    *'://forge:change_me@localhost:5432/forge'|*'://forge:change_me_generate_separately@localhost:5432/forge'|*'://forge:password@localhost:5432/forge')
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

set_env_line() {
  local key="$1"
  local value="$2"
  local tmp_file

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Set $key in $ENV_FILE"
    return 0
  fi

  tmp_file="$(make_temp_file)"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 {
      print key "=" value
      replaced = 1
      next
    }
    { print }
    END {
      if (replaced == 0) {
        print key "=" value
      }
    }
  ' "$ENV_FILE" > "$tmp_file"
  mv "$tmp_file" "$ENV_FILE"
}

random_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
    return 0
  fi

  if command -v od >/dev/null 2>&1; then
    od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
    printf '\n'
    return 0
  fi

  if [ "$DRY_RUN" = "1" ]; then
    printf '%0*s\n' "$((bytes * 2))" 0 | tr ' ' 0
    printf '\n'
    return 0
  fi

  die "Could not generate a secret because neither openssl nor od is available."
}

sql_escape_literal() {
  printf '%s' "$1" | sed "s/'/''/g"
}

setup_sudo() {
  if [ "$DRY_RUN" = "1" ]; then
    SUDO=(sudo)
    return 0
  fi

  if [ "$OS_NAME" = "Darwin" ]; then
    return 0
  fi

  if [ "${EUID:-$(id -u)}" -eq 0 ]; then
    SUDO=()
    return 0
  fi

  command -v sudo >/dev/null 2>&1 || die "sudo is required to install Linux packages. Install sudo or run as root."
  if sudo -n true >/dev/null 2>&1; then
    SUDO=(sudo)
    return 0
  fi

  if [ -t 0 ]; then
    info "sudo may ask for your password during package and service setup."
    SUDO=(sudo)
  else
    die "sudo needs a password, but this shell is non-interactive. Re-run in a terminal or run as root."
  fi
}

detect_package_manager() {
  if [ -n "$PACKAGE_MANAGER_OVERRIDE" ]; then
    if [ "$DRY_RUN" != "1" ]; then
      die "FORGE_PACKAGE_MANAGER_OVERRIDE is only supported with --dry-run."
    fi
    case "$PACKAGE_MANAGER_OVERRIDE" in
      brew|apt|dnf|yum|zypper|pacman) ;;
      *) die "Unsupported package manager override: $PACKAGE_MANAGER_OVERRIDE" ;;
    esac
    PACKAGE_MANAGER="$PACKAGE_MANAGER_OVERRIDE"
    return 0
  fi

  case "$OS_NAME" in
    Darwin)
      PACKAGE_MANAGER="brew"
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        PACKAGE_MANAGER="apt"
      elif command -v dnf >/dev/null 2>&1; then
        PACKAGE_MANAGER="dnf"
      elif command -v yum >/dev/null 2>&1; then
        PACKAGE_MANAGER="yum"
      elif command -v zypper >/dev/null 2>&1; then
        PACKAGE_MANAGER="zypper"
      elif command -v pacman >/dev/null 2>&1; then
        PACKAGE_MANAGER="pacman"
      else
        die "Unsupported Linux package manager. Supported: apt, dnf, yum, zypper, pacman."
      fi
      ;;
    *)
      die "Unsupported OS: $OS_NAME. Forge installer supports macOS and Linux."
      ;;
  esac
}

package_list() {
  case "$PACKAGE_MANAGER" in
    brew)
      brew list --formula 2>/dev/null | sort
      ;;
    apt)
      dpkg-query -W -f='${Package}\n' 2>/dev/null | sort
      ;;
    dnf|yum|zypper)
      rpm -qa --qf '%{NAME}\n' 2>/dev/null | sort
      ;;
    pacman)
      pacman -Qq 2>/dev/null | sort
      ;;
  esac
}

package_installed() {
  local package="$1"
  case "$PACKAGE_MANAGER" in
    brew)
      brew list "$package" >/dev/null 2>&1
      ;;
    apt)
      dpkg -s "$package" >/dev/null 2>&1
      ;;
    dnf|yum|zypper)
      rpm -q "$package" >/dev/null 2>&1
      ;;
    pacman)
      pacman -Qi "$package" >/dev/null 2>&1
      ;;
  esac
}

record_package_diff() {
  local before_file="$1"
  local after_file="$2"
  local key="$3"

  [ "$DRY_RUN" = "1" ] && return 0
  package_list > "$after_file" || true
  while IFS= read -r package; do
    [ -n "$package" ] && record_manifest "$key" "$package"
  done < <(comm -13 "$before_file" "$after_file")
}

install_homebrew_if_needed() {
  [ "$UPGRADE_MODE" = "1" ] && return 0
  [ "$PACKAGE_MANAGER" = "brew" ] || return 0

  step "Checking Homebrew"
  if command -v brew >/dev/null 2>&1; then
    info "Homebrew found: $(brew --version | head -1)"
    return 0
  fi

  info "Homebrew is missing. Installing it can take a few minutes."
  run "Install Homebrew" bash -c '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi

  if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
  if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
  command -v brew >/dev/null 2>&1 || die "Homebrew is still not on PATH. Open a new terminal and re-run."
  record_manifest "brew_formula" "homebrew"
}

install_packages() {
  [ "$#" -gt 0 ] || return 0

  local before_file after_file
  before_file="$(make_temp_file)"
  after_file="$(make_temp_file)"
  if [ "$DRY_RUN" != "1" ]; then
    package_list > "$before_file" || true
  fi

  case "$PACKAGE_MANAGER" in
    brew)
      local formula
      for formula in "$@"; do
        if package_installed "$formula"; then
          info "$formula already installed"
        else
          info "Installing $formula"
          run "brew install $formula" brew install "$formula"
        fi
      done
      record_package_diff "$before_file" "$after_file" "brew_formula"
      ;;
    apt)
      if [ "$APT_UPDATED" = "0" ]; then
        run_quiet "apt-get update" "${SUDO[@]}" apt-get update
        APT_UPDATED=1
      fi
      run "apt-get install $*" "${SUDO[@]}" apt-get install -y "$@"
      record_package_diff "$before_file" "$after_file" "linux_package"
      ;;
    dnf)
      run "dnf install $*" "${SUDO[@]}" dnf install -y "$@"
      record_package_diff "$before_file" "$after_file" "linux_package"
      ;;
    yum)
      run "yum install $*" "${SUDO[@]}" yum install -y "$@"
      record_package_diff "$before_file" "$after_file" "linux_package"
      ;;
    zypper)
      run "zypper install $*" "${SUDO[@]}" zypper --non-interactive install "$@"
      record_package_diff "$before_file" "$after_file" "linux_package"
      ;;
    pacman)
      run "pacman install $*" "${SUDO[@]}" pacman -Sy --needed --noconfirm "$@"
      record_package_diff "$before_file" "$after_file" "linux_package"
      ;;
  esac

  rm -f "$before_file" "$after_file"
}

node_major() {
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

command_status() {
  local label="$1"
  local command_name="$2"
  if command -v "$command_name" >/dev/null 2>&1; then
    info "ok      $label: $(command -v "$command_name")"
    return 0
  fi

  info "missing $label"
  return 1
}

command_succeeds_with_timeout() {
  local timeout_seconds="$1"
  shift

  if [ "$DRY_RUN" = "1" ] && [ "$CHECK_ONLY" != "1" ]; then
    return 0
  fi

  command -v node >/dev/null 2>&1 || return 127

  node - "$timeout_seconds" "$@" <<'NODE'
const { spawn } = require('node:child_process')

const timeoutMs = Number(process.argv[2]) * 1000
const command = process.argv[3]
const args = process.argv.slice(4)
let timedOut = false

const child = spawn(command, args, { stdio: 'ignore' })
const timer = setTimeout(() => {
  timedOut = true
  child.kill('SIGTERM')
  setTimeout(() => child.kill('SIGKILL'), 1000).unref()
}, timeoutMs)

child.on('error', () => {
  clearTimeout(timer)
  process.exit(127)
})

child.on('exit', (code) => {
  clearTimeout(timer)
  if (timedOut) process.exit(124)
  process.exit(code ?? 1)
})
NODE
}

ensure_node() {
  local major
  major="$(node_major)"
  if [ "$major" -ge 22 ]; then
    info "Node $(node -v) is ready."
    return 0
  fi

  if [ "$PACKAGE_MANAGER" = "brew" ]; then
    install_packages node
  elif [ "$PACKAGE_MANAGER" = "apt" ]; then
    install_packages curl ca-certificates gnupg
    info "Installing Node.js 22 from NodeSource because Forge needs Node 22 or newer."
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -"
    else
      curl -fsSL https://deb.nodesource.com/setup_22.x | "${SUDO[@]}" bash -
      record_manifest "apt_source" "nodesource_22"
    fi
    install_packages nodejs
  else
    case "$PACKAGE_MANAGER" in
      dnf|yum|zypper) install_packages nodejs npm ;;
      pacman) install_packages nodejs npm ;;
    esac
  fi

  major="$(node_major)"
  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi
  [ "$major" -ge 22 ] || die "Node $(node -v 2>/dev/null || echo missing) is too old. Install Node 22+ and re-run."
  command -v npm >/dev/null 2>&1 || die "npm is missing after Node install."
  info "Node $(node -v) is ready."
}

github_cli_package() {
  case "$PACKAGE_MANAGER" in
    brew|apt|dnf|yum|zypper|pacman) printf 'gh' ;;
  esac
}

install_github_cli_apt_source() {
  install_packages curl ca-certificates
  info "Installing GitHub CLI from the official apt repository."

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Install GitHub CLI apt keyring and source list"
  else
    run_quiet "Create apt keyring directory" "${SUDO[@]}" install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg |
      "${SUDO[@]}" tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
    run_quiet "Set GitHub CLI apt keyring permissions" "${SUDO[@]}" chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
    {
      printf 'deb [arch='
      dpkg --print-architecture
      printf ' signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n'
    } | "${SUDO[@]}" tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    record_manifest "apt_source" "github_cli"
    APT_UPDATED=0
  fi

  install_packages gh
}

ensure_github_cli() {
  step "Checking GitHub CLI"

  if command -v gh >/dev/null 2>&1; then
    info "GitHub CLI found: $(command -v gh)"
  else
    local package_name
    package_name="$(github_cli_package)"
    info "GitHub CLI is missing. Forge uses it for repository, issue, pull request, and Actions tooling."
    if [ "$PACKAGE_MANAGER" = "apt" ]; then
      install_github_cli_apt_source
    else
      install_packages "$package_name"
    fi
  fi

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Check gh auth status"
    return 0
  fi

  local gh_status=0
  command_succeeds_with_timeout 5 gh auth status || gh_status="$?"
  if [ "$gh_status" = "0" ]; then
    info "GitHub CLI is authenticated."
  elif [ "$gh_status" = "124" ]; then
    warn "GitHub CLI authentication check timed out after 5s. Run: gh auth status"
  else
    warn "GitHub CLI is installed but not authenticated. Run: gh auth login --scopes repo,workflow"
  fi
}

install_base_dependencies() {
  [ "$UPGRADE_MODE" = "1" ] && return 0
  step "Installing base dependencies"

  if [ "$PACKAGE_MANAGER" = "brew" ]; then
    install_packages openssl curl
  else
    case "$PACKAGE_MANAGER" in
      apt) install_packages curl ca-certificates openssl ;;
      dnf|yum|zypper|pacman) install_packages curl openssl ;;
    esac
  fi

  ensure_node
  ensure_github_cli
}

install_native_services() {
  [ "$UPGRADE_MODE" = "1" ] || step "Installing PostgreSQL and Redis"

  case "$PACKAGE_MANAGER" in
    brew)
      [ "$UPGRADE_MODE" = "1" ] || install_packages "$PG_FORMULA" redis
      # Keg-only on Homebrew: psql/pg_isready are never on the default PATH,
      # so this must still run in upgrade mode even though installation is skipped.
      if [ "$DRY_RUN" = "1" ] && ! command -v brew >/dev/null 2>&1; then
        PG_BIN="/opt/homebrew/opt/$PG_FORMULA/bin"
      else
        PG_BIN="$(brew --prefix "$PG_FORMULA")/bin"
      fi
      export PATH="$PG_BIN:$PATH"
      ;;
    apt)
      [ "$UPGRADE_MODE" = "1" ] || install_packages postgresql redis-server
      ;;
    dnf|yum)
      [ "$UPGRADE_MODE" = "1" ] || install_packages postgresql-server postgresql redis
      ;;
    zypper)
      [ "$UPGRADE_MODE" = "1" ] || install_packages postgresql-server postgresql redis
      ;;
    pacman)
      [ "$UPGRADE_MODE" = "1" ] || install_packages postgresql redis
      ;;
  esac
}

service_exists_systemd() {
  local service="$1"
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl list-unit-files "$service.service" >/dev/null 2>&1 ||
    systemctl status "$service.service" >/dev/null 2>&1
}

start_service_candidates() {
  local label="$1"
  shift
  local service

  for service in "$@"; do
    if command -v systemctl >/dev/null 2>&1 && service_exists_systemd "$service"; then
      run_quiet "Start $service service" "${SUDO[@]}" systemctl enable --now "$service"
      if [ "$DRY_RUN" = "1" ]; then
        info "[dry-run] $label service would start as $service."
      else
        info "$label service started as $service."
      fi
      return 0
    fi
  done

  for service in "$@"; do
    if command -v service >/dev/null 2>&1; then
      if run_quiet "Start $service service" "${SUDO[@]}" service "$service" start; then
        if [ "$DRY_RUN" = "1" ]; then
          info "[dry-run] $label service would start as $service."
        else
          info "$label service started as $service."
        fi
        return 0
      fi
    fi
  done

  return 1
}

initialize_linux_postgres_if_needed() {
  [ "$OS_NAME" = "Linux" ] || return 0

  if command -v postgresql-setup >/dev/null 2>&1; then
    run_quiet "Initialize PostgreSQL data directory if needed" "${SUDO[@]}" postgresql-setup --initdb || true
  elif [ "$PACKAGE_MANAGER" = "pacman" ] && [ ! -f /var/lib/postgres/data/PG_VERSION ]; then
    run_quiet "Initialize PostgreSQL data directory" "${SUDO[@]}" install -d -o postgres -g postgres /var/lib/postgres/data
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] Run initdb as postgres"
    elif command -v sudo >/dev/null 2>&1; then
      sudo -u postgres initdb -D /var/lib/postgres/data >/dev/null
    elif command -v runuser >/dev/null 2>&1; then
      runuser -u postgres -- initdb -D /var/lib/postgres/data >/dev/null
    else
      die "Could not initialize PostgreSQL because neither sudo nor runuser is available."
    fi
  fi
}

start_native_services() {
  step "Starting PostgreSQL and Redis"

  if [ "$PACKAGE_MANAGER" = "brew" ]; then
    # Keep dry runs deterministic: show both commands without consulting the
    # local services. In a real run, avoid Homebrew's service dispatcher when
    # the dependency already accepts its normal local protocol.
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] brew services start $PG_FORMULA"
      run_quiet "Start PostgreSQL" brew services start "$PG_FORMULA"
      info "[dry-run] brew services start redis"
      run_quiet "Start Redis" brew services start redis
    else
      if postgres_is_ready; then
        info "PostgreSQL is already ready on localhost:5432; skipping Homebrew service start."
      elif ! run_quiet "Start PostgreSQL" brew services start "$PG_FORMULA"; then
        die "Could not start PostgreSQL with Homebrew. Check the install log: $INSTALL_LOG"
      fi

      if redis_is_ready; then
        info "Redis is already ready on localhost:6379; skipping Homebrew service start."
      elif ! run_quiet "Start Redis" brew services start redis; then
        die "Could not start Redis with Homebrew. Check the install log: $INSTALL_LOG"
      fi
    fi
  else
    initialize_linux_postgres_if_needed
    start_service_candidates "PostgreSQL" postgresql postgresql-16 postgresql@16-main ||
      warn "Could not start PostgreSQL automatically. Start it manually, then re-run."
    start_service_candidates "Redis" redis-server redis ||
      warn "Could not start Redis automatically. Start it manually, then re-run."
  fi

  wait_for_postgres
  wait_for_redis
}

postgres_is_ready() {
  command -v pg_isready >/dev/null 2>&1 &&
    pg_isready -q -h localhost -p 5432 >/dev/null 2>&1
}

redis_is_ready() {
  command -v redis-cli >/dev/null 2>&1 &&
    redis-cli -h localhost -p 6379 ping 2>/dev/null | grep -qx 'PONG'
}

compose_command() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    printf 'docker compose'
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    printf 'docker-compose'
    return 0
  fi
  return 1
}

start_docker_services() {
  step "Starting PostgreSQL and Redis with Docker Compose"
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] FORGE_WORKSPACE_ROOT=$WORKSPACE_ROOT docker compose --env-file $ENV_FILE up -d --wait postgres redis"
    return 0
  fi

  command -v docker >/dev/null 2>&1 || die "Docker is required for --service-mode docker."
  if ! docker info >/dev/null 2>&1; then
    die "Docker is installed but not running. Start Docker and re-run."
  fi

  local compose
  compose="$(compose_command)" || die "Docker Compose is required for --service-mode docker."
  (cd "$REPO_ROOT" && FORGE_WORKSPACE_ROOT="$WORKSPACE_ROOT" $compose --env-file "$ENV_FILE" up -d --wait postgres redis)
}

wait_for_postgres() {
  [ "$DRY_RUN" = "1" ] && return 0
  command -v pg_isready >/dev/null 2>&1 || die "pg_isready is missing. PostgreSQL client tools are required."

  info "Waiting for PostgreSQL on localhost:5432..."
  local attempt
  for attempt in $(seq 1 60); do
    if postgres_is_ready; then
      info "PostgreSQL is ready."
      return 0
    fi
    sleep 1
  done

  die "PostgreSQL did not become ready on localhost:5432."
}

wait_for_redis() {
  [ "$DRY_RUN" = "1" ] && return 0
  if ! command -v redis-cli >/dev/null 2>&1; then
    info "redis-cli is not available, so Redis readiness will be checked by the doctor later."
    return 0
  fi

  info "Waiting for Redis on localhost:6379..."
  local attempt
  for attempt in $(seq 1 60); do
    if redis_is_ready; then
      info "Redis is ready."
      return 0
    fi
    sleep 1
  done

  die "Redis did not become ready on localhost:6379."
}

psql_admin() {
  local psql_status=0

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] psql admin $*"
    return 0
  fi

  resolve_managed_local_admin \
    || die "Could not establish controlled local PostgreSQL administrator access."
  "${MANAGED_LOCAL_PSQL_ADMIN[@]}" "$@" || psql_status="$?"
  return "$psql_status"
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

percent_decode_database_password() {
  local encoded="${1:-}"
  [ -n "$encoded" ] || return 1
  command -v node >/dev/null 2>&1 || return 1

  # Match the URL parser used by postgres.js. The encoded credential is sent
  # over stdin so it is never exposed in the validator process arguments.
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

database_password_utf8_hex() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const { readFileSync } = require("node:fs")
    try {
      const bytes = readFileSync(0)
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      if (!decoded || /[\u0000-\u001f\u007f-\u009f]/u.test(decoded)) process.exit(1)
      process.stdout.write(bytes.toString("hex"))
    } catch {
      process.exit(1)
    }
  '
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

is_native_forge_database_url() {
  native_forge_database_password "${1:-}" >/dev/null
}

should_manage_local_db() {
  local existing_database_url
  existing_database_url="$(env_value DATABASE_URL)"
  if [ -z "$existing_database_url" ]; then
    MANAGE_LOCAL_DB=1
    return 0
  fi

  if is_native_forge_database_url "$existing_database_url"; then
    MANAGE_LOCAL_DB=1
  else
    MANAGE_LOCAL_DB=0
    warn "Existing DATABASE_URL is custom. The installer will not create or alter a local forge database."
  fi
}

provision_database() {
  [ "$SERVICE_MODE" = "docker" ] && return 0
  should_manage_local_db
  [ "$MANAGE_LOCAL_DB" = "1" ] || return 0

  step "Provisioning the local forge database"

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Create or sync local PostgreSQL role forge"
    info "[dry-run] Create local PostgreSQL database forge if missing"
    return 0
  fi

  resolve_managed_local_admin \
    || die "Could not establish controlled local PostgreSQL administrator access."

  local db_password_hex role_action role_provision_sql db_exists
  db_password_hex="$(printf '%s' "$DB_PASSWORD" | database_password_utf8_hex)" \
    || die "The local forge database password is not valid UTF-8 or contains control bytes."
  case "$db_password_hex" in
    ''|*[!0-9a-f]*) die "Could not encode the local forge database password safely." ;;
  esac
  [ $(( ${#db_password_hex} % 2 )) -eq 0 ] \
    || die "Could not encode the local forge database password safely."
  role_provision_sql="$(cat <<SQL
BEGIN;
SET LOCAL application_name = 'forge-installer-role-provision';
LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE pg_catalog.pg_auth_members IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMPORARY TABLE forge_role_provision_input (
  password text NOT NULL,
  action text
) ON COMMIT DROP;
INSERT INTO forge_role_provision_input (password)
SELECT pg_catalog.convert_from(pg_catalog.decode('$db_password_hex', 'hex'), 'UTF8');
DO \$provision\$
DECLARE
  role_password text;
BEGIN
  SELECT password INTO STRICT role_password FROM forge_role_provision_input;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'forge') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members membership
      WHERE membership.roleid = 'forge'::pg_catalog.regrole
         OR membership.member = 'forge'::pg_catalog.regrole
    ) THEN
      RAISE EXCEPTION 'Role forge has membership edges. Remove every grant to or from forge before retrying the installer.';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles role_row
      WHERE role_row.rolname = 'forge'
        AND role_row.rolcanlogin
        AND NOT role_row.rolsuper
        AND NOT role_row.rolcreatedb
        AND NOT role_row.rolcreaterole
        AND NOT role_row.rolreplication
        AND NOT role_row.rolbypassrls
    ) THEN
      RAISE EXCEPTION 'Role forge is outside the safe or known legacy app-role boundary; refusing to alter it.';
    END IF;
    EXECUTE format(
      'ALTER ROLE forge LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
      role_password
    );
    UPDATE forge_role_provision_input SET action = 'existing';
  ELSE
    EXECUTE format(
      'CREATE ROLE forge LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
      role_password
    );
    UPDATE forge_role_provision_input SET action = 'created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles role_row
    WHERE role_row.rolname = 'forge'
      AND role_row.rolcanlogin
      AND NOT role_row.rolinherit
      AND NOT role_row.rolsuper
      AND NOT role_row.rolcreatedb
      AND NOT role_row.rolcreaterole
      AND NOT role_row.rolreplication
      AND NOT role_row.rolbypassrls
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members membership
        WHERE membership.roleid = role_row.oid OR membership.member = role_row.oid
      )
  ) THEN
    RAISE EXCEPTION 'Role forge did not reach the exact safe native app-role boundary.';
  END IF;
END;
\$provision\$;
SELECT action FROM forge_role_provision_input;
COMMIT;
SQL
)"
  ensure_install_state
  {
    printf '\n[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "Transactionally provision forge role"
    printf 'Command: [redacted: stdin contains generated secret]\n'
  } >> "$INSTALL_LOG" 2>&1
  chmod 600 "$INSTALL_LOG" 2>/dev/null || true
  if ! role_action="$(printf '%s\n' "$role_provision_sql" | psql_admin -Atq --set ON_ERROR_STOP=1 2>> "$INSTALL_LOG")"; then
    die "Could not transactionally provision the exact safe forge role. Check the install log for the refused boundary."
  fi
  role_action="$(printf '%s' "$role_action" | tr -d '[:space:]')"
  case "$role_action" in
    created)
      record_manifest "postgres_role" "forge"
      info "Created role forge."
      ;;
    existing) info "Role forge exists; safe attributes and password synced." ;;
    *) die "Forge role provisioning returned an unexpected result." ;;
  esac

  db_exists="$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname='forge'" | tr -d '[:space:]' || true)"
  if [ "$db_exists" = "1" ]; then
    info "Database forge already exists."
  else
    run_quiet "Create forge database" psql_admin -c "CREATE DATABASE forge OWNER forge;"
    record_manifest "postgres_database" "forge"
    info "Created database forge."
  fi
}

# Ensure the forge app role can read and write every table in the forge database.
#
# Migrations normally run as the forge role (the database owner), so forge already
# owns every table and this is a no-op. But if a migration was ever applied by a
# different role (e.g. a superuser), the newer tables end up owned by that role
# and the forge app role gets "permission denied" (SQLSTATE 42501) when reading
# them — which is how the optional audit tables (filesystem MCP runtime audits,
# repository command audits) silently become unreadable and spam the task-detail
# logs. Running these grants as the admin fixes existing tables regardless of
# owner; ALTER DEFAULT PRIVILEGES keeps future admin-created tables readable too.
# Best-effort and idempotent: a failure here never aborts the install.
grant_forge_privileges() {
  [ "$SERVICE_MODE" = "docker" ] && return 0
  [ "${MANAGE_LOCAL_DB:-0}" = "1" ] || return 0

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Reconcile forge app privileges while excluding protected-owner tables"
    return 0
  fi

  # This step is deliberately best-effort. The installer enables inherited ERR
  # traps globally, so isolate this command from that trap and handle its status
  # with the surrounding conditional instead.
  if (
    trap - ERR
    run_quiet "Reconcile forge role database privileges" \
      psql_admin -d forge --set ON_ERROR_STOP=1 --file "$FORGE_PRIVILEGE_SQL"
  ); then
    info "Ensured the forge role can read and write ordinary forge tables without protected-table DML access."
  else
    warn "Could not transactionally refresh forge app privileges (non-fatal). Re-run 'forge upgrade' after checking PostgreSQL administrator access."
  fi
  return 0
}

ensure_env_line() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Append $key to $ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

ensure_env_value() {
  local key="$1"
  local value="$2"
  local mode="${3:-missing}"
  local current

  current="$(env_value "$key")"

  if [ -z "$current" ]; then
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
      set_env_line "$key" "$value"
    else
      ensure_env_line "$key" "$value"
    fi
    return 0
  fi

  case "$mode" in
    placeholder)
      if placeholder_value "$current"; then
        set_env_line "$key" "$value"
      fi
      ;;
    database_url)
      if placeholder_database_url "$current"; then
        set_env_line "$key" "$value"
      fi
      ;;
    missing)
      ;;
    *)
      die "Unknown ensure_env_value mode: $mode"
      ;;
  esac
}

write_env_file() {
  step "Writing local environment"

  if [ -f "$ENV_FILE" ]; then
    info "Environment file already exists; preserving existing values and appending missing defaults."
  elif [ -f "$REPO_ROOT/.env" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] Copy legacy repo .env to $ENV_FILE"
    else
      mkdir -p "$(dirname "$ENV_FILE")"
      cp "$REPO_ROOT/.env" "$ENV_FILE"
      chmod 600 "$ENV_FILE"
    fi
    info "Copied legacy repo .env to the workspace environment file."
  else
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] Create $ENV_FILE"
    else
      mkdir -p "$(dirname "$ENV_FILE")"
      {
        printf '# Generated by scripts/install.sh. Provider API keys are entered in the Forge web UI.\n'
      } > "$ENV_FILE"
      chmod 600 "$ENV_FILE"
    fi
  fi

  ensure_env_value POSTGRES_USER forge_admin
  ensure_env_value POSTGRES_PASSWORD "$DB_PASSWORD" placeholder
  ensure_env_value POSTGRES_DB forge
  ensure_env_value FORGE_APP_DATABASE_PASSWORD "$APP_DATABASE_PASSWORD" placeholder
  ensure_env_value FORGE_RUNTIME_API_DATABASE_PASSWORD "$RUNTIME_API_DATABASE_PASSWORD" placeholder
  ensure_env_value DATABASE_URL "postgresql://forge:${APP_DATABASE_PASSWORD}@localhost:5432/forge" database_url
  if [ "$SERVICE_MODE" = docker ]; then
    # Docker provisioning owns this local endpoint and rotates legacy installs
    # from the old bootstrap password to the split application credential.
    set_env_line DATABASE_URL "postgresql://forge:${APP_DATABASE_PASSWORD}@localhost:5432/forge"
  fi
  ensure_env_value REDIS_URL "redis://localhost:6379/0"
  ensure_env_value NEXT_PUBLIC_APP_URL "http://localhost:3000"
  ensure_env_value NEXT_TELEMETRY_DISABLED "1"
  ensure_env_value FORGE_EMBED_WORKER "1"
  ensure_env_value FORGE_AGENT_WEB_SEARCH "1"
  ensure_env_value FORGE_WORKER_CLAIM_TIMEOUT_SECONDS "5"
  ensure_env_value FORGE_PASSKEYS_ENABLED "1"
  ensure_env_value FORGE_TRUST_PROXY "0"
  ensure_env_value SESSION_SECRET "$SESSION_SECRET" placeholder
  ensure_env_value WEBAUTHN_RP_ID "localhost"
  ensure_env_value WEBAUTHN_RP_NAME "Forge"
  ensure_env_value WEBAUTHN_ORIGIN "http://localhost:3000"

  [ "$DRY_RUN" = "1" ] || chmod 600 "$ENV_FILE" 2>/dev/null || true
  info "Environment file is ready at $ENV_FILE."
}

start_ollama_background() {
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Start ollama serve"
  else
    if ollama_ready; then
      info "Ollama is already reachable."
      return 0
    fi
    ensure_install_state
    nohup ollama serve > "$OLLAMA_LOG" 2>&1 &
    record_manifest "ollama_pid" "$!"
    info "Started Ollama with nohup. Log: $OLLAMA_LOG"
  fi
}

ollama_ready() {
  curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1
}

start_ollama() {
  [ "$SKIP_OLLAMA" = "1" ] && return 0

  step "Starting Ollama"
  if [ "$DRY_RUN" != "1" ] && ollama_ready; then
    info "Ollama is already reachable."
    return 0
  fi

  if [ "$PACKAGE_MANAGER" = "brew" ]; then
    if ! run_quiet "Start Ollama" brew services start ollama; then
      warn "Homebrew could not start Ollama. Trying a local background process instead."
      start_ollama_background
    fi
  elif command -v systemctl >/dev/null 2>&1 && service_exists_systemd ollama; then
    if ! run_quiet "Start Ollama service" "${SUDO[@]}" systemctl enable --now ollama; then
      warn "systemd could not start Ollama. Trying a local background process instead."
      start_ollama_background
    fi
  else
    start_ollama_background
  fi

  [ "$DRY_RUN" = "1" ] && return 0
  info "Waiting for Ollama on localhost:11434..."
  local attempt
  for attempt in $(seq 1 45); do
    if ollama_ready; then
      info "Ollama is ready."
      return 0
    fi
    sleep 1
  done

  warn "Ollama did not become ready. Skipping local model pull for this run."
  SKIP_OLLAMA=1
}

install_ollama_if_needed() {
  [ "$UPGRADE_MODE" = "1" ] && return 0
  [ "$SKIP_OLLAMA" = "1" ] && return 0

  step "Installing Ollama for local AI"
  if command -v ollama >/dev/null 2>&1; then
    info "Ollama already installed."
  elif [ "$PACKAGE_MANAGER" = "brew" ]; then
    install_packages ollama
  elif [ "$OS_NAME" = "Linux" ]; then
    install_packages curl
    info "Installing Ollama with the official Linux installer."
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] curl -fsSL https://ollama.com/install.sh | sh"
    else
      curl -fsSL https://ollama.com/install.sh | "${SUDO[@]}" sh
      record_manifest "linux_ollama_installer" "official"
    fi
  fi

  start_ollama
}

seed_local_ai_if_ready() {
  [ "$SKIP_OLLAMA" = "1" ] && return 0
  if [ "$UPGRADE_MODE" = "1" ] && [ "$WITH_OLLAMA" != "1" ]; then
    return 0
  fi

  step "Setting up zero-config local AI"
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Check and pull Ollama model $ZERO_CONFIG_MODEL"
    info "[dry-run] npm run db:seed-providers"
    return 0
  fi

  local model_was_present=0
  if ollama list 2>/dev/null | awk 'NR > 1 { print $1 }' | grep -Fxq "$ZERO_CONFIG_MODEL"; then
    model_was_present=1
    info "$ZERO_CONFIG_MODEL is already present."
  else
    info "Pulling $ZERO_CONFIG_MODEL. The first pull can take several minutes."
    if ! ollama pull "$ZERO_CONFIG_MODEL"; then
      warn "Could not pull $ZERO_CONFIG_MODEL. Forge can still run; add a provider from the Providers page or pull the model later."
      SKIP_OLLAMA=1
      return 0
    fi
    record_manifest "ollama_model" "$ZERO_CONFIG_MODEL"
  fi

  (cd "$REPO_ROOT/web" && npm run db:seed-providers)
}

lockfile_hash() {
  local lockfile="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$lockfile" | awk '{print $1}'
  else
    shasum -a 256 "$lockfile" | awk '{print $1}'
  fi
}

# Marker written only after npm install/ci completes successfully, recording
# the package-lock.json hash it was run against. Without this, a node_modules
# directory left behind by an interrupted previous run (e.g. the user
# Ctrl-C'd a prior install) looks "present" to a plain directory check, so a
# rerun took the `npm install` branch instead of a clean `npm ci` and left
# partially-extracted packages in place (missing files like @next/env).
# Treating any hash mismatch/missing marker as "not installed" forces a clean
# `npm ci`, which removes node_modules before installing and so always
# recovers from a partial state.
web_node_modules_marker() {
  printf '%s' "$INSTALL_STATE_DIR/web-node-modules.ok"
}

web_node_modules_is_clean() {
  local marker lockfile
  marker="$(web_node_modules_marker)"
  lockfile="$REPO_ROOT/web/package-lock.json"
  [ -d "$REPO_ROOT/web/node_modules" ] || return 1
  [ -f "$marker" ] || return 1
  [ -f "$lockfile" ] || return 1
  [ "$(cat "$marker" 2>/dev/null)" = "$(lockfile_hash "$lockfile")" ]
}

mark_web_node_modules_clean() {
  [ "$DRY_RUN" = "1" ] && return 0
  local lockfile="$REPO_ROOT/web/package-lock.json"
  [ -f "$lockfile" ] || return 0
  ensure_install_state
  lockfile_hash "$lockfile" > "$(web_node_modules_marker)"
}

prepare_web_app() {
  step "Installing web dependencies and preparing the database"
  info "The npm dependency step can take a few minutes on the first run. If interrupted, re-run this installer."
  if [ "$DRY_RUN" != "1" ] && web_node_modules_is_clean; then
    info "web/node_modules already matches package-lock.json. Skipping reinstall."
  elif [ -f "$REPO_ROOT/web/package-lock.json" ]; then
    # npm ci always deletes node_modules first, so this also self-heals a
    # node_modules directory left partially populated by an interrupted run.
    run_with_timeout "npm ci" "$NPM_INSTALL_TIMEOUT_SECONDS" \
      bash -c 'cd "$1" && npm ci --no-audit --no-fund --progress=true' _ "$REPO_ROOT/web"
    mark_web_node_modules_clean
  else
    run_with_timeout "npm install" "$NPM_INSTALL_TIMEOUT_SECONDS" \
      bash -c 'cd "$1" && npm install --no-audit --no-fund --progress=true' _ "$REPO_ROOT/web"
    mark_web_node_modules_clean
  fi
  if [ "$SERVICE_MODE" = docker ]; then
    local compose
    compose="$(compose_command)" || die "Docker Compose is required for managed Docker migrations."
    run "Run the secret-isolated Docker migration image" bash -c 'cd "$1" && FORGE_WORKSPACE_ROOT="$2" $3 --env-file "$4" run --rm migration' _ "$REPO_ROOT" "$WORKSPACE_ROOT" "$compose" "$ENV_FILE"
  elif managed_local_migrations_enabled; then
    run_managed_local_migrations
  else
    run "Apply database migrations with protected-owner cleanup" bash -c 'cd "$1" && FORGE_WORKSPACE_ROOT="$2" FORGE_ENV_FILE="$3" FORGE_SUPPRESS_MIGRATION_NOTICES=1 bash scripts/ci/apply-vnext-phase0-a1-runtime-foundation.sh' _ "$REPO_ROOT/web" "$WORKSPACE_ROOT" "$ENV_FILE"
  fi
  grant_forge_privileges
  run "npm run db:seed-agents" bash -c 'cd "$1" && FORGE_WORKSPACE_ROOT="$2" FORGE_ENV_FILE="$3" FORGE_PROMPT_UPGRADE_MODE="$4" npm run db:seed-agents' _ "$REPO_ROOT/web" "$WORKSPACE_ROOT" "$ENV_FILE" "$PROMPT_UPGRADE_MODE"
}

managed_local_migrations_enabled() {
  [ "$SERVICE_MODE" = "native" ] || return 1
  should_manage_local_db
  [ "$MANAGE_LOCAL_DB" = "1" ]
}

managed_local_postgres_user_exists() {
  /usr/bin/id postgres >/dev/null 2>&1
}

resolve_managed_local_admin() {
  local socket_dir port psql_bin current_user sudo_bin runuser_bin test_mode=""
  if [ "$MANAGED_LOCAL_ADMIN_RESOLUTION" = resolved ]; then
    [ -n "$MANAGED_LOCAL_ADMIN_MODE" ]
    return
  fi
  MANAGED_LOCAL_ADMIN_RESOLUTION=resolved
  MANAGED_LOCAL_ADMIN_MODE=""
  MANAGED_LOCAL_ADMIN_SOCKET=""
  MANAGED_LOCAL_ADMIN_PORT=""
  MANAGED_LOCAL_ADMIN_USER=""
  MANAGED_LOCAL_PSQL_ADMIN=()

  if [ -n "${FORGE_INSTALL_TEST_ADMIN_MODE:-}" ]; then
    case "$FORGE_INSTALL_TEST_ADMIN_MODE" in
      current) test_mode=current ;;
      unavailable) return 1 ;;
      *) die "Unknown installer test admin mode." ;;
    esac
    socket_dir="${FORGE_INSTALL_TEST_PSQL_SOCKET:-/tmp}"
    port="${FORGE_INSTALL_TEST_PSQL_PORT:-5432}"
  else
    case "$OS_NAME" in
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

  if [ -n "$test_mode" ] || [ "$OS_NAME" = Darwin ]; then
    psql_bin="$(command -v psql 2>/dev/null || true)"
  else
    psql_bin="$(trusted_linux_tool psql 2>/dev/null || true)"
  fi
  case "$psql_bin" in
    /*) [ -x "$psql_bin" ] || return 1 ;;
    *) return 1 ;;
  esac

  current_user="$(/usr/bin/id -un 2>/dev/null || true)"
  if [ -n "$current_user" ]; then
    MANAGED_LOCAL_ADMIN_MODE=current
    MANAGED_LOCAL_ADMIN_SOCKET="$socket_dir"
    MANAGED_LOCAL_ADMIN_PORT="$port"
    MANAGED_LOCAL_ADMIN_USER="$current_user"
    MANAGED_LOCAL_PSQL_ADMIN=(
      /usr/bin/env "${POSTGRES_ENV_UNSET_ARGS[@]}"
      "$psql_bin" -X -h "$socket_dir" -p "$port" -U "$current_user" -d postgres
    )
    if probe_managed_local_admin; then
      return 0
    fi
  fi

  # A test-selected psql is caller-controlled. It may prove current-user
  # access, but it is never carried across a sudo/runuser boundary.
  if [ -n "$test_mode" ]; then
    MANAGED_LOCAL_ADMIN_MODE=""
    MANAGED_LOCAL_ADMIN_SOCKET=""
    MANAGED_LOCAL_ADMIN_PORT=""
    MANAGED_LOCAL_ADMIN_USER=""
    MANAGED_LOCAL_PSQL_ADMIN=()
    return 1
  fi

  if [ "$OS_NAME" = Linux ] && managed_local_postgres_user_exists; then
    sudo_bin="$(trusted_linux_tool sudo 2>/dev/null || true)"
    if [ -n "$sudo_bin" ]; then
      MANAGED_LOCAL_ADMIN_MODE=sudo
      MANAGED_LOCAL_ADMIN_SOCKET="$socket_dir"
      MANAGED_LOCAL_ADMIN_PORT="$port"
      MANAGED_LOCAL_ADMIN_USER=postgres
      MANAGED_LOCAL_PSQL_ADMIN=(
        /usr/bin/env "${POSTGRES_ENV_UNSET_ARGS[@]}"
        "$sudo_bin" -n -u postgres "$psql_bin"
        -X -h "$socket_dir" -p "$port" -U postgres -d postgres
      )
      if probe_managed_local_admin; then
        return 0
      fi
    fi
  fi

  if [ "$OS_NAME" = Linux ] && managed_local_postgres_user_exists; then
    runuser_bin="$(trusted_linux_tool runuser 2>/dev/null || true)"
    if [ -n "$runuser_bin" ]; then
      MANAGED_LOCAL_ADMIN_MODE=runuser
      MANAGED_LOCAL_ADMIN_SOCKET="$socket_dir"
      MANAGED_LOCAL_ADMIN_PORT="$port"
      MANAGED_LOCAL_ADMIN_USER=postgres
      MANAGED_LOCAL_PSQL_ADMIN=(
        /usr/bin/env "${POSTGRES_ENV_UNSET_ARGS[@]}"
        "$runuser_bin" -u postgres -- "$psql_bin"
        -X -h "$socket_dir" -p "$port" -U postgres -d postgres
      )
      if probe_managed_local_admin; then
        return 0
      fi
    fi
  fi

  MANAGED_LOCAL_ADMIN_MODE=""
  MANAGED_LOCAL_ADMIN_SOCKET=""
  MANAGED_LOCAL_ADMIN_PORT=""
  MANAGED_LOCAL_ADMIN_USER=""
  MANAGED_LOCAL_PSQL_ADMIN=()
  return 1
}

probe_managed_local_admin() {
  local is_superuser psql_status=0
  is_superuser="$("${MANAGED_LOCAL_PSQL_ADMIN[@]}" -tAc \
    "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER AND rolsuper" \
    2>/dev/null)" || psql_status="$?"
  [ "$psql_status" -eq 0 ] && [ "$is_superuser" = 1 ]
}

clear_postgres_routing_environment() {
  unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE
  unset PGSERVICE PGSERVICEFILE PGOPTIONS PGSSLMODE PGREQUIRESSL
  unset PGSSLCOMPRESSION PGSSLCERT PGSSLKEY PGSSLROOTCERT PGSSLCRL PGSSLCRLDIR
  unset PGSSLSNI PGREQUIREPEER PGCHANNELBINDING PGTARGETSESSIONATTRS
  unset PGLOADBALANCEHOSTS PGCONNECT_TIMEOUT PGAPPNAME PGCLIENTENCODING
  unset PGKRBSRVNAME PGGSSLIB PGGSSENCMODE
}

run_managed_local_migration_stage() {
  local description="$1" stage="$2"
  shift 2

  if [ "${FORGE_INSTALL_TEST_HOOK:-}" = "managed-local-migrations" ]; then
    printf '%s\n' "$stage" >> "${FORGE_INSTALL_TEST_STAGE_LOG:?}"
    if [ "${FORGE_INSTALL_TEST_FAIL_STAGE:-}" = "$stage" ]; then
      case "$stage" in
        s5|registry|runtime) printf '%s-cleanup-attempted\n' "$stage" >> "${FORGE_INSTALL_TEST_STAGE_LOG:?}" ;;
      esac
      return 1
    fi
    return 0
  fi

  if [ "$stage" = controller ]; then
    run_managed_local_controller "$description"
    return
  fi

  case "$MANAGED_LOCAL_ADMIN_MODE" in
    current)
      run "$description" bash -c 'cd "$1"; case "$2" in
        release) npm run protocol:bootstrap-epic-172-release-roles ;;
        migrate-0025) npx tsx scripts/ci/migrate-through-0025.ts ;;
        s3) npm run protocol:bootstrap-epic-172-s3-release-owner ;;
        migrate-0026) npx tsx scripts/ci/migrate-through-0026.ts ;;
        legacy-repair) npm run protocol:repair-epic-172-legacy-release ;;
        s4) npm run protocol:bootstrap-epic-172-s4-roles ;;
        migrate-0027) npx tsx scripts/ci/migrate-through-0027.ts ;;
        s5) bash scripts/ci/apply-epic-172-s5-recovery-migration.sh ;;
        registry) bash scripts/ci/apply-verification-goal-registry-migration.sh ;;
        runtime) bash scripts/ci/apply-vnext-phase0-a1-runtime-foundation.sh ;;
        latest) npm run db:migrate ;;
        *) exit 64 ;;
      esac' _ "$REPO_ROOT/web" "$stage"
      ;;
    sudo)
      run_managed_local_migration_as_sudo "$description" "$stage"
      ;;
    runuser)
      run_managed_local_migration_as_runuser "$description" "$stage"
      ;;
    *) die "Managed local PostgreSQL administrator mode is unavailable." ;;
  esac
}

prepare_native_env_snapshot() {
  local snapshot hash_tool metadata
  local max_bytes=1048576

  # The controller receives a byte snapshot, never FORGE_ENV_FILE.  Open the
  # caller-selected source while still running as the operator, with
  # O_NOFOLLOW enforced by the already-installed, root-owned helper Node.
  # This permits the normal operator-owned config location and an explicit
  # custom location, while rejecting a symlink, directory, special file, or a
  # non-private file (including one writable by group or other users).
  NATIVE_ENV_SNAPSHOT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/forge-native-env.XXXXXX")" \
    || die "Could not create a private native migration environment snapshot."
  TEMP_DIRS="${TEMP_DIRS} ${NATIVE_ENV_SNAPSHOT_DIR}"
  chmod 700 "$NATIVE_ENV_SNAPSHOT_DIR" || die "Could not protect the native migration environment snapshot."
  snapshot="$NATIVE_ENV_SNAPSHOT_DIR/env"
  metadata="$("$MANAGED_HELPER_ROOT/node" - "$ENV_FILE" "$snapshot" "$max_bytes" <<'NODE'
const crypto = require('crypto')
const fs = require('fs')

const [source, snapshot, maximumText] = process.argv.slice(2)
const maximum = Number(maximumText)
if (!source || !snapshot || !Number.isSafeInteger(maximum) || maximum < 1) process.exit(64)

let sourceFd
let snapshotFd
try {
  // O_NOFOLLOW is important here: the caller controls the selected pathname,
  // but root must never be induced to follow it later.
  sourceFd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  const stat = fs.fstatSync(sourceFd)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > maximum) process.exit(65)
  snapshotFd = fs.openSync(snapshot, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
  const digest = crypto.createHash('sha256')
  const chunk = Buffer.allocUnsafe(64 * 1024)
  let total = 0
  for (;;) {
    const received = fs.readSync(sourceFd, chunk, 0, chunk.length, null)
    if (received === 0) break
    total += received
    if (total > maximum) process.exit(66)
    digest.update(chunk.subarray(0, received))
    let offset = 0
    while (offset < received) offset += fs.writeSync(snapshotFd, chunk, offset, received - offset)
  }
  if (total < 1) process.exit(67)
  fs.fsyncSync(snapshotFd)
  process.stdout.write(`${total} ${digest.digest('hex')}\n`)
} finally {
  if (snapshotFd !== undefined) fs.closeSync(snapshotFd)
  if (sourceFd !== undefined) fs.closeSync(sourceFd)
}
NODE
)" || die "Native migration environment must be a private regular non-symlink file of at most 1048576 bytes."

  case "$metadata" in
    *' '* )
      NATIVE_ENV_BYTES="${metadata%% *}"
      NATIVE_ENV_SHA256="${metadata#* }"
      ;;
    *) die "Could not snapshot the native migration environment." ;;
  esac
  case "$NATIVE_ENV_BYTES:$NATIVE_ENV_SHA256" in
    *[!0-9a-f:]*|:*|0:*|*::*|*:*:*) die "Could not validate the native migration environment snapshot." ;;
  esac
  [ "${#NATIVE_ENV_SHA256}" -eq 64 ] || die "Could not validate the native migration environment snapshot."
  [ "$NATIVE_ENV_BYTES" -le "$max_bytes" ] || die "Native migration environment is too large."

  # Rehash the completed snapshot with a trusted system hash implementation.
  # The controller verifies the same digest after elevation, so any same-user
  # mutation between this point and the pipe is a safe refusal, not authority.
  if [ "$OS_NAME" = Linux ]; then
    hash_tool="$(trusted_linux_tool sha256sum)" || die "Managed migrations require a trusted SHA-256 tool."
    NATIVE_ENV_SHA256="$("$hash_tool" "$snapshot" | /usr/bin/awk '{print $1}')"
  else
    hash_tool=/usr/bin/shasum
    [ -x "$hash_tool" ] || die "Managed migrations require the system SHA-256 tool."
    NATIVE_ENV_SHA256="$("$hash_tool" -a 256 "$snapshot" | /usr/bin/awk '{print $1}')"
  fi
  case "$NATIVE_ENV_SHA256" in
    ''|*[!0-9a-f]*) die "Could not hash the native migration environment snapshot." ;;
  esac
  [ "${#NATIVE_ENV_SHA256}" -eq 64 ] || die "Could not hash the native migration environment snapshot."
  exec {NATIVE_ENV_SNAPSHOT_FD}< "$snapshot" || die "Could not open the native migration environment snapshot."
  [ -f "/dev/fd/$NATIVE_ENV_SNAPSHOT_FD" ] || die "Native migration environment snapshot is not a regular file."
}

close_native_env_snapshot() {
  if [ -n "${NATIVE_ENV_SNAPSHOT_FD:-}" ]; then
    { exec {NATIVE_ENV_SNAPSHOT_FD}<&-; } 2>/dev/null || true
    NATIVE_ENV_SNAPSHOT_FD=""
  fi
  if [ -n "${NATIVE_ENV_SNAPSHOT_DIR:-}" ]; then
    /bin/rm -rf -- "$NATIVE_ENV_SNAPSHOT_DIR" 2>/dev/null || true
    NATIVE_ENV_SNAPSHOT_DIR=""
  fi
}

run_managed_local_controller_with_snapshot() {
  local description="$1" status
  shift
  if run "$description" "$@" <&"$NATIVE_ENV_SNAPSHOT_FD"; then
    status=0
  else
    status="$?"
  fi
  close_native_env_snapshot
  return "$status"
}

run_managed_local_controller() {
  local description="$1" sudo_bin peer_uid peer_gid
  peer_uid="$(/usr/bin/id -u "$MANAGED_LOCAL_ADMIN_USER" 2>/dev/null || true)"
  peer_gid="$(/usr/bin/id -g "$MANAGED_LOCAL_ADMIN_USER" 2>/dev/null || true)"
  case "$peer_uid:$peer_gid" in *[!0-9:]*|*::*|0:*|*:0) die "Managed local controller could not establish a non-root peer administrator identity." ;; esac
  [ -n "$MANAGED_LOCAL_ADMIN_SOCKET" ] || die "Managed local controller resolved an empty PostgreSQL socket path."
  prepare_native_env_snapshot
  local controller_args=(--run --native-socket "$MANAGED_LOCAL_ADMIN_SOCKET" --native-port "$MANAGED_LOCAL_ADMIN_PORT" --native-database forge --native-env-bytes "$NATIVE_ENV_BYTES" --native-env-sha256 "$NATIVE_ENV_SHA256" --native-helper-root "$MANAGED_HELPER_ROOT" --native-peer-uid "$peer_uid" --native-peer-gid "$peer_gid" --native-child-node "$MANAGED_HELPER_ROOT/node" --native-reconcile-sql "$MANAGED_HELPER_ROOT/reconcile-forge-app-privileges.sql" --native-legacy-repair-sql "$MANAGED_HELPER_ROOT/epic-172-legacy-0023-0025-v1.sql")
  case "$MANAGED_LOCAL_ADMIN_MODE" in
    current)
      if [ "${EUID:-$(/usr/bin/id -u)}" -eq 0 ]; then
        run_managed_local_controller_with_snapshot "$description" /usr/bin/env -i HOME=/root "$MANAGED_HELPER_ROOT/node" "$MANAGED_HELPER_ROOT/controller.mjs" "${controller_args[@]}"
      else
        if [ "$OS_NAME" = Darwin ]; then sudo_bin=/usr/bin/sudo; else sudo_bin="$(trusted_linux_tool sudo)" || die "Managed local migrations require a trusted sudo."; fi
        run_managed_local_controller_with_snapshot "$description" "$sudo_bin" -n -- /usr/bin/env -i HOME=/root "$MANAGED_HELPER_ROOT/node" "$MANAGED_HELPER_ROOT/controller.mjs" "${controller_args[@]}"
      fi
      ;;
    sudo)
      sudo_bin="$(trusted_linux_tool sudo)" || die "Could not find a root-owned non-writable sudo for elevated managed migrations."
      run_managed_local_controller_with_snapshot "$description" "$sudo_bin" -n -- /usr/bin/env -i HOME=/root "$MANAGED_HELPER_ROOT/node" "$MANAGED_HELPER_ROOT/controller.mjs" "${controller_args[@]}"
      ;;
    runuser)
      [ "${EUID:-$(/usr/bin/id -u)}" -eq 0 ] || die "runuser administration requires a root controller."
      run_managed_local_controller_with_snapshot "$description" /usr/bin/env -i HOME=/root "$MANAGED_HELPER_ROOT/node" "$MANAGED_HELPER_ROOT/controller.mjs" "${controller_args[@]}"
    ;;
    *) die "Managed local PostgreSQL administrator mode is unavailable." ;;
  esac
}

receive_bounded_privileged_stream() {
  local expected_bytes="$1" output="$2"
  shift 2
  case "$expected_bytes" in ''|*[!0-9]*) return 64 ;; esac
  "$@" /bin/sh -c '
    set -eu
    expected="$1"; output="$2"; block=1048576
    blocks=$(((expected + 1 + block - 1) / block))
    umask 077
    exec 7<&0
    /bin/dd bs=$block count=$blocks of="$output" 2>/dev/null <&7 & receiver=$!
    remaining=30
    while /bin/kill -0 "$receiver" 2>/dev/null && [ "$remaining" -gt 0 ]; do /bin/sleep 1; remaining=$((remaining - 1)); done
    timed_out=0
    if /bin/kill -0 "$receiver" 2>/dev/null; then timed_out=1; /bin/kill -TERM "$receiver" 2>/dev/null || true; fi
    status=0; wait "$receiver" || status=$?
    exec 7<&-
    [ "$timed_out" -eq 0 ] || exit 1
    [ "$status" -eq 0 ] || exit 1
    actual=$(/usr/bin/wc -c < "$output" | /usr/bin/tr -d "[:space:]")
    [ "$actual" = "$expected" ]
  ' _ "$expected_bytes" "$output"
}

install_managed_migration_helper() {
  local build_dir source_node digest pack_bytes node_digest installed_node_digest stream_digest target staging install_bin hash_tool root_group canonical_target computed elevator=()
  build_dir="$(mktemp -d "${TMPDIR:-/tmp}/forge-managed-helper.XXXXXX")"
  TEMP_DIRS="${TEMP_DIRS} ${build_dir}"
  if [ "$OS_NAME" = Linux ]; then
    source_node="$(trusted_linux_tool node)" || die "Managed migration helper requires a trusted Node.js 22 executable."
    hash_tool="$(trusted_linux_tool sha256sum)" || die "Managed migration helper requires a trusted SHA-256 tool."
  else
    source_node="$(prepare_pinned_darwin_managed_node)" || die "Managed migration helper could not prepare the pinned official Node.js runtime for macOS."
    hash_tool=/usr/bin/shasum
  fi
  /usr/bin/env -i HOME="${TMPDIR:-/tmp}" PATH=/usr/bin:/bin "$source_node" "$REPO_ROOT/web/scripts/ci/build-managed-migration-helper.mjs" "$build_dir"
  # install.sh is the operator-trusted entry boundary. Its release pin is
  # independent of the writable builder/controller; a self-hash cannot make a
  # hostile replacement installer trustworthy without an out-of-band root.
  digest='4f18768387a206a83c5f9478606e41613bd1e629f6438ec80267b36b7f124589'
  pack_bytes=3627265
  exec 9< "$build_dir/bundle.pack"
  [ -f /dev/fd/9 ] || die "Managed migration helper pack is not a regular file."
  computed="$($source_node -e 'const fs=require("fs"),c=require("crypto").createHash("sha256");c.update(fs.readFileSync(process.argv[1]));process.stdout.write(c.digest("hex"))' "$build_dir/bundle.pack")"
  [ "$computed" = "$digest" ] || die "Managed migration helper bytes do not match the independently pinned release digest. Refusing elevation."
  if [ "$OS_NAME" = Darwin ]; then node_digest="$("$hash_tool" -a 256 "$source_node" | /usr/bin/awk '{print $1}')"; else node_digest="$("$hash_tool" "$source_node" | /usr/bin/awk '{print $1}')"; fi
  target="/var/lib/forge-managed-migration-helper/v3-$digest-$node_digest"
  staging="${target}.next.$$"
  if [ "${EUID:-$(/usr/bin/id -u)}" -ne 0 ]; then
    if [ "$OS_NAME" = Darwin ]; then elevator=(/usr/bin/sudo); else elevator=("$(trusted_linux_tool sudo)"); fi
  fi
  root_group="$(/usr/bin/id -gn 0)"
  [ -n "$root_group" ] || die "Managed migration helper could not resolve the root account's primary group."
  install_bin=/usr/bin/install
  "${elevator[@]}" "$install_bin" -d -o root -g "$root_group" -m 0755 /var/lib/forge-managed-migration-helper
  if ! "${elevator[@]}" /usr/bin/test -d "$target"; then
    "${elevator[@]}" "$install_bin" -d -o root -g "$root_group" -m 0700 "$staging"
    # The invoking shell opens the mutable build result and streams bytes. Root
    # never follows a checkout/build pathname and authenticates the complete
    # stream before parsing any attacker-controlled field.
    receive_bounded_privileged_stream "$pack_bytes" "$staging/bundle.pack" "${elevator[@]}" <&9 \
      || { exec 9<&-; "${elevator[@]}" /bin/rm -rf -- "$staging"; die "Managed migration helper stream was truncated, oversized, or stalled."; }
    exec 9<&-
    if [ "$OS_NAME" = Darwin ]; then stream_digest="$("${elevator[@]}" "$hash_tool" -a 256 "$staging/bundle.pack" | /usr/bin/awk '{print $1}')"; else stream_digest="$("${elevator[@]}" "$hash_tool" "$staging/bundle.pack" | /usr/bin/awk '{print $1}')"; fi
    [ "$stream_digest" = "$digest" ] || { "${elevator[@]}" /bin/rm -rf -- "$staging"; die "Managed migration helper stream changed after precheck; refusing parse or publication."; }
    "${elevator[@]}" "$install_bin" -o root -g "$root_group" -m 0555 "$source_node" "$staging/node"
    if [ "$OS_NAME" = Darwin ]; then installed_node_digest="$("${elevator[@]}" "$hash_tool" -a 256 "$staging/node" | /usr/bin/awk '{print $1}')"; else installed_node_digest="$("${elevator[@]}" "$hash_tool" "$staging/node" | /usr/bin/awk '{print $1}')"; fi
    [ "$installed_node_digest" = "$node_digest" ] || { "${elevator[@]}" /bin/rm -rf -- "$staging"; die "Managed migration helper Node.js changed before pack parsing."; }
    "${elevator[@]}" "$staging/node" -e '
      const fs=require("fs"),path=require("path"),crypto=require("crypto"),root=process.argv[1]
      const pack=JSON.parse(fs.readFileSync(path.join(root,"bundle.pack"),"utf8"))
      if(pack.version!==1||!Array.isArray(pack.files)||pack.files.length===0)process.exit(2)
      const names=pack.files.map(x=>x.name)
      if(JSON.stringify(names)!==JSON.stringify([...names].sort())||new Set(names).size!==names.length)process.exit(3)
      const manifest=[]
      for(const entry of pack.files){
        if(typeof entry.name!=="string"||!entry.name.match(/^[A-Za-z0-9_./-]+$/)||entry.name.startsWith("/")||entry.name.split("/").includes("..")||typeof entry.content!=="string")process.exit(4)
        const bytes=Buffer.from(entry.content,"base64"),sha=crypto.createHash("sha256").update(bytes).digest("hex")
        if(bytes.toString("base64")!==entry.content||bytes.length!==entry.bytes||sha!==entry.sha256)process.exit(5)
        const output=path.join(root,entry.name),parent=path.dirname(output);fs.mkdirSync(parent,{recursive:true,mode:0o755})
        for(let directory=parent;directory!==root;directory=path.dirname(directory))fs.chmodSync(directory,0o755)
        fs.writeFileSync(output,bytes,{mode:0o444,flag:"wx"});fs.chmodSync(output,0o444)
        manifest.push({name:entry.name,bytes:entry.bytes,sha256:entry.sha256})
      }
      const manifestPath=path.join(root,"closure-manifest.json")
      fs.writeFileSync(manifestPath,`${JSON.stringify({version:1,files:manifest},null,2)}\n`,{mode:0o444,flag:"wx"});fs.chmodSync(manifestPath,0o444)
    ' "$staging" || { "${elevator[@]}" /bin/rm -rf -- "$staging"; die "Pinned managed migration helper pack was structurally invalid."; }
    "${elevator[@]}" /bin/rm -f -- "$staging/bundle.pack"
    "${elevator[@]}" /bin/chmod 0755 "$staging"
    "${elevator[@]}" /bin/mv "$staging" "$target" \
      || { "${elevator[@]}" /bin/rm -rf -- "$staging"; die "Managed migration helper publication failed."; }
  fi
  { exec 9<&-; } 2>/dev/null || true
  if [ "$OS_NAME" = Darwin ]; then
    installed_node_digest="$("${elevator[@]}" "$hash_tool" -a 256 "$target/node" | /usr/bin/awk '{print $1}')"
  else
    installed_node_digest="$("${elevator[@]}" "$hash_tool" "$target/node" | /usr/bin/awk '{print $1}')"
  fi
  if [ "$installed_node_digest" != "$node_digest" ]; then
    "${elevator[@]}" /bin/rm -rf -- "$target"
    die "Installed managed migration helper Node.js digest changed during privileged copy."
  fi
  canonical_target="$(cd -P "$target" && pwd -P)" \
    || die "Managed migration helper could not resolve its installed system directory."
  if ! "${elevator[@]}" "$canonical_target/node" -e '
    const fs=require("fs"),path=require("path"),crypto=require("crypto")
    const expected=process.argv[1],root=process.argv[2],manifest=JSON.parse(fs.readFileSync(path.join(root,"closure-manifest.json"),"utf8")),packed=[]
    if(manifest.version!==1||!Array.isArray(manifest.files)||manifest.files.length===0)process.exit(5)
    const names=manifest.files.map(x=>x.name)
    if(JSON.stringify(names)!==JSON.stringify([...names].sort())||new Set(names).size!==names.length)process.exit(6)
    const expectedFiles=new Set(["node","closure-manifest.json",...manifest.files.map(x=>x.name)])
    const walk=(dir,prefix="")=>{for(const d of fs.readdirSync(dir,{withFileTypes:true})){const name=prefix?`${prefix}/${d.name}`:d.name;if(d.isDirectory())walk(path.join(dir,d.name),name);else if(!expectedFiles.has(name))process.exit(7)}};walk(root)
    for(const entry of manifest.files){
      if(typeof entry.name!=="string"||!entry.name.match(/^[A-Za-z0-9_./-]+$/)||entry.name.startsWith("/")||entry.name.split("/").includes(".."))process.exit(8)
      const file=path.join(root,entry.name),leaf=fs.lstatSync(file); if(!leaf.isFile()||leaf.isSymbolicLink())process.exit(1)
      if((leaf.mode&0o777)!==0o444)process.exit(9)
      const bytes=fs.readFileSync(file),sha=crypto.createHash("sha256").update(bytes).digest("hex");if(bytes.length!==entry.bytes||sha!==entry.sha256)process.exit(2)
      packed.push({...entry,content:bytes.toString("base64")})
      for(let current=file;;current=path.dirname(current)){const stat=fs.lstatSync(current);if(stat.uid!==0||(stat.mode&0o22)!==0)process.exit(3);if(current!==file&&(current===root||current.startsWith(`${root}${path.sep}`))&&(stat.mode&0o777)!==0o755)process.exit(10);if(current==="/")break}
    }
    const rebuilt=Buffer.from(`${JSON.stringify({version:1,files:packed})}\n`)
    if(crypto.createHash("sha256").update(rebuilt).digest("hex")!==expected)process.exit(4)
  ' "$digest" "$canonical_target"; then
    "${elevator[@]}" /bin/rm -rf -- "$canonical_target"
    die "Installed managed migration helper digest does not match its independently pinned release bundle."
  fi
  MANAGED_HELPER_ROOT="$canonical_target"
  /bin/rm -rf -- "$build_dir"
}

prepare_pinned_darwin_managed_node() {
  local version=22.23.2 architecture archive archive_bytes expected node_expected actual effective root node_path url target staging root_group installed_digest elevator=()
  [ "$OS_NAME" = Darwin ] || return 1
  case "$(/usr/bin/uname -m)" in
    arm64) architecture=arm64; archive_bytes=25950400; expected=5eff7a9011895aae3f29d06f167b84a62b028a591370c7cafb59103559fd26e1; node_expected=18e387c90ab8a8400183e8bdd396376e1e875b91b4c874b894dcade7b35bf572 ;;
    x86_64) architecture=x64; archive_bytes=27517304; expected=96dff79f4e19a78715da559ec7cac2028f4985a175ea0c3454625a269c21deb7; node_expected=0b4f059915f3bf3c6cbb02422f4a529bfb21cbbec2d29851c9a5d833f78a04f6 ;;
    *) return 1 ;;
  esac
  root="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/forge-node-darwin.XXXXXX")" || return 1
  archive="$root/node.tar.xz"
  url="https://nodejs.org/download/release/v$version/node-v$version-darwin-$architecture.tar.xz"
  effective="$(/usr/bin/curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --write-out '%{url_effective}' "$url" -o "$archive")" \
    || { /bin/rm -rf "$root"; return 1; }
  [ "$effective" = "$url" ] || { /bin/rm -rf "$root"; return 1; }
  exec 9< "$archive"
  [ -f /dev/fd/9 ] || { exec 9<&-; /bin/rm -rf "$root"; return 1; }
  actual="$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{print $1}')"
  [ "$actual" = "$expected" ] || { /bin/rm -rf "$root"; return 1; }
  [ "${EUID:-$(/usr/bin/id -u)}" -eq 0 ] || elevator=(/usr/bin/sudo)
  root_group="$(/usr/bin/id -gn 0)"; [ -n "$root_group" ] || { /bin/rm -rf "$root"; return 1; }
  target="/var/lib/forge-managed-node/v$version-$architecture-$expected"
  staging="${target}.next.$$"
  "${elevator[@]}" /usr/bin/install -d -o root -g "$root_group" -m 0755 /var/lib/forge-managed-node || { /bin/rm -rf "$root"; return 1; }
  if ! "${elevator[@]}" /usr/bin/test -d "$target"; then
    "${elevator[@]}" /usr/bin/install -d -o root -g "$root_group" -m 0700 "$staging" || { /bin/rm -rf "$root"; return 1; }
    receive_bounded_privileged_stream "$archive_bytes" "$staging/node.tar.xz" "${elevator[@]}" <&9 \
      || { exec 9<&-; "${elevator[@]}" /bin/rm -rf -- "$staging"; /bin/rm -rf "$root"; return 1; }
    exec 9<&-
    actual="$("${elevator[@]}" /usr/bin/shasum -a 256 "$staging/node.tar.xz" | /usr/bin/awk '{print $1}')"
    [ "$actual" = "$expected" ] || { "${elevator[@]}" /bin/rm -rf -- "$staging"; /bin/rm -rf "$root"; return 1; }
    "${elevator[@]}" /usr/bin/tar -xJf "$staging/node.tar.xz" -C "$staging" \
      || { "${elevator[@]}" /bin/rm -rf -- "$staging"; /bin/rm -rf "$root"; return 1; }
    node_path="$staging/node-v$version-darwin-$architecture/bin/node"
    "${elevator[@]}" /usr/bin/test -f "$node_path" && ! "${elevator[@]}" /usr/bin/test -L "$node_path" \
      || { "${elevator[@]}" /bin/rm -rf -- "$staging"; /bin/rm -rf "$root"; return 1; }
    installed_digest="$("${elevator[@]}" /usr/bin/shasum -a 256 "$node_path" | /usr/bin/awk '{print $1}')"
    [ "$installed_digest" = "$node_expected" ] || { "${elevator[@]}" /bin/rm -rf -- "$staging"; /bin/rm -rf "$root"; return 1; }
    "${elevator[@]}" /usr/bin/install -o root -g "$root_group" -m 0555 "$node_path" "$staging/node" \
      || { "${elevator[@]}" /bin/rm -rf -- "$staging"; /bin/rm -rf "$root"; return 1; }
    "${elevator[@]}" /bin/rm -rf -- "$staging/node.tar.xz" "$staging/node-v$version-darwin-$architecture"
    "${elevator[@]}" /bin/chmod 0755 "$staging"
    "${elevator[@]}" /bin/mv "$staging" "$target" \
      || { "${elevator[@]}" /bin/rm -rf -- "$staging"; /bin/rm -rf "$root"; return 1; }
  fi
  { exec 9<&-; } 2>/dev/null || true
  installed_digest="$("${elevator[@]}" /usr/bin/shasum -a 256 "$target/node" | /usr/bin/awk '{print $1}')"
  [ "$installed_digest" = "$node_expected" ] && trusted_darwin_candidate "$target/node" \
    || { "${elevator[@]}" /bin/rm -rf -- "$target"; /bin/rm -rf "$root"; return 1; }
  /bin/rm -rf "$root"
  printf '%s\n' "$target/node"
}

trusted_darwin_candidate() {
  local candidate="$1" current owner mode physical_parent
  [ "$OS_NAME" = Darwin ] || return 1
  [ -x "$candidate" ] && [ -f "$candidate" ] && [ ! -L "$candidate" ] || return 1
  physical_parent="$(cd -P "${candidate%/*}" 2>/dev/null && pwd -P)" || return 1
  [ "$physical_parent/${candidate##*/}" = "$candidate" ] || return 1
  current="$candidate"
  while :; do
    owner="$(/usr/bin/stat -f '%Su' "$current" 2>/dev/null || true)"
    mode="$(/usr/bin/stat -f '%Lp' "$current" 2>/dev/null || true)"
    [ "$owner" = root ] && [ -n "$mode" ] && [ $((8#$mode & 022)) -eq 0 ] || return 1
    [ "$current" = / ] && return 0
    current="${current%/*}"
    [ -n "$current" ] || current=/
  done
}

trusted_linux_path_chain() {
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

canonicalize_trusted_linux_candidate() {
  /usr/bin/readlink -f "$1" 2>/dev/null
}

trusted_linux_candidate() {
  local candidate="$1" canonical
  [ -x "$candidate" ] || return 1
  trusted_linux_path_chain "$candidate" || return 1
  canonical="$(canonicalize_trusted_linux_candidate "$candidate")" || return 1
  [ -n "$canonical" ] && [ -f "$canonical" ] || return 1
  trusted_linux_path_chain "$canonical" || return 1
  printf '%s\n' "$canonical"
}

trusted_linux_tool() {
  local tool="$1" candidate version
  # Ubuntu's /usr/bin/psql is a pg_wrapper symlink. Executing its canonical
  # target loses argv[0]=psql, so prefer the versioned PostgreSQL 16+ binary.
  if [ "$tool" = psql ]; then
    for version in 18 17 16; do
      for candidate in "/usr/lib/postgresql/$version/bin/psql" "/usr/pgsql-$version/bin/psql"; do
        trusted_linux_candidate "$candidate" && return 0
      done
    done
  fi
  for candidate in "/usr/local/sbin/$tool" "/usr/local/bin/$tool" "/usr/sbin/$tool" "/usr/bin/$tool" "/sbin/$tool" "/bin/$tool"; do
    trusted_linux_candidate "$candidate" && return 0
  done
  return 1
}

prepare_trusted_linux_migration_toolchain() {
  local tool directory path_result=""
  [ "$OS_NAME" = Linux ] || die "Elevated managed local migrations are only supported on Linux."
  MANAGED_LOCAL_BASH="$(trusted_linux_tool bash)" || die "Could not find a root-owned non-writable bash for elevated managed migrations."
  MANAGED_LOCAL_NODE="$(trusted_linux_tool node)" || die "Could not find a root-owned non-writable node for elevated managed migrations."
  MANAGED_LOCAL_NPM="$(trusted_linux_tool npm)" || die "Could not find a root-owned non-writable npm for elevated managed migrations."
  MANAGED_LOCAL_NPX="$(trusted_linux_tool npx)" || die "Could not find a root-owned non-writable npx for elevated managed migrations."
  for tool in "$MANAGED_LOCAL_NODE" "$MANAGED_LOCAL_NPM" "$MANAGED_LOCAL_NPX" "$MANAGED_LOCAL_BASH"; do
    directory="${tool%/*}"
    case ":$path_result:" in
      *":$directory:"*) ;;
      *) path_result="${path_result:+$path_result:}$directory" ;;
    esac
  done
  MANAGED_LOCAL_PATH="$path_result"
}

run_managed_local_migration_as_runuser() {
  local description="$1" stage="$2"
  local controlled_path runuser_bin
  prepare_trusted_linux_migration_toolchain
  controlled_path="$MANAGED_LOCAL_PATH"
  runuser_bin="$(trusted_linux_tool runuser)" || die "Could not find a root-owned non-writable runuser for elevated managed migrations."

  # Historical non-controller stages retain their narrow legacy wrapper. The
  # controller has a separate env-empty dispatch above and never enters here.
  (
    local name
    for name in $(compgen -e); do
      case "$name" in
        DATABASE_URL|FORGE_DATABASE_ADMIN_URL|PGHOST|PGPORT|PGUSER|FORGE_WORKSPACE_ROOT|FORGE_ENV_FILE|FORGE_SUPPRESS_MIGRATION_NOTICES|PATH) ;;
        *) unset "$name" ;;
      esac
    done
    PATH="$controlled_path"
    export PATH
    run "$description" "$runuser_bin" -u postgres --preserve-environment -- "$MANAGED_LOCAL_BASH" -c 'cd "$1"; case "$2" in
      release) npm run protocol:bootstrap-epic-172-release-roles ;;
      migrate-0025) npx tsx scripts/ci/migrate-through-0025.ts ;;
      s3) npm run protocol:bootstrap-epic-172-s3-release-owner ;;
      migrate-0026) npx tsx scripts/ci/migrate-through-0026.ts ;;
      legacy-repair) npm run protocol:repair-epic-172-legacy-release ;;
      s4) npm run protocol:bootstrap-epic-172-s4-roles ;;
      migrate-0027) npx tsx scripts/ci/migrate-through-0027.ts ;;
      s5) bash scripts/ci/apply-epic-172-s5-recovery-migration.sh ;;
      registry) bash scripts/ci/apply-verification-goal-registry-migration.sh ;;
      runtime) bash scripts/ci/apply-vnext-phase0-a1-runtime-foundation.sh ;;
      latest) npm run db:migrate ;;
      *) exit 64 ;;
    esac' _ "$REPO_ROOT/web" "$stage"
  )
}

run_managed_local_migration_as_sudo() {
  local description="$1" stage="$2"
  local sudo_bin
  prepare_trusted_linux_migration_toolchain
  sudo_bin="$(trusted_linux_tool sudo)" || die "Could not find a root-owned non-writable sudo for elevated managed migrations."
  (
    PATH="$MANAGED_LOCAL_PATH"
    export PATH
    "$sudo_bin" -n -u postgres --preserve-env=DATABASE_URL,FORGE_DATABASE_ADMIN_URL,PGHOST,PGPORT,PGUSER,FORGE_WORKSPACE_ROOT,FORGE_ENV_FILE,FORGE_SUPPRESS_MIGRATION_NOTICES,PATH "$MANAGED_LOCAL_BASH" -c 'cd "$1"; case "$2" in
      release) npm run protocol:bootstrap-epic-172-release-roles ;;
      migrate-0025) npx tsx scripts/ci/migrate-through-0025.ts ;;
      s3) npm run protocol:bootstrap-epic-172-s3-release-owner ;;
      migrate-0026) npx tsx scripts/ci/migrate-through-0026.ts ;;
      legacy-repair) npm run protocol:repair-epic-172-legacy-release ;;
      s4) npm run protocol:bootstrap-epic-172-s4-roles ;;
      migrate-0027) npx tsx scripts/ci/migrate-through-0027.ts ;;
      s5) bash scripts/ci/apply-epic-172-s5-recovery-migration.sh ;;
      registry) bash scripts/ci/apply-verification-goal-registry-migration.sh ;;
      runtime) bash scripts/ci/apply-vnext-phase0-a1-runtime-foundation.sh ;;
      latest) npm run db:migrate ;;
      *) exit 64 ;;
    esac' _ "$REPO_ROOT/web" "$stage"
  )
}

run_managed_local_migrations() {
  step "Applying managed local database migrations"
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Run the shared managed migration controller once; it owns quiescence, historical bootstraps, protected handoffs, cleanup, and reconnect."
    return 0
  fi

  # Package and verify the finite privileged helper before opening any peer
  # administrator connection or loading migration credentials.
  if [ "${FORGE_INSTALL_TEST_HOOK:-}" != managed-local-migrations ]; then
    install_managed_migration_helper
  fi
  resolve_managed_local_admin || die "Could not establish passwordless local PostgreSQL administrator access for managed migrations. Use a native local PostgreSQL peer login, or run the documented operator migration procedure for a custom database."

  [ -n "$(env_value DATABASE_URL)" ] || die "Managed local migrations require DATABASE_URL in the local Forge environment file."

  run_managed_local_migration_sequence
}

run_managed_local_migration_sequence() {
  run_managed_local_migration_stage "Run the shared managed database migration controller" controller || die "Managed local migration controller failed; application reconnect remains gated until cleanup and ACL restoration succeed."
}

run_doctor() {
  step "Running the doctor"
  run "npm run doctor" bash -c 'cd "$1" && FORGE_WORKSPACE_ROOT="$2" FORGE_ENV_FILE="$3" npm run doctor' _ "$REPO_ROOT/web" "$WORKSPACE_ROOT" "$ENV_FILE"
}

path_contains_dir() {
  local needle="$1" dir
  local IFS=:
  for dir in $PATH; do
    [ "$dir" = "$needle" ] && return 0
  done
  return 1
}

canonical_symlink_target() {
  local link_path="$1" raw_target target_dir target_name
  raw_target="$(readlink "$link_path")"
  case "$raw_target" in
    /*) ;;
    *) raw_target="$(dirname "$link_path")/$raw_target" ;;
  esac

  target_dir="$(cd -P "$(dirname "$raw_target")" 2>/dev/null && pwd)" || return 1
  target_name="$(basename "$raw_target")"
  printf '%s/%s\n' "$target_dir" "$target_name"
}

preferred_cli_link_dir() {
  local configured="${FORGE_CLI_LINK_DIR:-}"
  if [ -n "$configured" ]; then
    printf '%s\n' "$configured"
    return 0
  fi

  local dir
  local IFS=:
  for dir in $PATH; do
    case "$dir" in
      "$HOME/.local/bin"|"$HOME/bin"|/opt/homebrew/bin|/usr/local/bin)
        if [ -d "$dir" ] && [ -w "$dir" ]; then
          printf '%s\n' "$dir"
          return 0
        fi
        ;;
    esac
  done

  printf '%s\n' "$HOME/.local/bin"
}

install_cli_entrypoint() {
  step "Installing Forge CLI entrypoint"

  local launcher link_dir link_path existing_target
  launcher="$REPO_ROOT/bin/forge"
  link_dir="$(preferred_cli_link_dir)"
  link_path="$link_dir/forge"

  if [ ! -f "$launcher" ]; then
    warn "Skipped CLI entrypoint because $launcher is missing."
    return 0
  fi

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Link $link_path -> $launcher"
    return 0
  fi

  chmod +x "$launcher" 2>/dev/null || true
  mkdir -p "$link_dir"

  if [ -e "$link_path" ] || [ -L "$link_path" ]; then
    if [ -L "$link_path" ]; then
      existing_target="$(canonical_symlink_target "$link_path")" || existing_target=""
      if [ "$existing_target" = "$launcher" ]; then
        info "Forge CLI already linked at $link_path."
        record_manifest "cli_link" "$link_path"
        return 0
      fi
    fi
    warn "Skipped CLI entrypoint because $link_path already exists."
    warn "Run $launcher directly, or set FORGE_CLI_LINK_DIR to another PATH directory."
    return 0
  fi

  ln -s "$launcher" "$link_path"
  record_manifest "cli_link" "$link_path"
  info "Linked $link_path -> $launcher"

  if ! path_contains_dir "$link_dir"; then
    warn "$link_dir is not on PATH. Add it to your shell profile to run 'forge' globally."
  fi
}

resolve_service_mode() {
  local installed_mode
  if [ "$SERVICE_MODE" = "auto" ]; then
    installed_mode="$(last_install_manifest_value service_mode 2>/dev/null || true)"
    case "$installed_mode" in
      native|docker) SERVICE_MODE="$installed_mode" ;;
      *) SERVICE_MODE="native" ;;
    esac
  fi
}

last_install_manifest_value() {
  local key="$1" line value=''
  [ -f "$INSTALL_MANIFEST" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key"=*) value="${line#*=}" ;;
    esac
  done < "$INSTALL_MANIFEST"
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

commit_service_mode() {
  [ "$DRY_RUN" = 1 ] && return 0
  [ "$INSTALL_LOCK_HELD" = 1 ] \
    || die "Refusing to record service mode without the Forge install lock."
  # This is the installed-state commit point: the selected service mode has
  # completed its controlled startup and attestation/provisioning boundary.
  record_current_manifest_value "service_mode" "$SERVICE_MODE"
}

start_attest_and_commit_service_mode() {
  if [ "$SERVICE_MODE" = "docker" ]; then
    start_docker_services || return
    commit_service_mode
  else
    install_native_services || return
    start_native_services || return
    # A generic localhost listener is not an installed-mode attestation. The
    # controlled native administrator path must provision the local database
    # successfully before the manifest authorizes future native repair.
    provision_database || return
    commit_service_mode
  fi
}

print_preflight_summary() {
  step "Preflight summary"
  info "Repository: $REPO_ROOT"
  info "Workspace root: $WORKSPACE_ROOT"
  info "Environment file: $ENV_FILE"
  info "Install log: $INSTALL_LOG"
  info "Install manifest: $INSTALL_MANIFEST"
  info "Prompt upgrade mode: $PROMPT_UPGRADE_MODE"
  info "Operating system: $OS_NAME"
  info "Package manager: $PACKAGE_MANAGER"
  info "Service mode: $SERVICE_MODE"
  info "Local AI model: $([ "$SKIP_OLLAMA" = "1" ] && printf 'skip' || printf '%s' "$ZERO_CONFIG_MODEL")"

  info "Current tool status:"
  command_status "Node.js" node || true
  command_status "npm" npm || true
  command_status "GitHub CLI" gh || true
  if [ "$SERVICE_MODE" = "docker" ]; then
    command_status "Docker" docker || true
  else
    command_status "PostgreSQL client" psql || true
    command_status "Redis CLI" redis-cli || true
  fi
  if [ "$SKIP_OLLAMA" != "1" ]; then
    command_status "Ollama" ollama || true
  fi

  if [ "$CHECK_ONLY" = "1" ]; then
    info "--check is active. No files, services, packages, or databases will be changed."
  elif [ "$DRY_RUN" = "1" ] && [ "$UPGRADE_MODE" = "1" ]; then
    info "--upgrade --dry-run is active. The script will preview the lightweight upgrade path without changing this machine."
  elif [ "$DRY_RUN" = "1" ]; then
    info "--dry-run is active. The script will preview work without changing this machine."
  elif [ "$UPGRADE_MODE" = "1" ]; then
    info "--upgrade is active. The installer will skip package-manager and Ollama installs, and only sync npm dependencies, apply database migrations, reseed agents, and run the doctor."
  else
    info "The installer will preserve existing settings, install missing dependencies, prepare services, and run the doctor."
  fi
}

run_check_only() {
  step "Readiness check"
  local failed=0
  local major

  major="$(node_major)"
  if [ "$major" -ge 22 ]; then
    info "ok      Node.js version: $(node -v)"
  else
    warn "Node.js 22 or newer is required."
    failed=1
  fi

  command_status "npm" npm || failed=1
  command_status "GitHub CLI" gh || failed=1

  if command -v gh >/dev/null 2>&1; then
    local gh_status=0
    command_succeeds_with_timeout 5 gh auth status || gh_status="$?"
    if [ "$gh_status" = "0" ]; then
      info "ok      GitHub CLI authentication"
    elif [ "$gh_status" = "124" ]; then
      warn "GitHub CLI authentication check timed out after 5s. Run: gh auth status"
      failed=1
    else
      warn "GitHub CLI is not authenticated. Run: gh auth login --scopes repo,workflow"
      failed=1
    fi
  fi

  if [ "$SERVICE_MODE" = "docker" ]; then
    command_status "Docker" docker || failed=1
    if command -v docker >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
      warn "Docker is installed but not running."
      failed=1
    fi
  else
    command_status "PostgreSQL readiness tool" pg_isready || failed=1
    command_status "Redis CLI" redis-cli || warn "Redis readiness will fall back to npm run doctor after install."
  fi

  if [ -f "$ENV_FILE" ]; then
    info "ok      Environment file exists: $ENV_FILE"
  else
    warn "Environment file is missing. Run bash scripts/install.sh to create it."
    failed=1
  fi

  if [ -d "$REPO_ROOT/web/node_modules" ]; then
    info "ok      web/node_modules exists"
  else
    warn "web/node_modules is missing. Run bash scripts/install.sh to install web dependencies."
    failed=1
  fi

  if [ "$failed" = "0" ]; then
    info "Forge looks ready. Run cd web && npm run doctor for runtime connectivity checks."
  else
    warn "Forge is not fully ready yet. The installer can fix most missing local dependencies."
  fi

  return "$failed"
}

print_summary() {
  step "Install complete"
  cat <<EOF

  Forge is installed for $OS_NAME using service mode: $SERVICE_MODE.

  Start the app:

    forge

  Then open http://localhost:3000 and create the first account.
  For password-only first sign-in, set FORGE_PASSKEYS_ENABLED=0 in $ENV_FILE before
  creating that account.
  The web app starts the task worker automatically. Set FORGE_EMBED_WORKER=0
  and run "cd web && npm run worker" separately if you want split processes.
  The first account creates a password and, when enabled, a passkey.

  Recovery:
    - Upgrade after pulling changes with: forge upgrade
    - Check readiness any time with: bash scripts/install.sh --check
    - If setup was interrupted or failed, re-run: bash scripts/install.sh
    - If you cannot sign in, reset the local account password with: forge reset-credentials
    - Detailed install log: $INSTALL_LOG

  For repository tooling, confirm GitHub CLI access with:

    gh auth status
EOF

  if [ "$SKIP_OLLAMA" != "1" ]; then
    cat <<EOF

  Local AI is ready with '$ZERO_CONFIG_MODEL'. You can also add cloud providers
  later from the Providers page.
EOF
  else
    cat <<EOF

  No local AI model was configured. Add a provider from the Providers page.
EOF
  fi

  if [ -n "$PG_BIN" ]; then
    cat <<EOF

  Tip: to use psql yourself, add this to your shell profile:
    export PATH="$PG_BIN:\$PATH"
EOF
  fi
}

validate_repo_layout() {
  [ -f "$REPO_ROOT/web/package.json" ] || die "Could not find web/package.json. Run the installer from the Forge repository checkout."
  [ -f "$REPO_ROOT/web/drizzle.config.ts" ] || die "Could not find web/drizzle.config.ts. The checkout looks incomplete."
  [ -f "$REPO_ROOT/docker-compose.yml" ] || die "Could not find docker-compose.yml. The checkout looks incomplete."
}

acquire_install_lock() {
  [ "$DRY_RUN" = "1" ] && return 0
  ensure_install_state
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    INSTALL_LOCK_HELD=1
    return 0
  fi

  die "Another Forge install appears to be running. Remove $LOCK_DIR only if you are sure it is stale."
}

if [ "${FORGE_INSTALL_LIBRARY:-0}" = "1" ] && [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

# Internal seam for the focused installer regression test. It intentionally
# bypasses all setup work and invokes only the native-service function.
if [ "${FORGE_INSTALL_TEST_HOOK:-}" = "start-native-services" ]; then
  PACKAGE_MANAGER="${FORGE_INSTALL_TEST_PACKAGE_MANAGER:-brew}"
  PG_FORMULA="${FORGE_INSTALL_TEST_PG_FORMULA:-postgresql@16}"
  start_native_services
  exit 0
fi

if [ "${FORGE_INSTALL_TEST_HOOK:-}" = "managed-local-migrations" ]; then
  SERVICE_MODE="${FORGE_INSTALL_TEST_SERVICE_MODE:-native}"
  case "${FORGE_INSTALL_TEST_ADMIN_MODE:-current}" in
    current)
      MANAGED_LOCAL_ADMIN_RESOLUTION=resolved
      MANAGED_LOCAL_ADMIN_MODE=current
      MANAGED_LOCAL_ADMIN_USER="$(/usr/bin/id -un)"
      MANAGED_LOCAL_ADMIN_SOCKET="${FORGE_INSTALL_TEST_PSQL_SOCKET:-/tmp}"
      MANAGED_LOCAL_ADMIN_PORT="${FORGE_INSTALL_TEST_PSQL_PORT:-5432}"
      ;;
    unavailable)
      MANAGED_LOCAL_ADMIN_RESOLUTION=resolved
      MANAGED_LOCAL_ADMIN_MODE=""
      ;;
    *) die "Installer migration test hook supports only current-user administration." ;;
  esac
  printf 'admin:%s\n' "${FORGE_INSTALL_TEST_ADMIN_MODE:-current}" >> "${FORGE_INSTALL_TEST_STAGE_LOG:?}"
  run_managed_local_migrations
  exit 0
fi

if [ "${FORGE_INSTALL_TEST_HOOK:-}" = "managed-local-migrations-enabled" ]; then
  SERVICE_MODE="${FORGE_INSTALL_TEST_SERVICE_MODE:-native}"
  if managed_local_migrations_enabled; then
    printf 'managed-local-migrations-enabled\n'
  else
    printf 'managed-local-migrations-bypassed\n'
  fi
  exit 0
fi

bold "Forge installer"
info "Repo: $REPO_ROOT"
info "OS: $OS_NAME"
info "Install record: $INSTALL_MANIFEST"

validate_repo_layout
detect_package_manager
resolve_service_mode
print_preflight_summary
if [ "$CHECK_ONLY" = "1" ]; then
  if run_check_only; then
    exit 0
  fi
  exit 1
fi
setup_sudo
ensure_install_state
acquire_install_lock
record_manifest "os" "$OS_NAME"
record_manifest "package_manager" "$PACKAGE_MANAGER"

if [ "$PACKAGE_MANAGER" = "brew" ]; then
  install_homebrew_if_needed
fi

install_base_dependencies

DB_PASSWORD="$(native_forge_database_password "$(initial_env_value DATABASE_URL)" || true)"
DB_PASSWORD="${DB_PASSWORD:-$(initial_env_value POSTGRES_PASSWORD)}"
if placeholder_value "$DB_PASSWORD"; then
  DB_PASSWORD=""
fi
DB_PASSWORD="${DB_PASSWORD:-$(random_hex 16)}"
APP_DATABASE_PASSWORD="$(initial_env_value FORGE_APP_DATABASE_PASSWORD)"
if placeholder_value "$APP_DATABASE_PASSWORD"; then
  APP_DATABASE_PASSWORD=""
fi
APP_DATABASE_PASSWORD="${APP_DATABASE_PASSWORD:-$(random_hex 16)}"
RUNTIME_API_DATABASE_PASSWORD="$(initial_env_value FORGE_RUNTIME_API_DATABASE_PASSWORD)"
if placeholder_value "$RUNTIME_API_DATABASE_PASSWORD"; then
  RUNTIME_API_DATABASE_PASSWORD=""
fi
RUNTIME_API_DATABASE_PASSWORD="${RUNTIME_API_DATABASE_PASSWORD:-$(random_hex 16)}"
SESSION_SECRET="$(initial_env_value SESSION_SECRET)"
if placeholder_value "$SESSION_SECRET"; then
  SESSION_SECRET=""
fi
SESSION_SECRET="${SESSION_SECRET:-$(random_hex 32)}"

# Every generated credential crosses a different trust boundary. Extremely
# unlikely random collisions are still rejected rather than persisted.
while [ "$APP_DATABASE_PASSWORD" = "$DB_PASSWORD" ]; do APP_DATABASE_PASSWORD="$(random_hex 16)"; done
while [ "$RUNTIME_API_DATABASE_PASSWORD" = "$DB_PASSWORD" ] || [ "$RUNTIME_API_DATABASE_PASSWORD" = "$APP_DATABASE_PASSWORD" ]; do
  RUNTIME_API_DATABASE_PASSWORD="$(random_hex 16)"
done
while [ "$SESSION_SECRET" = "$DB_PASSWORD" ] || [ "$SESSION_SECRET" = "$APP_DATABASE_PASSWORD" ] || [ "$SESSION_SECRET" = "$RUNTIME_API_DATABASE_PASSWORD" ]; do
  SESSION_SECRET="$(random_hex 32)"
done

write_env_file
install_cli_entrypoint

start_attest_and_commit_service_mode

prepare_web_app
install_ollama_if_needed
seed_local_ai_if_ready
run_doctor
print_summary
