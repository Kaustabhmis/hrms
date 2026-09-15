-- ============================================================================
-- Modules for one named person
--
-- 0006 set a rule for a whole role. This is the other half: one account, by
-- email, hand-picked -- the HR manager who should see payroll but not
-- recruitment, the supervisor who needs shifts and nothing else.
--
-- Precedence, so it is not a surprise later:
--   * A role rule is applied when an account is CREATED, or when its role
--     changes. It does not run again on its own.
--   * A grant set here stands from then on -- until somebody changes that
--     person's role, or re-runs set_role_modules for their role, either of
--     which reapplies the rule and overwrites this.
--
-- The company licence is still the ceiling, and unlicensed keys are reported
-- rather than silently doing nothing. Safe to run twice.
-- ============================================================================

create or replace function set_user_modules(p_email text, p_keys text[])
returns text
language plpgsql security definer set search_path = public as $$
declare
    v_id      uuid;
    v_company uuid;
    v_role    text;
    v_keys    text[];
    v_missing text[];
begin
    select id, company_id, role into v_id, v_company, v_role
    from app_users where lower(email) = lower(trim(p_email));

    if v_id is null then
        return 'No account for ' || p_email ||
               '. Create the login first (Logins & Access in the HRMS, or Supabase Auth), then run this again.';
    end if;
    if v_role = 'super' then
        return p_email || ' is the provider account. It holds every module of every company by ' ||
               'definition and cannot be narrowed -- that is what makes it the provider.';
    end if;
    if v_company is null then
        return p_email || ' is not attached to a company yet, so it can hold nothing. ' ||
               'Place it in a company first.';
    end if;

    -- Dependencies come along, and the core modules are always present.
    v_keys := resolve_modules(coalesce(p_keys, '{}'));

    select array_agg(k) into v_missing from (
        select unnest(v_keys) as k
        except
        select module_key from company_modules where company_id = v_company) x;

    update app_users set all_modules = false where id = v_id;
    delete from user_modules where user_id = v_id;
    insert into user_modules (user_id, module_key)
        select v_id, unnest(v_keys)
        on conflict do nothing;

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

-- Put somebody back on "everything the company holds".
create or replace function grant_all_modules(p_email text)
returns text
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
    select id into v_id from app_users where lower(email) = lower(trim(p_email));
    if v_id is null then return 'No account for ' || p_email || '.'; end if;
    update app_users set all_modules = true where id = v_id;
    delete from user_modules where user_id = v_id;
    return p_email || ' now follows the company licence: whatever the company holds, including ' ||
           'anything issued to it later.';
end $$;

-- What one person can actually open, and why -- the answer to "I ticked it and
-- they still cannot see it", which is nearly always the company licence.
create or replace view user_access_v with (security_invoker = true) as
    select u.email, u.role, c.name as company,
           u.all_modules as follows_company_licence,
           m.key as module_key, m.name as module,
           (cm.module_key is not null) as company_licensed,
           (u.all_modules or m.is_core or um.module_key is not null) as account_granted,
           (cm.module_key is not null
            and (u.all_modules or m.is_core or um.module_key is not null)) as can_open
    from app_users u
    join companies c on c.id = u.company_id
    cross join modules m
    left join company_modules cm on cm.company_id = u.company_id and cm.module_key = m.key
    left join user_modules um on um.user_id = u.id and um.module_key = m.key;
