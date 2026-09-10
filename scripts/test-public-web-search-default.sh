#!/usr/bin/env bash
set -euo pipefail

# Shell-level guard for the installer contract: a fresh env is disabled while
# ensure_env_value leaves any existing explicit setting untouched.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
grep -Fq "printf 'FORGE_AGENT_WEB_SEARCH=0" "$repo_root/scripts/setup.sh"
grep -Fq 'ensure_env_value FORGE_AGENT_WEB_SEARCH "0"' "$repo_root/scripts/install.sh"
if grep -Eq 'FORGE_AGENT_WEB_SEARCH[[:space:]]*=[[:space:]]*1' "$repo_root/scripts/setup.sh" "$repo_root/scripts/install.sh"; then
  echo 'public web research must not be enabled by a fresh installer' >&2
  exit 1
fi
