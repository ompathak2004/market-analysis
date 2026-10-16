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
alter role ma_web set idle_session_timeout = '15s';

select format('grant connect on database %I to ma_migrator, ma_worker, ma_web', current_database())
\gexec
select format('grant create on database %I to ma_migrator', current_database()) \gexec
grant usage, create on schema public to ma_migrator;
grant usage on schema public to ma_worker, ma_web;

create schema if not exists drizzle authorization ma_migrator;
alter schema drizzle owner to ma_migrator;

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

select format('grant execute on function %s to ma_web', to_regprocedure(f))
from unnest(array[
  'review_relationship(bigint, review_decision, text, text)',
  'review_influence_edge(bigint, text, text, text, integer)'
]) as f
where to_regprocedure(f) is not null \gexec
