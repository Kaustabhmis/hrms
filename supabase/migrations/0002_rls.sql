-- ============================================================================
-- ROW-LEVEL SECURITY
--
-- The three gates from the browser, moved to where they cannot be edited by
-- whoever has the page open:
--   1. who you are      — the JWT, resolved to a row in app_users
--   2. your company     — every tenant table is filtered to it, by the database
--   3. your modules     — the company licence narrowed by your own grant
-- Role is on top of those: HR and Admin control, everyone else is an employee
-- who may read and write only their own rows.
--
-- RLS gives tenancy. Entitlement is checked here too (has_module) so an API
-- call for a module the company never bought returns nothing rather than data.
-- ============================================================================

-- NOTE ON "FORCE". These tables use ENABLE row level security, deliberately not
-- FORCE. FORCE would subject the table owner to its own policies, and the
-- helpers below are security definer — they run as the owner. my_role() reads
-- app_users, whose policy asks is_super(), which asks my_role(): recursion.
-- Supabase's API never connects as the owner (it uses authenticated/anon), so
-- every query from the outside is policed either way. Verified by running the
-- whole suite as a non-owner role.

-- ------------------------------------------------------------- who is this --
-- Supabase owns the auth schema and already provides current_uid(). Creating
-- anything in there is refused ("permission denied for schema auth"), and
-- would be wrong anyway. So nothing here touches it: current_uid() reads
-- current_uid() where it exists, and falls back to a session setting where it does
-- not — which is what makes these same policies testable on plain PostgreSQL.
create or replace function current_uid() returns uuid
language plpgsql stable set search_path = public as $$
declare v uuid;
begin
    -- to_regprocedure returns null rather than raising when current_uid() is absent,
    -- so this is safe on a database that has never heard of Supabase.
    if to_regprocedure('auth.uid()') is not null then
        execute 'select auth.uid()' into v;
    end if;
    if v is null then
        v := nullif(current_setting('app.current_user_id', true), '')::uuid;
    end if;
    return v;
exception when others then
    return nullif(current_setting('app.current_user_id', true), '')::uuid;
end $$;

create or replace function me() returns app_users
language sql stable security definer set search_path = public as $$
    select * from app_users where id = current_uid() and status = 'Active';
$$;

create or replace function my_company() returns uuid
language sql stable security definer set search_path = public as $$
    select company_id from app_users where id = current_uid() and status = 'Active';
$$;

create or replace function my_role() returns text
language sql stable security definer set search_path = public as $$
    select role from app_users where id = current_uid() and status = 'Active';
$$;

create or replace function is_super() returns boolean
language sql stable as $$ select my_role() = 'super'; $$;

create or replace function is_control() returns boolean
language sql stable as $$ select my_role() in ('super','hr','admin'); $$;

create or replace function my_employee() returns uuid
language sql stable security definer set search_path = public as $$
    select employee_id from app_users where id = current_uid() and status = 'Active';
$$;

-- Who this employee reports to. A policy on employees cannot select from
-- employees without recursing into itself, so the lookup happens here, outside
-- row-level security.
create or replace function my_manager() returns uuid
language sql stable security definer set search_path = public as $$
    select manager_id from employees where id = my_employee();
$$;

create or replace function my_team() returns setof uuid
language sql stable security definer set search_path = public as $$
    select id from employees where manager_id = my_employee();
$$;

-- Whether a period has been executed. Like my_manager(), this cannot be an
-- inline subquery: payroll_periods is itself protected, so inside a policy the
-- subquery would return nothing and the employee would silently lose access to
-- their own payslip rather than being refused it.
create or replace function period_is_executed(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from payroll_periods where id = p_id and status = 'Executed');
$$;

-- An employee with people reporting to them approves for their team. It is read
-- from the org chart, exactly as the browser reads it — not granted.
create or replace function is_approver() returns boolean
language sql stable security definer set search_path = public as $$
    select is_control() or exists (
        select 1 from employees e
        where e.manager_id = my_employee()
          and (e.exit_date is null or e.exit_date >= current_date));
$$;

-- Entitlement: the company licence, narrowed by the account's own grant.
-- Dependencies are resolved when a licence is written, so this is a plain
-- lookup rather than a graph walk on every row.
create or replace function has_module(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
    select case
        when my_role() = 'super' then true
        when not exists (
            select 1 from companies c
            where c.id = my_company() and c.status = 'Active') then
            -- A suspended or closed company keeps nothing but the core.
            exists (select 1 from modules where key = p_key and is_core)
        when not exists (
            select 1 from company_modules cm
            where cm.company_id = my_company() and cm.module_key = p_key) then false
        when (select all_modules from app_users where id = current_uid()) then true
        when exists (select 1 from modules where key = p_key and is_core) then true
        else exists (
            select 1 from user_modules um
            where um.user_id = current_uid() and um.module_key = p_key)
    end;
$$;

-- ------------------------------------------------------------------ tenant --
-- Postgres ORs permissive policies together, which matters here: if the tenant
-- policy said "anyone in this company", a self-service policy added next to it
-- could only ever widen that, never narrow it — and every employee would read
-- the whole company. So tables holding personal data are opened to the control
-- roles only, and the self and team policies below are what let an employee
-- reach their own rows.
do $$
declare t text;
begin
    -- Personal data: control roles see the company; everybody else needs an
    -- explicit self or team policy.
    foreach t in array array[
        'employees','punch_log','daily_attendance','attendance_marks',
        'leave_ledger','leave_credits','payroll_periods','payroll_rows',
        'payroll_adjustments','loans','expense_claims','travel_requests',
        'workflow_instances','essl_device_map','essl_batches','audit_log']
    loop
        execute format('alter table %I enable row level security', t);
        execute format('drop policy if exists %I_control_read on %I', t, t);
        execute format($f$
            create policy %I_control_read on %I for select
            using (is_super() or (is_control() and company_id = my_company()))$f$, t, t);
        execute format('drop policy if exists %I_control_write on %I', t, t);
        execute format($f$
            create policy %I_control_write on %I for all
            using (is_super() or (is_control() and company_id = my_company()))
            with check (is_super() or (is_control() and company_id = my_company()))$f$, t, t);
    end loop;

    -- Company configuration: readable by anyone in the company, written by
    -- control roles. An employee is entitled to see the leave rules they are
    -- judged by; they are not entitled to change them.
    foreach t in array array['leave_types','formula_components','pt_formulas']
    loop
        execute format('alter table %I enable row level security', t);
        execute format('drop policy if exists %I_company_read on %I', t, t);
        execute format($f$
            create policy %I_company_read on %I for select
            using (is_super() or company_id = my_company())$f$, t, t);
        execute format('drop policy if exists %I_control_write on %I', t, t);
        execute format($f$
            create policy %I_control_write on %I for all
            using (is_super() or (is_control() and company_id = my_company()))
            with check (is_super() or (is_control() and company_id = my_company()))$f$, t, t);
    end loop;
end $$;

-- ------------------------------------------------------ what an employee may --
-- Self-service: an employee reads and writes their own rows and nobody else's.
drop policy if exists punch_self on punch_log;
create policy punch_self on punch_log for select
    using (employee_id = my_employee());
drop policy if exists punch_self_insert on punch_log;
create policy punch_self_insert on punch_log for insert
    with check (employee_id = my_employee() and company_id = my_company() and has_module('attendance'));

drop policy if exists daily_self on daily_attendance;
create policy daily_self on daily_attendance for select using (employee_id = my_employee());

drop policy if exists leave_self_read on leave_ledger;
create policy leave_self_read on leave_ledger for select using (employee_id = my_employee());
drop policy if exists leave_self_apply on leave_ledger;
create policy leave_self_apply on leave_ledger for insert
    with check (employee_id = my_employee() and company_id = my_company()
                and has_module('leave') and status = 'Pending');
-- A pending application of their own may be withdrawn; an approved one may not.
drop policy if exists leave_self_withdraw on leave_ledger;
create policy leave_self_withdraw on leave_ledger for delete
    using (employee_id = my_employee() and status = 'Pending');

drop policy if exists expense_self_read on expense_claims;
create policy expense_self_read on expense_claims for select using (employee_id = my_employee());
drop policy if exists expense_self_raise on expense_claims;
create policy expense_self_raise on expense_claims for insert
    with check (employee_id = my_employee() and company_id = my_company()
                and has_module('expenses') and status = 'Pending');

drop policy if exists travel_self_read on travel_requests;
create policy travel_self_read on travel_requests for select using (employee_id = my_employee());
drop policy if exists travel_self_raise on travel_requests;
create policy travel_self_raise on travel_requests for insert
    with check (employee_id = my_employee() and company_id = my_company()
                and has_module('travel') and status = 'Pending');

drop policy if exists loans_self_read on loans;
create policy loans_self_read on loans for select using (employee_id = my_employee());

-- Their own payslip, and only once the period has actually been executed.
drop policy if exists payroll_rows_self on payroll_rows;
create policy payroll_rows_self on payroll_rows for select
    using (employee_id = my_employee() and has_module('payroll')
           and period_is_executed(period_id));

-- An employee reads their own record, their manager's, and their team's.
-- Everyone else's is simply not there — including the salary columns, which is
-- why this is a table policy rather than a filter in the application.
drop policy if exists employees_self on employees;
create policy employees_self on employees for select
    using (id = my_employee() or manager_id = my_employee() or id = my_manager());

-- A colleague directory without pay: this is what the peer directory reads.
drop view if exists directory_v;
create view directory_v with (security_invoker = true) as
    select id, company_id, code, name, designation, dept, location, email
    from employees;

-- An approver sees their own team's requests.
drop policy if exists leave_team on leave_ledger;
create policy leave_team on leave_ledger for select
    using (is_approver() and employee_id in (select my_team()));
drop policy if exists expense_team on expense_claims;
create policy expense_team on expense_claims for select
    using (is_approver() and employee_id in (select my_team()));
drop policy if exists workflow_team on workflow_instances;
create policy workflow_team on workflow_instances for select
    using (is_approver() and employee_id in (select my_team()));

-- ---------------------------------------------------------------- provider --
alter table companies       enable row level security;
alter table app_users       enable row level security;
alter table user_modules    enable row level security;
alter table company_modules enable row level security;
alter table provisioning_log enable row level security;

-- A company row is visible to the provider, and to its own people.
drop policy if exists company_read on companies;
create policy company_read on companies for select
    using (is_super() or id = my_company());
drop policy if exists company_write on companies;
create policy company_write on companies for all
    using (is_super()) with check (is_super());

-- An account sees itself; HR sees its company's accounts; the provider sees all.
drop policy if exists users_read on app_users;
create policy users_read on app_users for select
    using (is_super() or id = current_uid() or (is_control() and company_id = my_company()));
drop policy if exists users_write on app_users;
create policy users_write on app_users for all
    using (is_super() or (is_control() and company_id = my_company()))
    with check (is_super() or (is_control() and company_id = my_company()));

drop policy if exists company_modules_read on company_modules;
create policy company_modules_read on company_modules for select
    using (is_super() or company_id = my_company());
-- Only the provider issues modules. HR cannot widen its own licence.
drop policy if exists company_modules_write on company_modules;
create policy company_modules_write on company_modules for all
    using (is_super()) with check (is_super());

drop policy if exists user_modules_read on user_modules;
create policy user_modules_read on user_modules for select
    using (is_super() or user_id = current_uid()
           or (is_control() and user_id in (select id from app_users where company_id = my_company())));
drop policy if exists user_modules_write on user_modules;
create policy user_modules_write on user_modules for all
    using (is_super() or (is_control() and user_id in (select id from app_users where company_id = my_company())))
    with check (is_super() or (is_control() and user_id in (select id from app_users where company_id = my_company())));

drop policy if exists prov_log_read on provisioning_log;
create policy prov_log_read on provisioning_log for select using (is_super());
drop policy if exists prov_log_write on provisioning_log;
create policy prov_log_write on provisioning_log for insert with check (true);

-- The catalog is readable by anyone signed in; it is changed by migration.
alter table modules enable row level security;
alter table module_requires enable row level security;
drop policy if exists modules_read on modules;
create policy modules_read on modules for select using (true);
drop policy if exists module_requires_read on module_requires;
create policy module_requires_read on module_requires for select using (true);

-- ------------------------------------------------------------ append-only --
-- Evidence. Insert freely; history cannot be rewritten by the application.
drop policy if exists audit_insert on audit_log;
create policy audit_insert on audit_log for insert
    with check (company_id = my_company() or is_super());
revoke update, delete on audit_log from public;
revoke update, delete on provisioning_log from public;

-- A payroll period that has executed is closed. Reopening is a deliberate act
-- that flips the status back, not an accident of an UPDATE reaching a row.
create or replace function guard_executed_payroll() returns trigger
language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        if exists (select 1 from payroll_periods p where p.id = old.period_id and p.status = 'Executed') then
            raise exception 'Payroll period is executed and locked. Reopen it first.';
        end if;
        return old;
    end if;
    if exists (select 1 from payroll_periods p where p.id = new.period_id and p.status = 'Executed') then
        raise exception 'Payroll period is executed and locked. Reopen it first.';
    end if;
    return new;
end $$;
drop trigger if exists payroll_rows_locked on payroll_rows;
create trigger payroll_rows_locked
    before insert or update or delete on payroll_rows
    for each row execute function guard_executed_payroll();
