#!/usr/bin/env bash
# Disposable Docker proof for the one-time Compose PostgreSQL administrator lane.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/../.." && pwd)"
proof_id="forge-admin-upgrade-proof-$$_$RANDOM"
network_name="${proof_id,,}-network"
image_name="${proof_id,,}:latest"
database_name='forge'
password="forge-admin-upgrade-proof-$(od -An -N 24 -tx1 /dev/urandom | tr -d ' \n')"
container_name=''
upgrade_pid=''
attacker_pid=''
upgrade_log=''
attacker_log=''

cleanup() {
  [ -z "$attacker_pid" ] || kill "$attacker_pid" >/dev/null 2>&1 || true
  [ -z "$upgrade_pid" ] || kill "$upgrade_pid" >/dev/null 2>&1 || true
  [ -z "$container_name" ] || docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  docker image rm "$image_name" >/dev/null 2>&1 || true
  [ -z "$upgrade_log" ] || rm -f "$upgrade_log"
  [ -z "$attacker_log" ] || rm -f "$attacker_log"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

wait_for_postgres() {
  local attempt
  for attempt in $(seq 1 40); do
    if docker exec -e PGPASSWORD="$password" "$container_name" \
      psql -X -v ON_ERROR_STOP=1 -U "$1" -d "$database_name" -Atqc 'select 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "disposable PostgreSQL did not become transport-ready for $1"
}

psql_as() {
  local role="$1"
  shift
  docker exec -e PGPASSWORD="$password" "$container_name" \
    psql -X -v ON_ERROR_STOP=1 -U "$role" -d "$database_name" "$@"
}

start_legacy_cluster() {
  local legacy_role="$1"
  docker network create "$network_name" >/dev/null
  container_name="${proof_id,,}-${legacy_role}"
  docker run -d --rm --name "$container_name" --network "$network_name" \
    -e POSTGRES_USER="$legacy_role" \
    -e POSTGRES_PASSWORD="$password" \
    -e POSTGRES_DB="$database_name" \
    postgres:16-alpine >/dev/null
  wait_for_postgres "$legacy_role"
}

stop_legacy_cluster() {
  docker rm -f "$container_name" >/dev/null
  docker network rm "$network_name" >/dev/null
  container_name=''
}

run_upgrade() {
  local legacy_role="$1"
  docker run --rm --network "$network_name" \
    -e PGPASSWORD="$password" \
    -e POSTGRES_HOST="${container_name}" \
    -e POSTGRES_DB="$database_name" \
    -e LEGACY_POSTGRES_USER="$legacy_role" \
    "$image_name" >/dev/null 2>&1
}

run_upgrade_stop_after_fence() {
  local legacy_role="$1"
  docker run --rm --network "$network_name" \
    -e PGPASSWORD="$password" \
    -e POSTGRES_HOST="${container_name}" \
    -e POSTGRES_DB="$database_name" \
    -e LEGACY_POSTGRES_USER="$legacy_role" \
    -e FORGE_ADMIN_UPGRADE_FAIL_AFTER_FENCE=1 \
    "$image_name" >/dev/null 2>&1
}

start_upgrade_with_fence_hold() {
  local legacy_role="$1"
  upgrade_log="$(mktemp "${TMPDIR:-/tmp}/forge-admin-upgrade-proof.XXXXXX")"
  docker run --rm --network "$network_name" \
    -e PGPASSWORD="$password" \
    -e POSTGRES_HOST="${container_name}" \
    -e POSTGRES_DB="$database_name" \
    -e LEGACY_POSTGRES_USER="$legacy_role" \
    -e FORGE_ADMIN_UPGRADE_TEST_HOLD_AFTER_FENCE_SECONDS=8 \
    "$image_name" >"$upgrade_log" 2>&1 &
  upgrade_pid=$!
}

wait_for_attacker_session() {
  local legacy_role="$1"
  local attempt
  for attempt in $(seq 1 40); do
    if psql_as "$legacy_role" -Atqc "select exists(select 1 from pg_stat_activity where usename = '${legacy_role}' and query like 'select pg_sleep(30)%')" | grep -qx t; then
      return 0
    fi
    sleep 1
  done
  fail 'hostile legacy session did not reach its deterministic pre-fence hold'
}

wait_for_legacy_rejection() {
  local legacy_role="$1"
  local attempt
  for attempt in $(seq 1 20); do
    if ! psql_as "$legacy_role" -Atqc 'select 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail 'legacy credential remained usable after the transition fence'
}

capture_legacy_state() {
  local legacy_role="$1"
  psql_as "$legacy_role" -Atqc "
    select 'roles=' || string_agg(rolname || ':' || oid::text, ',' order by rolname)
      from pg_roles where rolname in ('${legacy_role}', 'forge_admin', 'forge_admin_transition');
    select 'databases=' || string_agg(datname || ':' || pg_get_userbyid(datdba), ',' order by datname)
      from pg_database where datname in ('forge', 'forge_admin_upgrade_foreign');
    select 'tablespaces=' || string_agg(spcname || ':' || pg_get_userbyid(spcowner), ',' order by spcname)
      from pg_tablespace where spcname in ('pg_default', 'pg_global', 'forge_admin_upgrade_foreign_tablespace');
  "
}

assert_positive_custom_bootstrap() {
  psql_as forge_admin -Atqc "
    select
      exists(select 1 from pg_roles where rolname = 'forge_admin')
      and not exists(select 1 from pg_roles where rolname in ('custom_owner', 'forge_admin_transition'))
      and (select count(*) from pg_database where datdba = 'forge_admin'::regrole) = 4
      and not exists(select 1 from pg_database where datdba = 'forge_admin'::regrole and datname not in ('forge', 'postgres', 'template0', 'template1'))
      and (select count(*) from pg_tablespace where spcowner = 'forge_admin'::regrole) = 2
      and not exists(select 1 from pg_tablespace where spcowner = 'forge_admin'::regrole and spcname not in ('pg_default', 'pg_global'));
  " | grep -qx t || fail 'custom bootstrap upgrade did not preserve the exact canonical initdb ownership topology'
}

assert_canonical_rerun_with_application_role() {
  psql_as forge_admin -c 'create role forge login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls' >/dev/null
  run_upgrade custom_owner
  assert_positive_custom_bootstrap
  psql_as forge_admin -c 'drop role forge' >/dev/null
}

assert_second_database_refusal() {
  local legacy_role="$1"
  psql_as "$legacy_role" -c "create database forge_admin_upgrade_foreign owner ${legacy_role}" >/dev/null
  local before_state after_state
  before_state="$(capture_legacy_state "$legacy_role")"
  if run_upgrade "$legacy_role"; then
    fail "upgrade accepted a second database owned by $legacy_role"
  fi
  after_state="$(capture_legacy_state "$legacy_role")"
  [ "$after_state" = "$before_state" ] || fail "failed second-database refusal changed role or database state for $legacy_role"
}

assert_nonstandard_tablespace_refusal() {
  local legacy_role="$1"
  docker exec --user postgres "$container_name" mkdir -p /var/lib/postgresql/forge-admin-upgrade-foreign-tablespace
  psql_as "$legacy_role" -c "create tablespace forge_admin_upgrade_foreign_tablespace owner ${legacy_role} location '/var/lib/postgresql/forge-admin-upgrade-foreign-tablespace'" >/dev/null
  local before_state after_state
  before_state="$(capture_legacy_state "$legacy_role")"
  if run_upgrade "$legacy_role"; then
    fail "upgrade accepted a nonstandard tablespace owned by $legacy_role"
  fi
  after_state="$(capture_legacy_state "$legacy_role")"
  [ "$after_state" = "$before_state" ] || fail "failed tablespace refusal changed role, database, or tablespace state for $legacy_role"
}

assert_extra_administrator_refusal() {
  local legacy_role="$1"
  psql_as "$legacy_role" -c 'create role forge_admin_upgrade_rogue login superuser' >/dev/null
  if run_upgrade "$legacy_role"; then
    fail 'upgrade accepted a second non-system administrator role'
  fi
  psql_as "$legacy_role" -Atqc "
    select exists(select 1 from pg_roles where rolname='${legacy_role}' and rolcanlogin and rolsuper)
      and exists(select 1 from pg_roles where rolname='forge_admin_upgrade_rogue' and rolcanlogin and rolsuper)
      and not exists(select 1 from pg_roles where rolname in ('forge_admin','forge_admin_transition'));
  " | grep -qx t || fail 'extra-administrator refusal changed the legacy or rogue administrator state'
}

assert_hostile_session_fence() {
  local legacy_role='custom_owner'
  local foreign_tablespace='forge_admin_upgrade_race_tablespace'
  local foreign_database='forge_admin_upgrade_race_database'
  local foreign_object='forge_admin_upgrade_race_object'
  local tablespace_path='/var/lib/postgresql/forge-admin-upgrade-race-tablespace'

  docker exec --user postgres "$container_name" mkdir -p "$tablespace_path"
  attacker_log="$(mktemp "${TMPDIR:-/tmp}/forge-admin-attacker-proof.XXXXXX")"
  # psql reads one command at a time. The attacker is connected before the
  # upgrade starts, sleeps inside PostgreSQL, then attempts each cluster/object
  # write after the fence would have to leave it alive. The process must die
  # before it can read those writes from stdin.
  (
    {
      printf 'select pg_sleep(30);\n'
      sleep 1
      printf 'create database %s;\n' "$foreign_database"
      printf "create tablespace %s owner %s location '%s';\n" "$foreign_tablespace" "$legacy_role" "$tablespace_path"
      printf 'create table public.%s(id integer);\n' "$foreign_object"
    } | docker exec -i -e PGPASSWORD="$password" "$container_name" \
      psql -X -v ON_ERROR_STOP=1 -U "$legacy_role" -d "$database_name"
  ) >"$attacker_log" 2>&1 &
  attacker_pid=$!
  wait_for_attacker_session "$legacy_role"
  start_upgrade_with_fence_hold "$legacy_role"
  wait_for_legacy_rejection "$legacy_role"
  if wait "$attacker_pid"; then
    fail 'pre-existing legacy session survived the fence long enough to accept a write'
  fi
  attacker_pid=''
  if ! wait "$upgrade_pid"; then
    sed -n '1,160p' "$upgrade_log" >&2
    fail 'administrator upgrade did not complete after fencing the hostile legacy session'
  fi
  upgrade_pid=''
  psql_as forge_admin -Atqc "
    select not exists(select 1 from pg_database where datname = '${foreign_database}')
      and not exists(select 1 from pg_tablespace where spcname = '${foreign_tablespace}')
      and to_regclass('public.${foreign_object}') is null;
  " | grep -qx t || fail 'hostile legacy session introduced a foreign database, tablespace, or object during transition'
  assert_positive_custom_bootstrap
}

assert_fenced_restart_recovery() {
  local legacy_role='custom_owner'
  if run_upgrade_stop_after_fence "$legacy_role"; then
    fail 'injected post-fence interruption unexpectedly completed the administrator upgrade'
  fi
  if psql_as "$legacy_role" -Atqc 'select 1' >/dev/null 2>&1; then
    fail 'durable legacy login fence was lost after the injected interruption'
  fi
  psql_as forge_admin_transition -Atqc 'select 1' | grep -qx 1 \
    || fail 'isolated transition credential could not recover the durable fence interruption'
  run_upgrade "$legacy_role"
  assert_positive_custom_bootstrap
  run_upgrade "$legacy_role"
  assert_positive_custom_bootstrap
}

docker build --quiet -f "$REPO_ROOT/Dockerfile.postgres-admin-upgrade" -t "$image_name" "$REPO_ROOT" >/dev/null

echo 'Proving official custom POSTGRES_USER/OID-10 initdb ownership succeeds.'
start_legacy_cluster custom_owner
run_upgrade custom_owner
assert_positive_custom_bootstrap
assert_canonical_rerun_with_application_role
stop_legacy_cluster

echo 'Proving a nonstandard tablespace blocks the custom administrator rename without mutation.'
start_legacy_cluster custom_owner
assert_nonstandard_tablespace_refusal custom_owner
stop_legacy_cluster

echo 'Proving an extra non-system administrator blocks the custom administrator rename without mutation.'
start_legacy_cluster custom_owner
assert_extra_administrator_refusal custom_owner
stop_legacy_cluster

echo 'Proving a pre-existing hostile legacy session is fenced before it can create foreign cluster or object state.'
start_legacy_cluster custom_owner
assert_hostile_session_fence
stop_legacy_cluster

echo 'Proving a durable legacy fence interruption recovers and then converges idempotently.'
start_legacy_cluster custom_owner
assert_fenced_restart_recovery
stop_legacy_cluster

for legacy_role in custom_owner forge; do
  echo "Proving a foreign second database blocks the $legacy_role administrator rename without mutation."
  start_legacy_cluster "$legacy_role"
  assert_second_database_refusal "$legacy_role"
  stop_legacy_cluster
done

echo 'COMPOSE_POSTGRES_ADMIN_UPGRADE_TOPOLOGY_PROOF_PASSED'
