-- ============================================================================
-- Close the hole in the administrative functions
--
-- Every SECURITY DEFINER function created in the public schema is exposed by
-- PostgREST as /rest/v1/rpc/<name>, and PostgreSQL grants EXECUTE on a new
-- function to PUBLIC. The publishable key is in the page source by design. Put
-- those together and anyone at all could POST to
--
--     /rest/v1/rpc/bootstrap_owner
--
-- and make any account the super admin, or call set_user_modules and grant
-- themselves every module. Definer rights meant the database would have obeyed.
--
-- Revoking from anon and authenticated by name does nothing: the grant those
-- roles are using belongs to PUBLIC, which they inherit. It has to come off
-- PUBLIC and then be handed back only where it is genuinely needed.
--
-- Two locks, because one is never enough:
--   1. EXECUTE is revoked, so the call does not reach the function.
--   2. The function checks who is asking anyway, so it refuses even if some
--      future grant lets a call through.
-- ============================================================================

-- ---------------------------------------------------------------- lock one --
revoke execute on function public.bootstrap_owner(text, text, text)             from public;
revoke execute on function public.set_user_modules(text, text[])                from public;
revoke execute on function public.set_role_modules(uuid, text, text[], boolean) from public;
revoke execute on function public.grant_all_modules(text)                       from public;
revoke execute on function public.set_company_modules(uuid, text[])             from public;

-- Trigger functions are not an API. They run from triggers as the table owner,
-- so they keep working with no grant to anybody.
revoke execute on function public.handle_new_auth_user()   from public;
revoke execute on function public.handle_auth_user_email() from public;
revoke execute on function public.role_modules_before()    from public;
revoke execute on function public.role_modules_after()     from public;
do $$ begin
    execute 'revoke execute on function public.guard_executed_payroll() from public';
exception when undefined_function then null; end $$;

-- The provider saves a company from the browser, so a signed-in caller needs
-- this one. Nothing else is handed back: bootstrap_owner, set_user_modules,
-- set_role_modules and grant_all_modules are run from the SQL editor, where the
-- caller is postgres and owns them outright.
-- Supabase provides the anon and authenticated roles; a plain PostgreSQL does
-- not. Guarding these means the same file sets up either one.
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute 'grant execute on function public.set_company_modules(uuid, text[]) to authenticated';
    end if;
end $$;

-- ---------------------------------------------------------------- lock two --
-- my_role() resolves the caller through auth.uid(). In the SQL editor there is
-- no JWT, so it is null -- which means "not coming through the API at all":
-- that is postgres, which owns the database and needs no permission from here.
-- Getting this wrong the other way would reject every setup script.
create or replace function public.set_company_modules(p_company uuid, p_keys text[])
returns void
language plpgsql security definer set search_path = public as $$
declare v_caller text := my_role();
begin
    if v_caller is not null and v_caller <> 'super' then
        raise exception 'Only the provider account may issue modules to a company.'
            using errcode = '42501';
    end if;
    delete from company_modules where company_id = p_company;
    insert into company_modules(company_id, module_key)
        select p_company, unnest(resolve_modules(p_keys));
end $$;
revoke execute on function public.set_company_modules(uuid, text[]) from public;
-- Supabase provides the anon and authenticated roles; a plain PostgreSQL does
-- not. Guarding these means the same file sets up either one.
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute 'grant execute on function public.set_company_modules(uuid, text[]) to authenticated';
    end if;
end $$;

create or replace function public.set_user_modules(p_email text, p_keys text[])
returns text
language plpgsql security definer set search_path = public as $$
declare
    v_id uuid; v_company uuid; v_role text; v_keys text[]; v_missing text[];
    v_caller text := my_role();
begin
    if v_caller is not null and v_caller not in ('super','hr','admin') then
        raise exception 'Only the provider, HR or an admin may change module access.'
            using errcode = '42501';
    end if;

    select id, company_id, role into v_id, v_company, v_role
    from app_users where lower(email) = lower(trim(p_email));

    if v_id is null then
        return 'No account for ' || p_email ||
               '. Create the login first (Logins & Access in the HRMS, or Supabase Auth), then run this again.';
    end if;
    -- HR may set its own company's people and nobody else's.
    if v_caller in ('hr','admin') and v_company is distinct from my_company() then
        raise exception 'That account belongs to another company.' using errcode = '42501';
    end if;
    if v_role = 'super' then
        return p_email || ' is the provider account. It holds every module of every company by ' ||
               'definition and cannot be narrowed -- that is what makes it the provider.';
    end if;
    if v_company is null then
        return p_email || ' is not attached to a company yet, so it can hold nothing. ' ||
               'Place it in a company first.';
    end if;

    v_keys := resolve_modules(coalesce(p_keys, '{}'));
    select array_agg(k) into v_missing from (
        select unnest(v_keys) as k
        except
        select module_key from company_modules where company_id = v_company) x;

    update app_users set all_modules = false where id = v_id;
    delete from user_modules where user_id = v_id;
    insert into user_modules (user_id, module_key)
        select v_id, unnest(v_keys) on conflict do nothing;

    return p_email || ' (' || v_role || ') now holds ' ||
           (select count(*) from user_modules um
            join company_modules cm on cm.company_id = v_company and cm.module_key = um.module_key
            where um.user_id = v_id) ||
           ' module(s) of the ' || (select count(*) from company_modules where company_id = v_company) ||
           ' this company is licensed for' ||
           case when v_missing is not null
                then '. Not licensed, so granted nothing: ' || array_to_string(v_missing, ', ')
                else '' end;
end $$;
revoke execute on function public.set_user_modules(text, text[]) from public;

create or replace function public.grant_all_modules(p_email text)
returns text
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_caller text := my_role();
begin
    if v_caller is not null and v_caller not in ('super','hr','admin') then
        raise exception 'Only the provider, HR or an admin may change module access.'
            using errcode = '42501';
    end if;
    select id into v_id from app_users where lower(email) = lower(trim(p_email));
    if v_id is null then return 'No account for ' || p_email || '.'; end if;
    update app_users set all_modules = true where id = v_id;
    delete from user_modules where user_id = v_id;
    return p_email || ' now follows the company licence: whatever the company holds, including ' ||
           'anything issued to it later.';
end $$;
revoke execute on function public.grant_all_modules(text) from public;

-- -------------------------------------------------------------- the rest --
-- A view without security_invoker runs as its owner, quietly bypassing
-- row-level security for whoever reads it.
alter view public.module_keys_v set (security_invoker = on);

-- A definer function without a fixed search_path can be pointed at another
-- schema's tables by whoever calls it.
alter function public.is_super()               set search_path = public;
alter function public.is_control()             set search_path = public;
alter function public.resolve_modules(text[])  set search_path = public;
do $$ begin
    execute 'alter function public.guard_executed_payroll() set search_path = public';
exception when undefined_function then null; end $$;

-- The my_* helpers stay callable on purpose. They resolve the caller's own
-- identity through auth.uid(), so an anonymous caller gets null and they return
-- nothing -- and row-level security policies invoke them as the querying role,
-- so revoking them would break every policy in the database.

select 'Administrative functions locked down' as step,
       (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public'
          and p.proname in ('bootstrap_owner','set_user_modules','set_role_modules','grant_all_modules')
          and has_function_privilege('anon', p.oid, 'EXECUTE')) as still_reachable_by_anon;
