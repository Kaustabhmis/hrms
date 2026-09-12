-- ============================================================================
-- Did the setup work?
--
-- Paste this into the Supabase SQL Editor and run it. Unlike a NOTICE, which
-- the web editor does not display at all, this comes back as a table you can
-- read. Every row should say OK.
-- ============================================================================
with checks as (
    select 1 as ord, 'Tables' as what,
           (select count(*)::text from information_schema.tables where table_schema='public') as found,
           '27' as expected
    union all
    select 2, 'Row-level security policies',
           (select count(*)::text from pg_policies where schemaname='public'), '67'
    union all
    select 3, 'Modules in the catalog',
           (select count(*)::text from modules), '30'
    union all
    select 4, 'Module dependencies',
           (select count(*)::text from module_requires), '20'
    union all
    select 5, 'Tenant tables left unprotected',
           coalesce((select string_agg(c.relname, ', ')
                     from pg_class c join pg_namespace n on n.oid=c.relnamespace
                     where n.nspname='public' and c.relkind='r' and not c.relrowsecurity
                       and exists (select 1 from information_schema.columns
                                   where table_schema='public' and table_name=c.relname
                                     and column_name='company_id')), 'none'), 'none'
    union all
    select 6, 'Linked to Supabase Auth',
           case when to_regclass('auth.users') is not null then 'yes' else 'no' end, 'yes'
    union all
    select 7, 'Auto-create app_users on signup',
           case when exists (select 1 from pg_trigger where tgname='on_auth_user_created')
                then 'yes' else 'no (create accounts from the HRMS instead)' end, 'yes'
    union all
    select 8, 'Companies set up so far',
           (select count(*)::text from companies), 'any'
    union all
    select 9, 'Accounts set up so far',
           (select count(*)::text from app_users), 'any'
)
select
    case when found = expected or expected = 'any' then 'OK' else 'CHECK THIS' end as status,
    what,
    found,
    case when expected = 'any' then '' else 'expected ' || expected end as note
from checks order by ord;
