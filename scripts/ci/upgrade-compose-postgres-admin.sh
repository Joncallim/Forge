#!/bin/sh
set -eu

attest_transition() {
  [ "$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$1" -d "$POSTGRES_DB" -Atqc "select r.rolsuper and r.rolinherit and r.rolcanlogin and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication and not r.rolbypassrls and r.rolconnlimit=-1 and r.rolvaliduntil is null and not exists(select 1 from pg_auth_members m where m.roleid=r.oid or m.member=r.oid) and not exists(select 1 from pg_shdepend d where d.refclassid='pg_authid'::regclass and d.refobjid=r.oid) from pg_authid r where r.rolname='forge_admin_transition'")" = t ] \
    || { echo 'Reserved forge_admin_transition role failed exact recovery attestation.' >&2; exit 1; }
}

attest_canonical() {
  [ "$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge_admin -d "$POSTGRES_DB" -Atqc "select r.rolsuper and r.rolinherit and r.rolcanlogin and r.rolcreatedb and r.rolcreaterole and r.rolreplication and r.rolbypassrls and r.rolconnlimit=-1 and r.rolvaliduntil is null and r.rolpassword is not null and d.datdba=r.oid and not exists(select 1 from pg_auth_members m where m.roleid=r.oid or m.member=r.oid) from pg_authid r join pg_database d on d.datname=current_database() where r.rolname='forge_admin'")" = t ] \
    || { echo 'Canonical forge_admin role failed exact administrator attestation.' >&2; exit 1; }
}

POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
: "${PGPASSWORD:?POSTGRES_PASSWORD must be supplied as PGPASSWORD}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

if psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge_admin -d "$POSTGRES_DB" -Atqc 'select 1' >/dev/null 2>&1; then
  attest_canonical
  if psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge_admin -d "$POSTGRES_DB" -Atqc "select 1 from pg_roles where rolname='forge_admin_transition'" | grep -qx 1; then
    attest_transition forge_admin
    psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge_admin -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c 'drop role forge_admin_transition'
  fi
  [ "$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge_admin -d "$POSTGRES_DB" -Atqc "select count(*) from pg_roles where rolname='forge_admin_transition'")" = 0 ] \
    || { echo 'Reserved transition role survived canonical administrator recovery.' >&2; exit 1; }
  exit 0
fi

[ "${LEGACY_POSTGRES_USER:-}" = forge ] || { echo 'Existing PostgreSQL volume has no canonical forge_admin login.' >&2; exit 1; }
if psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge_admin_transition -d "$POSTGRES_DB" -Atqc 'select 1' >/dev/null 2>&1; then
  attest_transition forge_admin_transition
else
  [ "$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge -d "$POSTGRES_DB" -Atqc "select count(*) from pg_roles where rolname='forge_admin_transition'")" = 0 ] \
    || { echo 'Reserved forge_admin_transition role exists but cannot authenticate with the managed credential.' >&2; exit 1; }
  printf '%s\n' '\getenv admin_password PGPASSWORD' \
    "select format('create role forge_admin_transition login superuser password %L', :'admin_password') where not exists (select 1 from pg_roles where rolname='forge_admin_transition') \gexec" \
    | psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge -d "$POSTGRES_DB" -v ON_ERROR_STOP=1
  attest_transition forge_admin_transition
fi
[ "${FORGE_ADMIN_UPGRADE_FAIL_AFTER_CREATE:-0}" != 1 ] || { echo 'Injected administrator upgrade stop after transition creation.' >&2; exit 86; }
printf '%s\n' '\getenv admin_password PGPASSWORD' \
  'alter role forge rename to forge_admin;' \
  "select format('alter role forge_admin password %L', :'admin_password') \gexec" \
  | psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge_admin_transition -d "$POSTGRES_DB" -v ON_ERROR_STOP=1
[ "${FORGE_ADMIN_UPGRADE_FAIL_AFTER_RENAME:-0}" != 1 ] || { echo 'Injected administrator upgrade stop after canonical rename.' >&2; exit 87; }
attest_canonical
attest_transition forge_admin
psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge_admin -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c 'drop role forge_admin_transition'
[ "$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge_admin -d "$POSTGRES_DB" -Atqc "select count(*) from pg_roles where rolname='forge_admin_transition'")" = 0 ] \
  || { echo 'Reserved transition role survived administrator upgrade.' >&2; exit 1; }
