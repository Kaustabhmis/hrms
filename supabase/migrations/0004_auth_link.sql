-- ============================================================================
-- Linking Supabase Auth to app_users
--
-- app_users.id IS the auth uid, which is what lets a JWT resolve to a row with
-- no lookup table in between. Keeping the two in step by hand is the step
-- everybody gets wrong, so it happens automatically instead.
--
-- Creating a user in Supabase Auth (dashboard, invite, or signUp) now creates
-- the matching app_users row. Role, company and modules come from the invite
-- metadata if they were set, and otherwise default to an employee with no
-- company — which can see nothing at all until somebody places them.
-- ============================================================================

create or replace function handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
    v_role    text := coalesce(new.raw_user_meta_data->>'role', 'employee');
    v_company uuid := nullif(new.raw_user_meta_data->>'company_id','')::uuid;
    v_name    text := coalesce(nullif(new.raw_user_meta_data->>'name',''), split_part(new.email,'@',1));
begin
    if v_role not in ('super','hr','admin','employee') then v_role := 'employee'; end if;
    -- A provider account has no company; anyone else must have one, so an
    -- invite that forgets it lands as an unplaced employee rather than failing.
    if v_role = 'super' then v_company := null; end if;
    if v_role <> 'super' and v_company is null then
        insert into provisioning_log(actor, event, subject, detail)
        values ('auth trigger','Account created without a company', new.email,
                'Signed up with no company_id in metadata. Place it in Users & Access before it can see anything.');
    end if;

    insert into app_users (id, email, name, role, company_id, all_modules, status)
    values (new.id, new.email, v_name, v_role, v_company, true, 'Active')
    on conflict (id) do nothing;

    insert into provisioning_log(actor, event, subject, detail)
    values ('auth trigger', 'Account created', new.email, v_role ||
            coalesce(' · ' || (select name from companies where id = v_company), ' · unplaced'));
    return new;
end $$;

-- Supabase owns auth.users; this attaches to it without modifying it.
do $$
begin
    if exists (select 1 from information_schema.tables
               where table_schema='auth' and table_name='users') then
        drop trigger if exists on_auth_user_created on auth.users;
        create trigger on_auth_user_created
            after insert on auth.users
            for each row execute function handle_new_auth_user();
    else
        raise notice 'auth.users not present — running outside Supabase, trigger skipped.';
    end if;
end $$;

-- Keep the email in step if it is changed in Auth.
create or replace function handle_auth_user_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    update app_users set email = new.email where id = new.id and email is distinct from new.email;
    return new;
end $$;
do $$
begin
    if exists (select 1 from information_schema.tables
               where table_schema='auth' and table_name='users') then
        drop trigger if exists on_auth_user_email on auth.users;
        create trigger on_auth_user_email
            after update of email on auth.users
            for each row execute function handle_auth_user_email();
    end if;
end $$;

-- ----------------------------------------------------------------------------
-- Bootstrap: the first company and the first super admin.
--
-- Run this once, after creating your own login in Supabase Auth. It is written
-- to be safe to run twice.
-- ----------------------------------------------------------------------------
create or replace function bootstrap_owner(p_email text, p_company_name text, p_company_code text)
returns text
language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_company uuid;
begin
    select id into v_uid from app_users where email = p_email;
    if v_uid is null then
        return 'No account for ' || p_email || '. Create the login in Supabase Auth first, then run this again.';
    end if;

    select id into v_company from companies where code = p_company_code;
    if v_company is null then
        insert into companies(name, code, status, plan, seats, active_from, valid_till, contact)
        values (p_company_name, p_company_code, 'Active', 'Enterprise', 250,
                current_date, current_date + interval '1 year', p_email)
        returning id into v_company;
        perform set_company_modules(v_company, (select array_agg(key) from modules));
    end if;

    update app_users set role = 'super', company_id = null, all_modules = true, status = 'Active'
    where id = v_uid;

    insert into provisioning_log(actor, event, subject, detail)
    values (p_email, 'Bootstrapped', p_email, 'Super admin, and ' || p_company_name || ' created with every module');
    return 'Done. ' || p_email || ' is the super admin; ' || p_company_name ||
           ' (' || p_company_code || ') holds all ' ||
           (select count(*) from company_modules where company_id = v_company) || ' modules.';
end $$;

-- What this account may open, so the browser asks the database rather than
-- deciding for itself.
create or replace function my_modules() returns setof text
language sql stable security definer set search_path = public, auth as $$
    select key from modules where has_module(key);
$$;
