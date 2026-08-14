#!/usr/bin/env bash
# Shared, fail-closed expectations for proofs that must reach the current
# Drizzle migration tip. Source this file after enabling `set -e`.

forge_load_current_migration_ledger() {
  local helper_dir repo_root journal_path expectations extra
  local migration_count latest_migration_at

  helper_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd -P "$helper_dir/../.." && pwd)"
  journal_path="$repo_root/web/db/migrations/meta/_journal.json"

  if ! expectations="$(
    node -e '
      const { readFileSync } = require("node:fs");
      const journalPath = process.argv[1];
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const entries = journal.entries;
      if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error("The migration journal must contain at least one entry");
      }
      for (const [index, entry] of entries.entries()) {
        if (entry.idx !== index || !Number.isSafeInteger(entry.when) || entry.when <= 0) {
          throw new Error(`Invalid migration journal entry at index ${index}`);
        }
        if (index > 0 && entry.when <= entries[index - 1].when) {
          throw new Error(`Migration timestamps are not strictly increasing at index ${index}`);
        }
      }
      process.stdout.write(`${entries.length} ${entries.at(-1).when}\n`);
    ' "$journal_path"
  )"; then
    echo 'Could not derive the current migration ledger from the Drizzle journal.' >&2
    return 1
  fi

  IFS=' ' read -r migration_count latest_migration_at extra <<< "$expectations"
  if [[ ! "$migration_count" =~ ^[1-9][0-9]*$ \
     || ! "$latest_migration_at" =~ ^[1-9][0-9]*$ \
     || -n "$extra" ]]; then
    echo 'The Drizzle journal produced invalid current-migration expectations.' >&2
    return 1
  fi

  FORGE_CURRENT_MIGRATION_COUNT="$migration_count"
  FORGE_CURRENT_LATEST_MIGRATION_AT="$latest_migration_at"
  readonly FORGE_CURRENT_MIGRATION_COUNT FORGE_CURRENT_LATEST_MIGRATION_AT
}

if ! forge_load_current_migration_ledger; then
  if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    exit 1
  fi
  return 1
fi
unset -f forge_load_current_migration_ledger
