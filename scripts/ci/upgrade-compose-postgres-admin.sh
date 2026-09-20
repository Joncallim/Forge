#!/bin/sh
set -eu

# The legacy bootstrap role is deliberately fenced before its OID is renamed.
# A role rename preserves ownership by OID, so a connection still using that
# superuser must not be able to add cluster-wide state between the last proof
# and the rename. The short test-only hold is bounded and defaults to zero;
# it exists solely so the disposable proof can observe the fence deterministically.

scope_query() {
  cat <<'SQL'
with expected_databases(datname, datistemplate, datallowconn) as (
  values (current_database()::name, false, true), ('postgres'::name, false, true),
         ('template0'::name, true, false), ('template1'::name, true, true)
), expected_tablespaces(spcname) as (
  values ('pg_default'::name), ('pg_global'::name)
)
select current_database() not in ('postgres', 'template0', 'template1')
  and r.rolinherit and r.rolcanlogin = :'expected_login'::boolean
  and case when :'expected_administrator'::boolean
    then r.rolsuper and r.rolcreatedb and r.rolcreaterole and r.rolreplication and r.rolbypassrls
    -- PostgreSQL requires the initdb bootstrap OID (10) to remain SUPERUSER.
    -- It is still NOLOGIN and every session using it has been terminated.
    else r.oid = 10 or (not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication and not r.rolbypassrls)
  end
  and r.rolconnlimit = -1 and r.rolvaliduntil is null and r.rolpassword is not null
  and current_database_row.datdba = r.oid
  and not exists(select 1 from pg_auth_members m where m.roleid = r.oid or m.member = r.oid)
  and not exists(
    select 1 from expected_databases expected left join pg_database actual on actual.datname = expected.datname
    where actual.oid is null or actual.datdba <> r.oid or actual.datistemplate <> expected.datistemplate
      or actual.datallowconn <> expected.datallowconn
  )
  and (select count(*) from pg_database owned where owned.datdba = r.oid) = (select count(*) from expected_databases)
  and not exists(
    select 1 from expected_tablespaces expected left join pg_tablespace actual on actual.spcname = expected.spcname
    where actual.oid is null or actual.spcowner <> r.oid
  )
  and (select count(*) from pg_tablespace owned where owned.spcowner = r.oid) = (select count(*) from expected_tablespaces)
  and not exists(
    select 1 from pg_shdepend dependency
    where dependency.refclassid = 'pg_authid'::regclass and dependency.refobjid = r.oid
      and not (
        dependency.dbid = current_database_row.oid
        or (dependency.dbid = 0 and dependency.classid = 'pg_database'::regclass
            and dependency.objid in (select actual.oid from pg_database actual join expected_databases expected on expected.datname = actual.datname))
        or (dependency.dbid = 0 and dependency.classid = 'pg_tablespace'::regclass
            and dependency.objid in (select actual.oid from pg_tablespace actual join expected_tablespaces expected on expected.spcname = actual.spcname))
      )
  )
  and not exists(
    select 1 from pg_roles extra
    where extra.rolname !~ '^pg_' and extra.rolname not in (:'scope_role', 'forge_admin_transition')
      and (extra.rolsuper or extra.rolcreatedb or extra.rolcreaterole or extra.rolreplication or extra.rolbypassrls)
  )
  and (:'allow_ordinary_roles'::boolean or not exists(
    select 1 from pg_roles extra
    where extra.rolname !~ '^pg_' and extra.rolname not in (:'scope_role', 'forge_admin_transition')
  ))
from pg_authid r join pg_database current_database_row on current_database_row.datname = current_database()
where r.rolname = :'scope_role';
SQL
}

attest_exact_scope() {
  connection_role="$1"
  scope_role="$2"
  expected_login="$3"
  expected_administrator="$4"
  allow_ordinary_roles="${5:-false}"
  [ "$(scope_query | psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$connection_role" -d "$POSTGRES_DB" \
    -v scope_role="$scope_role" -v expected_login="$expected_login" -v expected_administrator="$expected_administrator" \
    -v allow_ordinary_roles="$allow_ordinary_roles" -Atq)" = t ] \
    || { echo 'Administrator role failed exact ownership and cluster-scope attestation.' >&2; exit 1; }
}

assert_exact_scope_in_transaction() {
  # psql expands its variables before the DO body is parsed. Keeping this
  # check in the same transaction as NOLOGIN, session termination, and rename
  # prevents a legacy superuser from reopening the verified interval.
  cat <<'SQL'
select set_config('forge_admin_upgrade.scope_role', :'scope_role', true);
select set_config('forge_admin_upgrade.expected_login', :'expected_login', true);
select set_config('forge_admin_upgrade.expected_administrator', :'expected_administrator', true);
do $forge_scope$
declare scope_ok boolean;
begin
  with expected_databases(datname, datistemplate, datallowconn) as (
    values (current_database()::name, false, true), ('postgres'::name, false, true),
           ('template0'::name, true, false), ('template1'::name, true, true)
  ), expected_tablespaces(spcname) as (
    values ('pg_default'::name), ('pg_global'::name)
  )
  select current_database() not in ('postgres', 'template0', 'template1')
    and r.rolinherit and r.rolcanlogin = current_setting('forge_admin_upgrade.expected_login')::boolean
    and case when current_setting('forge_admin_upgrade.expected_administrator')::boolean
      then r.rolsuper and r.rolcreatedb and r.rolcreaterole and r.rolreplication and r.rolbypassrls
      else r.oid = 10 or (not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication and not r.rolbypassrls)
    end
    and r.rolconnlimit = -1 and r.rolvaliduntil is null and r.rolpassword is not null
    and current_database_row.datdba = r.oid
    and not exists(select 1 from pg_auth_members m where m.roleid = r.oid or m.member = r.oid)
    and not exists(
      select 1 from expected_databases expected left join pg_database actual on actual.datname = expected.datname
      where actual.oid is null or actual.datdba <> r.oid or actual.datistemplate <> expected.datistemplate
        or actual.datallowconn <> expected.datallowconn
    )
    and (select count(*) from pg_database owned where owned.datdba = r.oid) = (select count(*) from expected_databases)
    and not exists(
      select 1 from expected_tablespaces expected left join pg_tablespace actual on actual.spcname = expected.spcname
      where actual.oid is null or actual.spcowner <> r.oid
    )
    and (select count(*) from pg_tablespace owned where owned.spcowner = r.oid) = (select count(*) from expected_tablespaces)
    and not exists(
      select 1 from pg_shdepend dependency
      where dependency.refclassid = 'pg_authid'::regclass and dependency.refobjid = r.oid
        and not (
          dependency.dbid = current_database_row.oid
          or (dependency.dbid = 0 and dependency.classid = 'pg_database'::regclass
              and dependency.objid in (select actual.oid from pg_database actual join expected_databases expected on expected.datname = actual.datname))
          or (dependency.dbid = 0 and dependency.classid = 'pg_tablespace'::regclass
              and dependency.objid in (select actual.oid from pg_tablespace actual join expected_tablespaces expected on expected.spcname = actual.spcname))
        )
    )
    and not exists(
      select 1 from pg_roles extra
      where extra.rolname !~ '^pg_' and extra.rolname not in (current_setting('forge_admin_upgrade.scope_role'), 'forge_admin_transition')
    )
    into scope_ok
  from pg_authid r join pg_database current_database_row on current_database_row.datname = current_database()
  where r.rolname = current_setting('forge_admin_upgrade.scope_role');
  if scope_ok is distinct from true then
    raise exception 'administrator role failed exact ownership and cluster-scope attestation';
  end if;
end
$forge_scope$;
SQL
}

attest_transition() {
  [ "$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$1" -d "$POSTGRES_DB" -Atqc "select r.rolsuper and r.rolinherit and r.rolcanlogin and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication and not r.rolbypassrls and r.rolconnlimit=-1 and r.rolvaliduntil is null and not exists(select 1 from pg_auth_members m where m.roleid=r.oid or m.member=r.oid) and not exists(select 1 from pg_shdepend d where d.refclassid='pg_authid'::regclass and d.refobjid=r.oid) from pg_authid r where r.rolname='forge_admin_transition'")" = t ] \
    || { echo 'Reserved forge_admin_transition role failed exact recovery attestation.' >&2; exit 1; }
}

validate_legacy_role() {
  legacy_role="${LEGACY_POSTGRES_USER:-}"
  printf '%s' "$legacy_role" | grep -Eq '^[a-z_][a-z0-9_]{0,62}$' \
    || { echo 'Configured prior POSTGRES_USER is not a safe unquoted PostgreSQL role name.' >&2; exit 1; }
  case "$legacy_role" in
    forge_admin|forge_admin_transition|pg_*|postgres|public|current_user|session_user|current_role|none|user)
      echo 'Configured prior POSTGRES_USER is reserved and cannot be transitioned.' >&2
      exit 1
      ;;
  esac
}

validate_test_hold() {
  test_hold_seconds="${FORGE_ADMIN_UPGRADE_TEST_HOLD_AFTER_FENCE_SECONDS:-0}"
  case "$test_hold_seconds" in
    0|[1-9]|[1-2][0-9]|30) ;;
    *) echo 'FORGE_ADMIN_UPGRADE_TEST_HOLD_AFTER_FENCE_SECONDS must be an integer from 0 through 30.' >&2; exit 1 ;;
  esac
}

disable_legacy_entry() {
  # Commit NOLOGIN before session termination. A transaction-local NOLOGIN is
  # invisible to a racing new connection, while this durable fence makes a
  # failed final proof recoverable by the already-isolated transition role.
  {
    printf '%s\n' 'begin;'
    # PostgreSQL will not remove SUPERUSER from its initdb bootstrap role
    # (OID 10). For that documented exception, NOLOGIN is durable before the
    # remaining sessions are killed; non-bootstrap roles lose every dangerous
    # role attribute as well.
    printf '%s\n' "select case when oid = 10 then format('alter role %I nologin', rolname) else format('alter role %I nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls', rolname) end from pg_roles where rolname = :'legacy_role' \\gexec"
    printf '%s\n' 'commit;'
  } | psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge_admin_transition -d "$POSTGRES_DB" \
    -v ON_ERROR_STOP=1 -v legacy_role="$legacy_role"
}

complete_fenced_rename() {
  # The transition role is a separate, credential-isolated superuser. NOLOGIN
  # is already durable, so after this second session drain no legacy session
  # can reopen the verified interval. The final proof, rename, and canonical
  # proof share one transaction.
  {
    printf '%s\n' '\getenv admin_password PGPASSWORD'
    printf '%s\n' 'begin;'
    printf '%s\n' "select pg_terminate_backend(pid, 5000) from pg_stat_activity where backend_type = 'client backend' and usename = :'legacy_role' and pid <> pg_backend_pid();"
    printf '%s\n' "select set_config('forge_admin_upgrade.legacy_role', :'legacy_role', true);"
    printf '%s\n' "do \$forge_fence\$ declare attempt integer; begin for attempt in 1..50 loop perform pg_stat_clear_snapshot(); exit when not exists(select 1 from pg_stat_activity where backend_type = 'client backend' and usename = current_setting('forge_admin_upgrade.legacy_role') and pid <> pg_backend_pid()); perform pg_terminate_backend(pid, 100) from pg_stat_activity where backend_type = 'client backend' and usename = current_setting('forge_admin_upgrade.legacy_role') and pid <> pg_backend_pid(); perform pg_sleep(0.1); end loop; perform pg_stat_clear_snapshot(); if exists(select 1 from pg_stat_activity where backend_type = 'client backend' and usename = current_setting('forge_admin_upgrade.legacy_role') and pid <> pg_backend_pid()) then raise exception 'legacy administrator session survived transition fence'; end if; end \$forge_fence\$;"
    printf '%s\n' "select pg_sleep(:'test_hold_seconds'::double precision) where :'test_hold_seconds'::int > 0;"
    printf '%s\n' '/* final legacy scope attestation is immediately before the OID-preserving rename. */'
    assert_exact_scope_in_transaction
    printf '%s\n' "select format('alter role %I rename to forge_admin', :'legacy_role') \\gexec"
    printf '%s\n' "select format('alter role forge_admin login superuser createdb createrole replication bypassrls password %L', :'admin_password') \\gexec"
    printf '%s\n' '\set scope_role forge_admin'
    printf '%s\n' '\set expected_login true'
    printf '%s\n' '\set expected_administrator true'
    printf '%s\n' '/* verify canonical scope before the transaction is published. */'
    assert_exact_scope_in_transaction
    printf '%s\n' 'commit;'
  } | psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge_admin_transition -d "$POSTGRES_DB" \
    -v ON_ERROR_STOP=1 -v legacy_role="$legacy_role" -v scope_role="$legacy_role" \
    -v expected_login=false -v expected_administrator=false \
    -v test_hold_seconds="$test_hold_seconds"
}

fence_and_rename() {
  disable_legacy_entry
  [ "${FORGE_ADMIN_UPGRADE_FAIL_AFTER_FENCE:-0}" != 1 ] || { echo 'Injected administrator upgrade stop after durable legacy fence.' >&2; exit 88; }
  complete_fenced_rename
}

POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
: "${PGPASSWORD:?POSTGRES_PASSWORD must be supplied as PGPASSWORD}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

if psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge_admin -d "$POSTGRES_DB" -Atqc 'select 1' >/dev/null 2>&1; then
  # A crash after the rename leaves only the bounded transition role to clean
  # up. It is allowed during recovery, then explicitly removed and attested.
  attest_exact_scope forge_admin forge_admin true true true
  if psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge_admin -d "$POSTGRES_DB" -Atqc "select 1 from pg_roles where rolname='forge_admin_transition'" | grep -qx 1; then
    attest_transition forge_admin
    psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge_admin -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c 'drop role forge_admin_transition'
  fi
  attest_exact_scope forge_admin forge_admin true true true
  exit 0
fi

validate_legacy_role
validate_test_hold
if psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge_admin_transition -d "$POSTGRES_DB" -Atqc 'select 1' >/dev/null 2>&1; then
  attest_transition forge_admin_transition
else
  # This preliminary proof authorizes creating the isolated recovery role.
  # The authoritative proof is repeated inside fence_and_rename after every
  # other legacy session has been terminated.
  attest_exact_scope "$legacy_role" "$legacy_role" true true
  [ "$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$legacy_role" -d "$POSTGRES_DB" -Atqc "select count(*) from pg_roles where rolname='forge_admin_transition'")" = 0 ] \
    || { echo 'Reserved forge_admin_transition role exists but cannot authenticate with the managed credential.' >&2; exit 1; }
  printf '%s\n' '\getenv admin_password PGPASSWORD' \
    "select format('create role forge_admin_transition login superuser password %L', :'admin_password') where not exists (select 1 from pg_roles where rolname='forge_admin_transition') \\gexec" \
    | psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$legacy_role" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1
  attest_transition forge_admin_transition
fi
[ "${FORGE_ADMIN_UPGRADE_FAIL_AFTER_CREATE:-0}" != 1 ] || { echo 'Injected administrator upgrade stop after transition creation.' >&2; exit 86; }
fence_and_rename
[ "${FORGE_ADMIN_UPGRADE_FAIL_AFTER_RENAME:-0}" != 1 ] || { echo 'Injected administrator upgrade stop after canonical rename.' >&2; exit 87; }
attest_exact_scope forge_admin forge_admin true true true
attest_transition forge_admin
psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U forge_admin -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c 'drop role forge_admin_transition'
attest_exact_scope forge_admin forge_admin true true true
