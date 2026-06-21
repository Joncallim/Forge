#!/usr/bin/env bash
#
# Compatibility wrapper. The installer is now cross-platform and lives at
# scripts/install.sh.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/install.sh" "$@"
