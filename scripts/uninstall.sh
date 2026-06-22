#!/usr/bin/env bash
#
# Forge uninstall helper.
#
# Removes Forge-local build artifacts, stops local services, and removes only
# packages that scripts/install.sh recorded as newly installed for Forge. It
# supports macOS and Linux package managers used by the installer.
#
# Usage:
#   bash scripts/uninstall.sh
#   bash scripts/uninstall.sh --remove-data
#   bash scripts/uninstall.sh --keep-data --yes
#   bash scripts/uninstall.sh --dry-run
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_STATE_DIR="$REPO_ROOT/.forge"
INSTALL_MANIFEST="$INSTALL_STATE_DIR/install-manifest"
PROJECT_PATHS_FILE="$INSTALL_STATE_DIR/project-paths"

YES=0
DRY_RUN=0
KEEP_DATA=""
REMOVE_PROJECTS=""
OS_NAME="${FORGE_OS_OVERRIDE:-$(uname -s)}"
PACKAGE_MANAGER="${FORGE_PACKAGE_MANAGER_OVERRIDE:-}"
SUDO=()

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '\033[1;33m    warning:\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

usage() {
  cat <<'EOF'
Forge uninstall helper for macOS and Linux.

Options:
  --keep-data       Keep .env, database data, Redis data, and install state.
  --remove-data     Remove .env, Forge database/role when recorded, Docker volumes,
                    Redis data, recorded local models, and install state.
  --remove-projects Delete every local project folder Forge created (listed in
                    .forge/project-paths). This deletes your project files.
  --keep-projects   Never delete local project folders (the default).
  --yes             Do not prompt. Defaults to --keep-data and --keep-projects.
  --dry-run         Print what would happen without changing anything.
  --help            Show this help.

The script removes packages only when Forge's install manifest says the
installer added them. Packages that were already present are left alone.

Testing helpers:
  FORGE_OS_OVERRIDE=Darwin|Linux
  FORGE_PACKAGE_MANAGER_OVERRIDE=brew|apt|dnf|yum|zypper|pacman
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep-data)
      KEEP_DATA=1
      ;;
    --remove-data)
      KEEP_DATA=0
      ;;
    --remove-projects)
      REMOVE_PROJECTS=1
      ;;
    --keep-projects)
      REMOVE_PROJECTS=0
      ;;
    --yes|-y)
      YES=1
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

if [ -z "$KEEP_DATA" ]; then
  if [ "$YES" = "1" ] || [ ! -t 0 ]; then
    KEEP_DATA=1
  else
    bold "Forge uninstall"
    info "Settings and credentials include .env, database rows, Redis data, and local install state."
    printf "    Keep settings and credentials for a future reinstall? [Y/n] "
    read -r answer || answer=""
    case "$answer" in
      n|N|no|NO|No)
        KEEP_DATA=0
        ;;
      *)
        KEEP_DATA=1
        ;;
    esac
  fi
fi

project_paths() {
  if [ -f "$PROJECT_PATHS_FILE" ]; then
    grep -v '^[[:space:]]*$' "$PROJECT_PATHS_FILE" 2>/dev/null || true
  fi
}

# Read a key from the first .env file that defines it. The .env files still
# exist at this point because remove_env_files runs near the end of uninstall.
read_env_var() {
  local key="$1" file value
  for file in "$REPO_ROOT/.env" "$REPO_ROOT/.env.local" "$REPO_ROOT/web/.env" "$REPO_ROOT/web/.env.local"; do
    [ -f "$file" ] || continue
    value="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n1)" || true
    if [ -n "$value" ]; then
      value="${value#"${key}="}"
      value="${value%\"}"; value="${value#\"}"
      value="${value%\'}"; value="${value#\'}"
      printf '%s' "$value"
      return 0
    fi
  done
}

app_database_url() {
  read_env_var DATABASE_URL
}

# Local project folders recorded in the database. This catches projects created
# through the web UI, which the on-disk registry (.forge/project-paths) does not
# always record. Best-effort: silent when psql or the database is unavailable.
db_project_paths() {
  local url
  url="$(app_database_url)"
  [ -n "$url" ] || return 0
  command -v psql >/dev/null 2>&1 || return 0
  psql "$url" -tAc \
    "SELECT local_path FROM projects WHERE local_path IS NOT NULL AND local_path <> ''" \
    2>/dev/null | grep -v '^[[:space:]]*$' || true
}

# Union of folders from the on-disk registry and the database, de-duplicated
# while preserving order.
all_project_paths() {
  { project_paths; db_project_paths; } | grep -v '^[[:space:]]*$' | awk '!seen[$0]++'
}

resolve_remove_projects() {
  [ -n "$REMOVE_PROJECTS" ] && return 0

  if [ "$YES" = "1" ] || [ ! -t 0 ]; then
    REMOVE_PROJECTS=0
    return 0
  fi

  if [ -z "$(all_project_paths)" ]; then
    REMOVE_PROJECTS=0
    return 0
  fi

  bold "Forge local projects"
  info "Forge created these local project folders:"
  while IFS= read -r project_dir; do
    [ -n "$project_dir" ] && info "  - $project_dir"
  done < <(all_project_paths)
  printf "    Delete all of these project folders and their files? [y/N] "
  read -r answer || answer=""
  case "$answer" in
    y|Y|yes|YES|Yes) REMOVE_PROJECTS=1 ;;
    *) REMOVE_PROJECTS=0 ;;
  esac
}

remove_project_files() {
  [ "$REMOVE_PROJECTS" = "1" ] || return 0
  [ -n "$(all_project_paths)" ] || return 0

  step "Removing local project folders"
  while IFS= read -r project_dir; do
    [ -n "$project_dir" ] || continue
    if [ ! -e "$project_dir" ]; then
      info "Already gone: $project_dir"
      continue
    fi
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] Remove $project_dir"
    else
      rm -rf "$project_dir" && info "Removed $project_dir" || warn "Could not remove $project_dir"
    fi
  done < <(all_project_paths)

  if [ "$DRY_RUN" != "1" ]; then
    rm -f "$PROJECT_PATHS_FILE" 2>/dev/null || true
  fi
}

remove_path() {
  local path="$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] Remove $path"
    else
      rm -rf "$path"
      info "Removed $path"
    fi
  fi
}

manifest_values() {
  local key="$1"
  if [ -f "$INSTALL_MANIFEST" ]; then
    sed -n "s/^${key}=//p" "$INSTALL_MANIFEST"
  fi
}

manifest_has() {
  local key="$1"
  local value="$2"
  [ -f "$INSTALL_MANIFEST" ] && grep -Fqx "$key=$value" "$INSTALL_MANIFEST"
}

detect_package_manager() {
  if [ -n "$PACKAGE_MANAGER" ]; then
    case "$PACKAGE_MANAGER" in
      brew|apt|dnf|yum|zypper|pacman) return 0 ;;
      *) die "Unsupported package manager override: $PACKAGE_MANAGER" ;;
    esac
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
        PACKAGE_MANAGER=""
      fi
      ;;
    *)
      PACKAGE_MANAGER=""
      ;;
  esac
}

setup_privilege_command() {
  SUDO=()
  [ "$OS_NAME" = "Linux" ] || return 0
  [ "$(id -u)" -eq 0 ] && return 0
  if command -v sudo >/dev/null 2>&1; then
    SUDO=(sudo)
  fi
}

valid_package_name() {
  case "$1" in
    ''|*[!A-Za-z0-9+._:@-]*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
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

postgres_ready() {
  command -v pg_isready >/dev/null 2>&1 && pg_isready -q -h localhost -p 5432 >/dev/null 2>&1
}

remove_build_artifacts() {
  step "Removing local build artifacts"
  remove_path "$REPO_ROOT/web/node_modules"
  remove_path "$REPO_ROOT/web/.next"
  remove_path "$REPO_ROOT/web/playwright-report"
  remove_path "$REPO_ROOT/web/test-results"
  remove_path "$REPO_ROOT/web/coverage"
}

remove_env_files() {
  [ "$KEEP_DATA" = "0" ] || return 0

  step "Removing settings and credential files"
  remove_path "$REPO_ROOT/.env"
  remove_path "$REPO_ROOT/.env.local"
  remove_path "$REPO_ROOT/web/.env"
  remove_path "$REPO_ROOT/web/.env.local"
  remove_path "$REPO_ROOT/web/.env.development.local"
  remove_path "$REPO_ROOT/web/.env.production.local"
}

drop_recorded_postgres_data() {
  [ "$KEEP_DATA" = "0" ] || return 0

  if ! manifest_has "postgres_database" "forge" && ! manifest_has "postgres_role" "forge"; then
    return 0
  fi

  step "Removing recorded PostgreSQL database objects"
  if ! postgres_ready; then
    info "PostgreSQL is not reachable on localhost:5432, so database objects were left in place."
    return 0
  fi

  if manifest_has "postgres_database" "forge"; then
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] Drop database forge"
    else
      if psql -d postgres -c "DROP DATABASE IF EXISTS forge WITH (FORCE);" >/dev/null 2>&1; then
        info "Dropped database forge if it existed."
      else
        info "Database forge could not be dropped now, so it was left in place."
      fi
    fi
  fi

  if manifest_has "postgres_role" "forge"; then
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] Drop role forge"
    else
      if psql -d postgres -c "DROP ROLE IF EXISTS forge;" >/dev/null 2>&1; then
        info "Dropped role forge if it existed."
      else
        info "Role forge could not be dropped now, so it was left in place."
      fi
    fi
  fi
}

# Drop the Forge application database named in DATABASE_URL (default: forge),
# even when the installer did not record creating it (e.g. a reused database).
# This is what actually removes saved logins, projects, and task history on
# --remove-data. The recorded role/database cleanup still runs afterwards via
# drop_recorded_postgres_data, which uses the local maintenance connection.
drop_app_database() {
  [ "$KEEP_DATA" = "0" ] || return 0

  local url dbname admin_url
  url="$(app_database_url)"
  if [ -n "$url" ]; then
    dbname="${url##*/}"
    dbname="${dbname%%\?*}"
    admin_url="${url%/*}/postgres"
    if [ -n "$dbname" ]; then
      step "Removing the Forge application database"
      if [ "$DRY_RUN" = "1" ]; then
        info "[dry-run] Drop database $dbname (removes saved logins, projects, and history)"
      elif ! command -v psql >/dev/null 2>&1; then
        info "psql is not installed, so database $dbname was left in place. Saved logins remain."
      elif ! psql "$admin_url" -tAc 'SELECT 1' >/dev/null 2>&1; then
        info "PostgreSQL is not reachable, so the database was left in place. Saved logins and projects remain."
      elif psql "$admin_url" -c "DROP DATABASE IF EXISTS \"$dbname\" WITH (FORCE);" >/dev/null 2>&1; then
        info "Dropped database $dbname (removed saved logins, projects, and task history)."
      else
        info "Database $dbname could not be dropped now, so it was left in place."
      fi
    fi
  fi

  # Recorded role/database cleanup via the local maintenance connection.
  # Idempotent with the URL-based drop above.
  drop_recorded_postgres_data
}

stop_docker_services() {
  step "Stopping Docker Compose services"
  if ! command -v docker >/dev/null 2>&1; then
    info "Docker is not installed, so there are no Forge Docker services to stop."
    return 0
  fi

  if ! docker info >/dev/null 2>&1; then
    info "Docker is not running, so Docker services were skipped."
    return 0
  fi

  local compose
  if ! compose="$(compose_command)"; then
    info "Docker Compose is not available, so Docker services were skipped."
    return 0
  fi

  if [ "$KEEP_DATA" = "0" ]; then
    info "Stopping Forge containers and removing their Docker volumes."
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] $compose down --volumes --remove-orphans"
    else
      (cd "$REPO_ROOT" && $compose down --volumes --remove-orphans >/dev/null 2>&1) || true
    fi
  else
    info "Stopping Forge containers and keeping Docker volumes."
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] $compose down --remove-orphans"
    else
      (cd "$REPO_ROOT" && $compose down --remove-orphans >/dev/null 2>&1) || true
    fi
  fi
}

remove_recorded_ollama_models() {
  [ "$KEEP_DATA" = "0" ] || return 0

  if ! command -v ollama >/dev/null 2>&1; then
    return 0
  fi

  local found_model=0
  while IFS= read -r model; do
    [ -n "$model" ] || continue
    if [ "$found_model" = "0" ]; then
      step "Removing recorded local AI models"
    fi
    found_model=1
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] Remove Ollama model $model"
    else
      ollama rm "$model" >/dev/null 2>&1 || true
      info "Removed Ollama model $model if it existed."
    fi
  done < <(manifest_values "ollama_model")
}

package_installed() {
  local package="$1"
  case "$PACKAGE_MANAGER" in
    brew)
      brew list --formula "$package" >/dev/null 2>&1
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
    *)
      return 1
      ;;
  esac
}

package_removal_is_safe() {
  local package="$1"
  case "$PACKAGE_MANAGER" in
    apt)
      dpkg --remove --dry-run "$package" >/dev/null 2>&1
      ;;
    dnf|yum|zypper)
      rpm -e --test "$package" >/dev/null 2>&1
      ;;
    pacman|brew)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

remove_homebrew_packages() {
  if [ "$DRY_RUN" != "1" ] && ! command -v brew >/dev/null 2>&1; then
    info "Homebrew is not installed, so no Homebrew packages were removed."
    return 0
  fi

  manifest_values "brew_formula" | awk '{ lines[NR] = $0 } END { for (i = NR; i >= 1; i--) print lines[i] }' |
    while IFS= read -r formula; do
      [ -n "$formula" ] || continue
      if ! valid_package_name "$formula"; then
        info "Skipped an invalid Homebrew package name from the install manifest."
        continue
      fi
      [ "$formula" = "homebrew" ] && continue

      if [ "$DRY_RUN" = "1" ]; then
        info "[dry-run] Stop and uninstall $formula"
        continue
      fi

      if ! brew list --formula "$formula" >/dev/null 2>&1; then
        continue
      fi

      brew services stop "$formula" >/dev/null 2>&1 || true
      if brew uninstall "$formula" >/dev/null 2>&1; then
        info "Removed $formula"
      else
        info "Left $formula installed because Homebrew reports it is still needed."
      fi
    done

  return 0
}

remove_linux_package() {
  local package="$1"

  if ! valid_package_name "$package"; then
    info "Skipped an invalid Linux package name from the install manifest."
    return 0
  fi

  if [ "$DRY_RUN" = "1" ]; then
    case "$PACKAGE_MANAGER" in
      apt) info "[dry-run] apt-get remove -y $package" ;;
      dnf) info "[dry-run] dnf remove -y $package" ;;
      yum) info "[dry-run] yum remove -y $package" ;;
      zypper) info "[dry-run] zypper --non-interactive remove $package" ;;
      pacman) info "[dry-run] pacman -R --noconfirm $package" ;;
    esac
    return 0
  fi

  if ! package_installed "$package"; then
    return 0
  fi

  if [ "$(id -u)" -ne 0 ] && [ "${#SUDO[@]}" -eq 0 ]; then
    info "Left $package installed because sudo is not available."
    return 0
  fi

  if ! package_removal_is_safe "$package"; then
    info "Left $package installed because the package manager reports another package still needs it."
    return 0
  fi

  case "$PACKAGE_MANAGER" in
    apt)
      if "${SUDO[@]}" apt-get remove -y "$package" >/dev/null 2>&1; then
        info "Removed $package"
      else
        info "Left $package installed because apt could not remove it cleanly."
      fi
      ;;
    dnf)
      if "${SUDO[@]}" dnf remove -y "$package" >/dev/null 2>&1; then
        info "Removed $package"
      else
        info "Left $package installed because dnf could not remove it cleanly."
      fi
      ;;
    yum)
      if "${SUDO[@]}" yum remove -y "$package" >/dev/null 2>&1; then
        info "Removed $package"
      else
        info "Left $package installed because yum could not remove it cleanly."
      fi
      ;;
    zypper)
      if "${SUDO[@]}" zypper --non-interactive remove "$package" >/dev/null 2>&1; then
        info "Removed $package"
      else
        info "Left $package installed because zypper could not remove it cleanly."
      fi
      ;;
    pacman)
      if "${SUDO[@]}" pacman -R --noconfirm "$package" >/dev/null 2>&1; then
        info "Removed $package"
      else
        info "Left $package installed because pacman reports it is still needed."
      fi
      ;;
  esac
}

remove_linux_packages() {
  case "$PACKAGE_MANAGER" in
    apt|dnf|yum|zypper|pacman) ;;
    *)
      info "No supported Linux package manager was found, so Linux packages were left alone."
      return 0
      ;;
  esac

  manifest_values "linux_package" | awk '{ lines[NR] = $0 } END { for (i = NR; i >= 1; i--) print lines[i] }' |
    while IFS= read -r package; do
      [ -n "$package" ] || continue
      remove_linux_package "$package"
    done

  return 0
}

remove_nodesource_apt_repo() {
  [ "$PACKAGE_MANAGER" = "apt" ] || return 0
  manifest_has "apt_source" "nodesource_22" || return 0

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Remove NodeSource apt source files"
    return 0
  fi

  if [ "$(id -u)" -ne 0 ] && [ "${#SUDO[@]}" -eq 0 ]; then
    info "Left NodeSource apt source files in place because sudo is not available."
    return 0
  fi

  "${SUDO[@]}" rm -f \
    /etc/apt/sources.list.d/nodesource.list \
    /etc/apt/keyrings/nodesource.gpg \
    /usr/share/keyrings/nodesource.gpg >/dev/null 2>&1 || true
  "${SUDO[@]}" apt-get update >/dev/null 2>&1 || true
  info "Removed NodeSource apt source files if they existed."
}

remove_official_linux_ollama_install() {
  [ "$OS_NAME" = "Linux" ] || return 0
  manifest_has "linux_ollama_installer" "official" || return 0

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Stop Ollama service and remove official Linux installer files"
    return 0
  fi

  if [ "$(id -u)" -ne 0 ] && [ "${#SUDO[@]}" -eq 0 ]; then
    info "Left Ollama installer files in place because sudo is not available."
    return 0
  fi

  if command -v systemctl >/dev/null 2>&1; then
    "${SUDO[@]}" systemctl stop ollama >/dev/null 2>&1 || true
    "${SUDO[@]}" systemctl disable ollama >/dev/null 2>&1 || true
  fi
  "${SUDO[@]}" rm -f /etc/systemd/system/ollama.service /usr/local/bin/ollama >/dev/null 2>&1 || true
  if command -v systemctl >/dev/null 2>&1; then
    "${SUDO[@]}" systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  info "Removed official Ollama service and binary if they existed."
}

remove_recorded_packages() {
  step "Removing packages installed by Forge"

  if [ ! -f "$INSTALL_MANIFEST" ]; then
    info "No Forge install manifest was found. System packages were left alone."
    return 0
  fi

  case "$PACKAGE_MANAGER" in
    brew)
      remove_homebrew_packages
      ;;
    apt|dnf|yum|zypper|pacman)
      remove_official_linux_ollama_install
      remove_linux_packages
      remove_nodesource_apt_repo
      ;;
    *)
      info "No supported package manager was found, so system packages were left alone."
      ;;
  esac
}

remove_install_state() {
  if [ "$KEEP_DATA" = "0" ]; then
    step "Removing Forge install state"
    remove_path "$INSTALL_STATE_DIR"
  else
    step "Keeping settings and credentials"
    info "Kept .env, database/Redis data, Docker volumes, and $INSTALL_STATE_DIR."
    info "Run again with --remove-data when you want those removed too."
  fi
}

bold "Forge uninstall helper"
info "Repo: $REPO_ROOT"
detect_package_manager
setup_privilege_command
info "OS: $OS_NAME"
if [ -n "$PACKAGE_MANAGER" ]; then
  info "Package manager: $PACKAGE_MANAGER"
else
  info "Package manager: not detected"
fi
if [ "$KEEP_DATA" = "1" ]; then
  info "Mode: remove app/runtime pieces, keep settings and credentials."
else
  info "Mode: remove app/runtime pieces and delete Forge settings/data."
fi

resolve_remove_projects
if [ "$REMOVE_PROJECTS" = "1" ]; then
  info "Local projects: delete all Forge-created project folders."
else
  info "Local projects: keep all project folders on disk."
fi

remove_project_files
remove_build_artifacts
drop_app_database
stop_docker_services
remove_recorded_ollama_models
remove_recorded_packages
remove_env_files
remove_install_state

step "Uninstall complete"
if [ "$KEEP_DATA" = "1" ]; then
  info "Forge code is still in this checkout, and saved settings/data were kept for reinstall."
else
  info "Forge-local settings, generated state, database objects, and Docker volumes were removed when found."
fi
