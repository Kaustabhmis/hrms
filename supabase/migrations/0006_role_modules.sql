-- ============================================================================
-- Modules by role, not one account at a time
--
-- Until now entitlement was set per person: tick the modules, save, repeat for
-- the next hire. That does not survive a factory. What a company actually has
-- is a rule -- "an employee gets self-service, attendance, leave and payslips"
-- -- and every employee should follow it, including the ones hired next month.
--
-- So the rule is stored, applied to everyone who already holds that role, and
-- applied again automatically to every account created afterwards.
--
-- The company licence is still the ceiling. A role default naming a module the
-- company does not hold grants nothing: has_module() checks the licence first.
-- Safe to run twice.
-- ============================================================================

create table if not exists role_modules (
    company_id uuid not null references companies(id) on delete cascade,
    role       text not null check (role in ('hr','admin','employee')),
    module_key text not null references modules(key) on delete cascade,
    primary key (company_id, role, module_key)
);
alter table role_modules enable row level security;

drop policy if exists role_modules_read on role_modules;
create policy role_modules_read on role_modules for select
    using (is_super() or company_id = my_company());
drop policy if exists role_modules_write on role_modules;
create policy role_modules_write on role_modules for all
    using (is_super() or (is_control() and company_id = my_company()))
    with check (is_super() or (is_control() and company_id = my_company()));

-- ----------------------------------------------------------------------------
-- Set the rule for a role, and bring everyone already holding it into line.
--
-- p_apply = false stores the rule for future hires without touching anybody
-- who is already set up, which is what you want if people have been given
-- exceptions by hand.
-- ----------------------------------------------------------------------------
create or replace function set_role_modules(
        p_company uuid, p_role text, p_keys text[], p_apply boolean default true)
returns text
language plpgsql security definer set search_path = public as $$
declare
    v_keys    text[];
    v_people  int := 0;
    v_missing text[];
begin
    if p_role not in ('hr','admin','employee') then
        return 'Role must be hr, admin or employee. A provider account holds everything by definition.';
    end if;
    if not exists (select 1 from companies where id = p_company) then
        return 'No company with that id.';
    end if;

    -- Dependencies come along, and the core modules are always there.
    v_keys := resolve_modules(coalesce(p_keys, '{}'));

    -- Naming a module the company is not licensed for is not an error, but it
    -- grants nothing, and saying so beats wondering later why it did not work.
    select array_agg(k) into v_missing from (
        select unnest(v_keys) as k
        except
        select module_key from company_modules where company_id = p_company) x;

    delete from role_modules where company_id = p_company and role = p_role;
    insert into role_modules (company_id, role, module_key)
        select p_company, p_role, unnest(v_keys)
        on conflict do nothing;

    if p_apply then
        update app_users set all_modules = false
        where company_id = p_company and role = p_role;

        delete from user_modules
        where user_id in (select id from app_users
                          where company_id = p_company and role = p_role);

        insert into user_modules (user_id, module_key)
            select u.id, m.k
            from app_users u
            cross join (select unnest(v_keys) as k) m
            where u.company_id = p_company and u.role = p_role
            on conflict do nothing;

        select count(*) into v_people from app_users
        where company_id = p_company and role = p_role;
    end if;

    return 'Rule saved: ' || p_role || ' gets ' || coalesce(array_length(v_keys,1),0) ||
           ' module(s)' ||
           case when p_apply then ', applied to ' || v_people || ' account(s)'
                else ' (existing accounts left alone)' end ||
           case when v_missing is not null
                then '. Not licensed to this company, so granted nothing: ' ||
                     array_to_string(v_missing, ', ')
                else '' end;
end $$;

-- ----------------------------------------------------------------------------
-- New accounts follow the rule without anybody remembering to apply it.
--
-- Two triggers rather than one, and deliberately: the BEFORE trigger changes
-- the row being written, the AFTER trigger writes a different table. Doing both
-- in one AFTER trigger would mean updating app_users from a trigger on
-- app_users, which is how a recursion gets built by accident.
-- ----------------------------------------------------------------------------
create or replace function role_modules_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if new.company_id is not null and new.role in ('hr','admin','employee')
       and exists (select 1 from role_modules
                   where company_id = new.company_id and role = new.role) then
        new.all_modules := false;
    end if;
    return new;
end $$;

create or replace function role_modules_after() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if new.company_id is null or new.role not in ('hr','admin','employee') then
        return new;
    end if;
    if not exists (select 1 from role_modules
                   where company_id = new.company_id and role = new.role) then
        return new;
    end if;
    delete from user_modules where user_id = new.id;
    insert into user_modules (user_id, module_key)
        select new.id, module_key from role_modules
        where company_id = new.company_id and role = new.role
        on conflict do nothing;
    return new;
end $$;

drop trigger if exists app_users_role_modules_before on app_users;
create trigger app_users_role_modules_before
    before insert or update of role, company_id on app_users
    for each row execute function role_modules_before();

drop trigger if exists app_users_role_modules_after on app_users;
create trigger app_users_role_modules_after
    after insert or update of role, company_id on app_users
    for each row execute function role_modules_after();

-- ----------------------------------------------------------------------------
-- What each role is set to, in one readable list.
-- ----------------------------------------------------------------------------
create or replace view role_modules_v with (security_invoker = true) as
    select c.name as company, rm.role,
           count(*) as modules,
           string_agg(m.name, ', ' order by m.sort) as module_list
    from role_modules rm
    join companies c on c.id = rm.company_id
    join modules m on m.key = rm.module_key
    group by c.name, rm.role;
