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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${FORGE_ENV_FILE:-$REPO_ROOT/.env}"
INSTALL_STATE_DIR="${FORGE_INSTALL_STATE_DIR:-$REPO_ROOT/.forge}"
INSTALL_MANIFEST="$INSTALL_STATE_DIR/install-manifest"
INSTALL_LOG="$INSTALL_STATE_DIR/install.log"

OS_NAME="${FORGE_OS_OVERRIDE:-$(uname -s)}"
DRY_RUN="${FORGE_DRY_RUN:-0}"
CHECK_ONLY="${FORGE_CHECK_ONLY:-0}"
YES="${FORGE_ASSUME_YES:-0}"
SKIP_OLLAMA="${FORGE_SKIP_OLLAMA:-0}"
UPGRADE_MODE="${FORGE_UPGRADE:-0}"
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
LOCK_DIR="$INSTALL_STATE_DIR/install.lock"
TEMP_FILES=""

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
  --yes, -y              Assume yes for package manager prompts where supported.
  --check                Inspect local readiness without changing the machine.
  --dry-run              Print the planned work without changing the machine.
  --help, -h             Show this help.

Environment:
  FORGE_SKIP_OLLAMA=1
  FORGE_ZERO_CONFIG_MODEL=qwen2.5-coder:7b
  FORGE_SERVICE_MODE=auto|native|docker
  FORGE_CHECK_ONLY=1
  FORGE_DRY_RUN=1
  FORGE_UPGRADE=1
  FORGE_OS_OVERRIDE=Darwin|Linux              # dry-run/testing helper
  FORGE_PACKAGE_MANAGER_OVERRIDE=apt|brew     # dry-run/testing helper
  FORGE_ENV_FILE=/path/to/.env                # testing/advanced helper
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
  local file
  for file in $TEMP_FILES; do
    [ -n "$file" ] && rm -f "$file" 2>/dev/null || true
  done

  if [ "$DRY_RUN" != "1" ] && [ -d "$LOCK_DIR" ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

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

case "$SERVICE_MODE" in
  auto|native|docker) ;;
  *) die "Unsupported service mode: $SERVICE_MODE" ;;
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
  "$@" >> "$INSTALL_LOG" 2>&1
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
  chmod 700 "$INSTALL_STATE_DIR" 2>/dev/null || true
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

placeholder_value() {
  case "${1:-}" in
    ''|change_me|change-me|password|your_password|paste_the_generated_value_here|change_me_generate_with_openssl_rand_hex_32)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

placeholder_database_url() {
  case "${1:-}" in
    *'://forge:change_me@localhost:5432/forge'|*'://forge:password@localhost:5432/forge')
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
    info "[dry-run] Set $key in .env"
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
  if [ "$major" -ge 20 ]; then
    info "Node $(node -v) is ready."
    return 0
  fi

  if [ "$PACKAGE_MANAGER" = "brew" ]; then
    install_packages node
  elif [ "$PACKAGE_MANAGER" = "apt" ]; then
    install_packages curl ca-certificates gnupg
    info "Installing Node.js 22 from NodeSource because Forge needs Node 20 or newer."
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
  [ "$major" -ge 20 ] || die "Node $(node -v 2>/dev/null || echo missing) is too old. Install Node 20+ and re-run."
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
    run_quiet "Start PostgreSQL" brew services start "$PG_FORMULA"
    run_quiet "Start Redis" brew services start redis
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
    info "[dry-run] docker compose up -d --wait postgres redis"
    return 0
  fi

  command -v docker >/dev/null 2>&1 || die "Docker is required for --service-mode docker."
  if ! docker info >/dev/null 2>&1; then
    die "Docker is installed but not running. Start Docker and re-run."
  fi

  local compose
  compose="$(compose_command)" || die "Docker Compose is required for --service-mode docker."
  (cd "$REPO_ROOT" && $compose up -d --wait postgres redis)
}

wait_for_postgres() {
  [ "$DRY_RUN" = "1" ] && return 0
  command -v pg_isready >/dev/null 2>&1 || die "pg_isready is missing. PostgreSQL client tools are required."

  info "Waiting for PostgreSQL on localhost:5432..."
  local attempt
  for attempt in $(seq 1 60); do
    if pg_isready -q -h localhost -p 5432 >/dev/null 2>&1; then
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
    if redis-cli -h localhost -p 6379 ping 2>/dev/null | grep -q PONG; then
      info "Redis is ready."
      return 0
    fi
    sleep 1
  done

  die "Redis did not become ready on localhost:6379."
}

psql_admin() {
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] psql admin $*"
    return 0
  fi

  if psql -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    psql -d postgres "$@"
    return 0
  fi

  if id postgres >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1; then
      sudo -u postgres psql -d postgres "$@"
      return 0
    fi
    if command -v runuser >/dev/null 2>&1; then
      runuser -u postgres -- psql -d postgres "$@"
      return 0
    fi
  fi

  die "Could not connect to PostgreSQL as an admin user."
}

should_manage_local_db() {
  local existing_database_url
  existing_database_url="$(env_value DATABASE_URL)"
  if [ -z "$existing_database_url" ]; then
    MANAGE_LOCAL_DB=1
    return 0
  fi

  case "$existing_database_url" in
    postgresql://forge:*@localhost:5432/forge|postgres://forge:*@localhost:5432/forge)
      MANAGE_LOCAL_DB=1
      ;;
    *)
      MANAGE_LOCAL_DB=0
      warn "Existing DATABASE_URL is custom. The installer will not create or alter a local forge database."
      ;;
  esac
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

  local db_password_escaped role_exists db_exists
  db_password_escaped="$(sql_escape_literal "$DB_PASSWORD")"

  role_exists="$(psql_admin -tAc "SELECT 1 FROM pg_roles WHERE rolname='forge'" | tr -d '[:space:]' || true)"
  if [ "$role_exists" = "1" ]; then
    run_quiet "Sync forge role password" psql_admin -c "ALTER ROLE forge PASSWORD '$db_password_escaped';"
    info "Role forge exists; password synced."
  else
    run_quiet "Create forge role" psql_admin -c "CREATE ROLE forge LOGIN PASSWORD '$db_password_escaped';"
    record_manifest "postgres_role" "forge"
    info "Created role forge."
  fi

  db_exists="$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname='forge'" | tr -d '[:space:]' || true)"
  if [ "$db_exists" = "1" ]; then
    info "Database forge already exists."
  else
    run_quiet "Create forge database" psql_admin -c "CREATE DATABASE forge OWNER forge;"
    record_manifest "postgres_database" "forge"
    info "Created database forge."
  fi
}

ensure_env_line() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Append $key to .env"
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
    ensure_env_line "$key" "$value"
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
    info ".env already exists; preserving existing values and appending missing defaults."
  else
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] Create $ENV_FILE"
    else
      {
        printf '# Generated by scripts/install.sh. Provider API keys are entered in the Forge web UI.\n'
      } > "$ENV_FILE"
      chmod 600 "$ENV_FILE"
    fi
  fi

  ensure_env_value POSTGRES_USER forge
  ensure_env_value POSTGRES_PASSWORD "$DB_PASSWORD" placeholder
  ensure_env_value POSTGRES_DB forge
  ensure_env_value DATABASE_URL "postgresql://forge:${DB_PASSWORD}@localhost:5432/forge" database_url
  ensure_env_value REDIS_URL "redis://localhost:6379/0"
  ensure_env_value NEXT_PUBLIC_APP_URL "http://localhost:3000"
  ensure_env_value NEXT_TELEMETRY_DISABLED "1"
  ensure_env_value FORGE_EMBED_WORKER "1"
  ensure_env_value FORGE_AGENT_WEB_SEARCH "1"
  ensure_env_value FORGE_WORKER_CLAIM_TIMEOUT_SECONDS "5"
  ensure_env_value FORGE_PASSKEYS_ENABLED "1"
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
    ensure_install_state
    nohup ollama serve > "$INSTALL_STATE_DIR/ollama.log" 2>&1 &
    record_manifest "ollama_pid" "$!"
    info "Started Ollama with nohup. Log: $INSTALL_STATE_DIR/ollama.log"
  fi
}

start_ollama() {
  [ "$SKIP_OLLAMA" = "1" ] && return 0

  step "Starting Ollama"
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
    if curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1; then
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
  run "npm run db:migrate" bash -c 'cd "$1" && FORGE_SUPPRESS_MIGRATION_NOTICES=1 npm run db:migrate --silent' _ "$REPO_ROOT/web"
  run "npm run db:seed-agents" bash -c 'cd "$1" && npm run db:seed-agents' _ "$REPO_ROOT/web"
}

run_doctor() {
  step "Running the doctor"
  run "npm run doctor" bash -c 'cd "$1" && npm run doctor' _ "$REPO_ROOT/web"
}

resolve_service_mode() {
  if [ "$SERVICE_MODE" = "auto" ]; then
    SERVICE_MODE="native"
  fi
  record_manifest "service_mode" "$SERVICE_MODE"
}

print_preflight_summary() {
  step "Preflight summary"
  info "Repository: $REPO_ROOT"
  info "Environment file: $ENV_FILE"
  info "Install log: $INSTALL_LOG"
  info "Install manifest: $INSTALL_MANIFEST"
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
  if [ "$major" -ge 20 ]; then
    info "ok      Node.js version: $(node -v)"
  else
    warn "Node.js 20 or newer is required."
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

    cd web && npm run dev

  Then open http://localhost:3000 and create the first account.
  For password-only first sign-in, set FORGE_PASSKEYS_ENABLED=0 in .env before
  creating that account.
  The web app starts the task worker automatically. Set FORGE_EMBED_WORKER=0
  and run "cd web && npm run worker" separately if you want split processes.
  The first account creates a password and, when enabled, a passkey.

  Recovery:
    - Check readiness any time with: bash scripts/install.sh --check
    - If setup was interrupted or failed, re-run: bash scripts/install.sh
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
    return 0
  fi

  die "Another Forge install appears to be running. Remove $LOCK_DIR only if you are sure it is stale."
}

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

DB_PASSWORD="$(env_value DATABASE_URL | sed -n 's#^postgres\(ql\)\?://forge:\(.*\)@localhost:5432/forge.*#\2#p' | head -1)"
DB_PASSWORD="${DB_PASSWORD:-$(env_value POSTGRES_PASSWORD)}"
if placeholder_value "$DB_PASSWORD"; then
  DB_PASSWORD=""
fi
DB_PASSWORD="${DB_PASSWORD:-$(random_hex 16)}"
SESSION_SECRET="$(env_value SESSION_SECRET)"
if placeholder_value "$SESSION_SECRET"; then
  SESSION_SECRET=""
fi
SESSION_SECRET="${SESSION_SECRET:-$(random_hex 32)}"

write_env_file

if [ "$SERVICE_MODE" = "docker" ]; then
  start_docker_services
else
  install_native_services
  start_native_services
  provision_database
fi

prepare_web_app
install_ollama_if_needed
seed_local_ai_if_ready
run_doctor
print_summary
