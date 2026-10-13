-- Database roles and the global connection budget. Run once per database by the admin
-- (avnadmin), and again whenever the role definitions below change (every statement is
-- idempotent):
--
--   psql "$ADMIN_URL" -v migrator_password="$MIGRATOR_PW" -v worker_password="$WORKER_PW" \
--     -v web_password="$WEB_PW" [-v owner_role=avnadmin] -f packages/db/roles/bootstrap.sql
--
-- Pass owner_role once, on the first run after migrations were applied as that role: it hands
-- the existing schema objects to ma_migrator so later migrations (run as ma_migrator) can alter
-- them.
--
-- Budget: ma_worker 3 (queue pool 1 + app pool 2), ma_web 5, ma_migrator 1. See docs/ops.md.

\set ON_ERROR_STOP on

\if :{?migrator_password}
\else
  do $$ begin raise exception 'missing psql variable: -v migrator_password=...'; end $$;
\endif
\if :{?worker_password}
\else
  do $$ begin raise exception 'missing psql variable: -v worker_password=...'; end $$;
\endif
\if :{?web_password}
\else
  do $$ begin raise exception 'missing psql variable: -v web_password=...'; end $$;
\endif

select 'create role ma_migrator login'
where not exists (select 1 from pg_roles where rolname = 'ma_migrator') \gexec
select 'create role ma_worker login'
where not exists (select 1 from pg_roles where rolname = 'ma_worker') \gexec
select 'create role ma_web login'
where not exists (select 1 from pg_roles where rolname = 'ma_web') \gexec

alter role ma_migrator login connection limit 1 password :'migrator_password';
alter role ma_worker login connection limit 3 password :'worker_password';
alter role ma_web login connection limit 5 password :'web_password';

-- Membership lets this admin create objects owned by these roles and set their default privileges.
-- A CREATEROLE admin (Aiven's avnadmin) only gets ADMIN on roles it creates, not SET/INHERIT.
select format('grant %I to %I with inherit true, set true', r, current_user)
from unnest(array['ma_migrator', 'ma_worker']) as r
where not (pg_has_role(current_user, r, 'set') and pg_has_role(current_user, r, 'usage')) \gexec

alter role ma_worker set statement_timeout = '30s';
alter role ma_worker set lock_timeout = '2s';
alter role ma_worker set idle_in_transaction_session_timeout = '15s';

alter role ma_migrator set lock_timeout = '10s';

alter role ma_web set default_transaction_read_only = on;
alter role ma_web set statement_timeout = '5s';
alter role ma_web set lock_timeout = '1s';
alter role ma_web set idle_in_transaction_session_timeout = '10s';

select format('grant connect on database %I to ma_migrator, ma_worker, ma_web', current_database())
\gexec
-- drizzle runs CREATE SCHEMA IF NOT EXISTS on every migrate, which still needs CREATE here.
select format('grant create on database %I to ma_migrator', current_database()) \gexec
grant usage, create on schema public to ma_migrator;
grant usage on schema public to ma_worker, ma_web;

-- drizzle keeps its migration journal here.
create schema if not exists drizzle authorization ma_migrator;
alter schema drizzle owner to ma_migrator;

-- Migrations run as ma_migrator, which must own what they alter. drizzle's own bookkeeping lives
-- in schema "drizzle". Scoped to these two schemas rather than REASSIGN OWNED, which would also
-- hand over the database itself and every other schema the admin owns.
\if :{?owner_role}
select format('alter table %s owner to ma_migrator', c.oid::regclass)
from pg_class c
join pg_roles o on o.oid = c.relowner
where c.relnamespace in (select oid from pg_namespace where nspname in ('public', 'drizzle'))
  and c.relkind in ('r', 'p', 'v', 'm', 'f')
  and o.rolname = :'owner_role' \gexec
select format('alter sequence %s owner to ma_migrator', c.oid::regclass)
from pg_class c
join pg_roles o on o.oid = c.relowner
where c.relnamespace in (select oid from pg_namespace where nspname in ('public', 'drizzle'))
  and c.relkind = 'S'
  and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i'))
  and o.rolname = :'owner_role' \gexec
select format('alter type %s owner to ma_migrator', t.oid::regtype)
from pg_type t
join pg_roles o on o.oid = t.typowner
where t.typnamespace in (select oid from pg_namespace where nspname in ('public', 'drizzle'))
  and t.typtype in ('e', 'd', 'c')
  and (t.typrelid = 0 or (select relkind from pg_class where oid = t.typrelid) = 'c')
  and o.rolname = :'owner_role' \gexec
select format('alter routine %s owner to ma_migrator', p.oid::regprocedure)
from pg_proc p
join pg_roles o on o.oid = p.proowner
where p.pronamespace in (select oid from pg_namespace where nspname in ('public', 'drizzle'))
  and o.rolname = :'owner_role' \gexec
\endif

-- ma_web converges to read-only even if an earlier run or a manual grant gave it more.
revoke all on all tables in schema public from ma_web;
revoke all on all sequences in schema public from ma_web;
revoke create on schema public from ma_web;
alter default privileges in schema public revoke all on tables from ma_web;
alter default privileges in schema public revoke all on sequences from ma_web;
alter default privileges for role ma_migrator in schema public revoke all on tables from ma_web;
alter default privileges for role ma_migrator in schema public
  revoke all on sequences from ma_web;

grant select, insert, update, delete on all tables in schema public to ma_worker;
grant usage, select on all sequences in schema public to ma_worker;
grant select on all tables in schema public to ma_web;

alter default privileges in schema public
  grant select, insert, update, delete on tables to ma_worker;
alter default privileges in schema public
  grant usage, select on sequences to ma_worker;
alter default privileges in schema public
  grant select on tables to ma_web;
alter default privileges for role ma_migrator in schema public
  grant select, insert, update, delete on tables to ma_worker;
alter default privileges for role ma_migrator in schema public
  grant usage, select on sequences to ma_worker;
alter default privileges for role ma_migrator in schema public
  grant select on tables to ma_web;

-- pg-boss installs and migrates its own schema at worker start, so ma_worker must own it and
-- everything already in it (a schema created by an earlier admin-run worker is handed over).
create schema if not exists pgboss authorization ma_worker;
alter schema pgboss owner to ma_worker;
select format('alter table %s owner to ma_worker', c.oid::regclass)
from pg_class c
join pg_roles o on o.oid = c.relowner
where c.relnamespace = 'pgboss'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S')
  and o.rolname <> 'ma_worker' \gexec
select format('alter type %s owner to ma_worker', t.oid::regtype)
from pg_type t
join pg_roles o on o.oid = t.typowner
where t.typnamespace = 'pgboss'::regnamespace and t.typtype in ('e', 'd')
  and o.rolname <> 'ma_worker' \gexec
select format('alter routine %s owner to ma_worker', p.oid::regprocedure)
from pg_proc p
join pg_roles o on o.oid = p.proowner
where p.pronamespace = 'pgboss'::regnamespace and o.rolname <> 'ma_worker' \gexec
grant all on schema pgboss to ma_worker;
revoke all on schema pgboss from ma_web;
revoke all on all tables in schema pgboss from ma_web;
revoke all on all sequences in schema pgboss from ma_web;
