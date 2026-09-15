-- ============================================================================
-- BISCS HRMS — complete Supabase setup, in one file
--
-- Paste the whole thing into the Supabase SQL Editor and run it once. It is
-- safe to run again: every statement is guarded, so re-running repairs rather
-- than breaks. The last thing it does is print a report telling you whether it
-- worked.
--
-- After this, two things are left, and both need your dashboard:
--   1. Authentication -> Users -> Add user   (your own login)
--   2. select bootstrap_owner('you@company.com','Your Company Ltd','YCL');
--
-- Generated from supabase/migrations/*.sql — edit those, not this.
-- ============================================================================

-- The guards below announce every "already exists, skipping", which on a fresh
-- database is a wall of noise around the one thing worth reading. Quiet until
-- the report at the end.
set client_min_messages = warning;






-- ############################################################################
-- 0001_schema.sql
-- ############################################################################
-- ============================================================================
-- BISCS HRMS — schema
--
-- One database, many companies. Every tenant table carries company_id and is
-- protected by row-level security (0002_rls.sql), so a bug in application code
-- cannot leak one company's people into another's screen — the database
-- refuses it.
--
-- Money is numeric(14,2) throughout. Never float: a payroll that drifts by a
-- rupee does not reconcile against the bank file.
-- ============================================================================

-- No extensions. gen_random_uuid() is core PostgreSQL from 13 onward, and
-- case-insensitive email is done with a lower() index rather than citext, so
-- this file needs no rights beyond creating its own tables.

-- ---------------------------------------------------------------- provider --
create table if not exists companies (
    id           uuid primary key default gen_random_uuid(),
    name         text        not null,
    code         text        not null unique,
    industry     text,
    status       text        not null default 'Active'
                 check (status in ('Active','Suspended','Closed')),
    plan         text        not null default 'Custom',
    seats        integer     not null default 0 check (seats >= 0),
    active_from  date,
    valid_till   date,
    contact      text,
    notes        text,
    created_at   timestamptz not null default now(),
    constraint licence_dates check (valid_till is null or active_from is null or valid_till >= active_from)
);

-- The catalog is data, not code, so a module can be added without a deploy.
create table if not exists modules (
    key       text primary key,
    name      text not null,
    category  text not null,
    icon      text,
    is_core   boolean not null default false,
    sort      integer not null default 0,
    impact    text
);
create table if not exists module_requires (
    module_key   text not null references modules(key) on delete cascade,
    requires_key text not null references modules(key) on delete cascade,
    primary key (module_key, requires_key),
    check (module_key <> requires_key)
);
create table if not exists company_modules (
    company_id uuid not null references companies(id) on delete cascade,
    module_key text not null references modules(key)  on delete cascade,
    primary key (company_id, module_key)
);

-- app_users mirrors auth.users. The id IS the Supabase auth uid, so a JWT maps
-- straight onto a row without a lookup table in between.
create table if not exists app_users (
    id           uuid primary key,
    email        text        not null,
    name         text        not null,
    role         text        not null default 'employee'
                 check (role in ('super','hr','admin','employee')),
    company_id   uuid        references companies(id) on delete cascade,
    employee_id  uuid,
    all_modules  boolean     not null default true,
    status       text        not null default 'Active' check (status in ('Active','Suspended')),
    last_sign_in timestamptz,
    created_at   timestamptz not null default now(),
    -- A provider account belongs to no company. Everybody else normally has
    -- one, but must be allowed not to: a fresh Supabase signup arrives before
    -- anyone has placed it, and an account that cannot be created cannot be
    -- placed either. An unplaced account sees nothing at all — has_module()
    -- refuses it and every tenant policy compares against a null company —
    -- so this is a harmless state, not a hole.
    constraint provider_has_no_company check (role <> 'super' or company_id is null)
);
create table if not exists user_modules (
    user_id    uuid not null references app_users(id) on delete cascade,
    module_key text not null references modules(key)  on delete cascade,
    primary key (user_id, module_key)
);

-- ------------------------------------------------------------------ people --
create table if not exists employees (
    id           uuid primary key default gen_random_uuid(),
    company_id   uuid not null references companies(id) on delete cascade,
    code         text not null,
    name         text not null,
    designation  text,
    dept         text,
    grade        text,
    manager_id   uuid references employees(id) on delete set null,
    emp_type     text,
    gender       text,
    father_name  text,
    dob          date,
    ctc          numeric(14,2) not null default 0 check (ctc >= 0),
    pan          text, uan text, esic_no text, bank text,
    doj          date, exit_date date,
    location     text,
    status       text not null default 'Confirmed',
    email        text,
    domebox      boolean not null default false,
    created_at   timestamptz not null default now(),
    unique (company_id, code),
    constraint not_own_manager check (manager_id is null or manager_id <> id),
    constraint left_after_joining check (exit_date is null or doj is null or exit_date >= doj)
);
-- Replace the stricter form on any database that already has it.
do $$ begin
    alter table app_users drop constraint if exists provider_has_no_company;
    alter table app_users add constraint provider_has_no_company
        check (role <> 'super' or company_id is null);
exception when others then null; end $$;

do $$ begin
    alter table app_users add constraint app_users_employee_fk
        foreign key (employee_id) references employees(id) on delete set null;
exception when duplicate_object then null; end $$;
create unique index if not exists idx_app_users_email_lower on app_users (lower(email));
create index if not exists idx_employees_company_id_dept on employees (company_id, dept);
create index if not exists idx_employees_company_id_manager_id on employees (company_id, manager_id);

-- -------------------------------------------------------------- attendance --
create table if not exists punch_log (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references companies(id) on delete cascade,
    employee_id uuid not null references employees(id) on delete cascade,
    punch_date  date not null,
    punch_time  time not null,
    direction   text not null check (direction in ('IN','OUT')),
    source      text not null default 'Web',
    site        text,
    entered_by  text,
    geo_status  text default 'off',
    lat         double precision, lng double precision,
    accuracy    double precision, fence text, distance numeric(10,2),
    simulated   boolean not null default false,
    created_at  timestamptz not null default now(),
    -- The same person cannot punch the same direction at the same instant
    -- twice, which is what makes re-importing an eSSL export safe.
    unique (employee_id, punch_date, punch_time, direction)
);
create index if not exists idx_punch_log_company_id_punch_date on punch_log (company_id, punch_date);

create table if not exists daily_attendance (
    company_id  uuid not null references companies(id) on delete cascade,
    employee_id uuid not null references employees(id) on delete cascade,
    work_date   date not null,
    in_time     time, out_time time,
    hours       numeric(6,2) not null default 0,
    source      text,
    punches     integer not null default 0,
    primary key (employee_id, work_date)
);
create table if not exists attendance_marks (          -- HR overrides
    company_id  uuid not null references companies(id) on delete cascade,
    employee_id uuid not null references employees(id) on delete cascade,
    work_date   date not null,
    mark        text not null,
    reason      text not null,
    set_by      text, set_at timestamptz not null default now(),
    primary key (employee_id, work_date)
);

-- ------------------------------------------------------------------- leave --
create table if not exists leave_types (
    id           uuid primary key default gen_random_uuid(),
    company_id   uuid not null references companies(id) on delete cascade,
    code         text not null,
    name         text not null,
    paid         boolean not null default true,
    annual_days  numeric(6,2) not null default 0,
    accrual      text not null default 'monthly',
    rules        jsonb not null default '{}'::jsonb,
    unique (company_id, code)
);
create table if not exists leave_ledger (
    id           uuid primary key default gen_random_uuid(),
    company_id   uuid not null references companies(id) on delete cascade,
    employee_id  uuid not null references employees(id) on delete cascade,
    code         text not null,
    from_date    date not null, to_date date not null,
    days         numeric(6,2) not null check (days > 0),
    status       text not null default 'Pending',
    reason       text, applied_on date, action_by text,
    created_at   timestamptz not null default now(),
    constraint leave_dates check (to_date >= from_date)
);
create table if not exists leave_credits (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references companies(id) on delete cascade,
    employee_id uuid not null references employees(id) on delete cascade,
    code        text not null,
    days        numeric(6,2) not null,
    kind        text not null,
    period      text, note text,
    posted_on   date not null default current_date
);

-- ----------------------------------------------------------------- payroll --
create table if not exists payroll_periods (
    id           uuid primary key default gen_random_uuid(),
    company_id   uuid not null references companies(id) on delete cascade,
    period       text not null,              -- YYYY-MM
    status       text not null default 'Draft' check (status in ('Draft','Computed','Executed')),
    executed_on  timestamptz, executed_by text,
    -- The inputs as they stood when the run executed. A payslip has to
    -- reproduce in five years, after every rate in STAT_CONFIG has moved.
    config_snapshot jsonb,
    unique (company_id, period)
);
create table if not exists payroll_rows (
    id            uuid primary key default gen_random_uuid(),
    period_id     uuid not null references payroll_periods(id) on delete cascade,
    company_id    uuid not null references companies(id) on delete cascade,
    employee_id   uuid not null references employees(id) on delete cascade,
    payable_days  numeric(6,2), lop_days numeric(6,2) not null default 0,
    gross_earned  numeric(14,2) not null default 0,
    total_earnings numeric(14,2) not null default 0,
    total_deductions numeric(14,2) not null default 0,
    net_pay       numeric(14,2) not null default 0,
    earnings      jsonb not null default '{}'::jsonb,
    deductions    jsonb not null default '{}'::jsonb,
    employer      jsonb not null default '{}'::jsonb,
    detail        jsonb not null default '{}'::jsonb,
    unique (period_id, employee_id)
);
create index if not exists idx_payroll_rows_company_id_employee_id on payroll_rows (company_id, employee_id);

-- Free lines HR adds for one person for one period.
create table if not exists payroll_adjustments (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references companies(id) on delete cascade,
    employee_id uuid not null references employees(id) on delete cascade,
    period      text not null,
    kind        text not null check (kind in ('earning','deduction')),
    label       text not null,
    amount      numeric(14,2) not null check (amount > 0),
    taxable     boolean not null default true,
    reason      text,
    created_by  text, created_at timestamptz not null default now()
);
create index if not exists idx_payroll_adjustments_company_id_period on payroll_adjustments (company_id, period);

create table if not exists formula_components (
    id         uuid primary key default gen_random_uuid(),
    company_id uuid not null references companies(id) on delete cascade,
    name       text not null,
    kind       text not null check (kind in ('earning','deduction')),
    expr       text not null,
    taxable    boolean not null default true,
    enabled    boolean not null default true,
    scope      text not null default 'all' check (scope in ('all','dept','employee')),
    target     text, notes text
);
create table if not exists pt_formulas (
    company_id uuid not null references companies(id) on delete cascade,
    state      text not null,
    expr       text not null,
    primary key (company_id, state)
);

create table if not exists loans (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references companies(id) on delete cascade,
    employee_id uuid not null references employees(id) on delete cascade,
    loan_type   text not null,
    principal   numeric(14,2) not null check (principal > 0),
    emi         numeric(14,2) not null check (emi > 0),
    months      integer not null check (months > 0),
    start_period text not null,
    status      text not null default 'Active',
    recovered   numeric(14,2) not null default 0
);
create table if not exists expense_claims (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references companies(id) on delete cascade,
    employee_id uuid not null references employees(id) on delete cascade,
    claim_date  date not null,
    category    text not null,
    amount      numeric(14,2) not null check (amount > 0),
    status      text not null default 'Pending',
    note        text
);
create table if not exists travel_requests (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references companies(id) on delete cascade,
    employee_id uuid not null references employees(id) on delete cascade,
    destination text not null,
    from_date   date not null, to_date date not null,
    cost        numeric(14,2) not null default 0,
    purpose     text, services text[],
    status      text not null default 'Pending',
    booked_on   date,
    constraint travel_dates check (to_date >= from_date)
);

-- --------------------------------------------------------------- workflows --
create table if not exists workflow_instances (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references companies(id) on delete cascade,
    wf_type     text not null,
    ref_id      text not null,
    employee_id uuid references employees(id) on delete cascade,
    summary     text,
    amount      numeric(14,2) not null default 0,
    raised_on   date not null default current_date,
    chain       jsonb not null default '[]'::jsonb,
    level       integer not null default 0,
    status      text not null default 'Pending',
    sla_hours   integer, breached boolean not null default false
);

-- ------------------------------------------------------------------- eSSL --
create table if not exists essl_device_map (
    company_id     uuid not null references companies(id) on delete cascade,
    device_user_id text not null,
    employee_id    uuid not null references employees(id) on delete cascade,
    primary key (company_id, device_user_id)
);
create table if not exists essl_batches (
    id           uuid primary key default gen_random_uuid(),
    company_id   uuid not null references companies(id) on delete cascade,
    source       text not null,
    punch_count  integer not null default 0,
    skipped      integer not null default 0,
    from_date    date, to_date date,
    imported_by  text, imported_at timestamptz not null default now()
);

-- ------------------------------------------------------------- append-only --
-- Both logs are evidence. Writes are allowed; changing history is not, and
-- 0002 revokes update and delete on them from every application role.
create table if not exists audit_log (
    id         bigserial primary key,
    company_id uuid references companies(id) on delete cascade,
    at         timestamptz not null default now(),
    actor      text, actor_role text,
    category   text, action text not null, detail text
);
create index if not exists idx_audit_log_company_id_at_desc on audit_log (company_id, at desc);

create table if not exists provisioning_log (
    id       bigserial primary key,
    at       timestamptz not null default now(),
    actor    text,
    event    text not null,
    subject  text,
    detail   text
);


-- ############################################################################
-- 0002_rls.sql
-- ############################################################################
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
        -- An account nobody has placed in a company yet holds nothing. Without
        -- this it would be handed the core modules and see empty screens; with
        -- it, it sees the truth, which is that it is not set up.
        when my_company() is null then false
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


-- ############################################################################
-- 0003_modules.sql
-- ############################################################################
-- ============================================================================
-- Module catalog.
-- Generated from MODULE_CATALOG in modules/hrms/index.html so the database and
-- the browser cannot disagree about what a module is or what it needs.
-- ============================================================================
-- Upsert, never delete-and-recreate. company_modules references modules with
-- on delete cascade, so a "delete from modules" here would silently unlicense
-- every company on the installation — a migration that is safe the first time
-- and catastrophic the second.
insert into modules(key,name,category,icon,is_core,sort,impact) values
  ('core-hr','Core HR & Org','Foundation','👥',true,0,null),
  ('ess','Employee Self-Service','Foundation','📱',true,10,null),
  ('notices','Notice Board','Foundation','📢',false,20,'No official notices can be published, and a declared holiday will not reach the calendar or move payable days.'),
  ('workflows','Approval Workflows','Foundation','🔀',false,30,'Requests have no approval chain: leave, expenses and timesheets clear without anyone signing them off.'),
  ('audit','Audit Trail','Foundation','🔍',false,40,'Nothing is written to the audit trail, so an inspection has no record of who executed, approved or exported what.'),
  ('recruitment','Recruitment (ATS)','Hire & Onboard','🎯',false,50,'No hiring pipeline, and candidates cannot be converted into employees.'),
  ('documents','Documents & e-Sign','Hire & Onboard','📁',false,60,'No document centre and no e-signature routing.'),
  ('letters','Letter Generator','Hire & Onboard','📜',false,70,'No offer, appointment or other HR letters can be generated.'),
  ('attendance','Time & Attendance','Time & Attendance','⏱️',false,80,'No punches, no register, no late marks and no overtime. Payroll has no muster to read.'),
  ('essl','eSSL / Biometric Import','Time & Attendance','🖥️',false,90,'Punches cannot be brought in from eSSL devices — every day has to be entered by hand.'),
  ('shifts','Shift Scheduling','Time & Attendance','📅',false,100,'No roster; everyone is assumed to be on the default shift.'),
  ('timesheets','Project Timesheets','Time & Attendance','⌛',false,110,'No project time is captured, so there is no billable value and no utilisation.'),
  ('leave','Leave Management','Time & Attendance','🌴',false,120,'Nobody can apply for leave, and an absence cannot be explained — it simply becomes loss of pay.'),
  ('payroll','Payroll Engine','Payroll & Compensation','💰',false,130,'No salary can be run and no payslip produced.'),
  ('statutory','Statutory & Tax','Payroll & Compensation','🏛️',false,140,'No PF, ESIC, professional tax or TDS configuration, and none of the statutory returns.'),
  ('compensation','Compensation Planning','Payroll & Compensation','💹',false,150,'No increment cycle, and a back-dated salary revision cannot generate arrears.'),
  ('loans','Loans & Advances','Payroll & Compensation','🏦',false,160,'Advances cannot be recovered from salary.'),
  ('expenses','Expense Claims','Payroll & Compensation','🧾',false,170,'No expense claims, and nothing is reimbursed with salary.'),
  ('travel','Travel Desk','Payroll & Compensation','✈️',false,180,'No travel requests and no travel desk.'),
  ('ewa','Earned Wage Access','Payroll & Compensation','💸',false,190,'No access to wages already earned in the running period.'),
  ('performance','Performance & Talent','Talent & Exit','📈',false,200,'No goals, reviews, 9-box placement or recognition.'),
  ('learning','Learning & Development','Talent & Exit','📚',false,210,'No course catalogue and no learning record.'),
  ('engagement','Engagement & Surveys','Talent & Exit','🌟',false,220,'No surveys and no eNPS.'),
  ('offboarding','Exit & Offboarding','Talent & Exit','👋',false,230,'No exit clearance and no full & final settlement.'),
  ('assets','Asset Inventory','Workplace','💻',false,240,'Company assets cannot be assigned, returned or recovered at exit.'),
  ('helpdesk','IT / HR Helpdesk','Workplace','🎫',false,250,'No IT or HR ticketing.'),
  ('benefits','Benefits & GMC','Workplace','🏥',false,260,'Employees cannot see their medical cover or benefits.'),
  ('analytics','People Analytics','Analytics & Insight','📊',false,270,'No people analytics — headcount, cost, tenure, attrition risk and the rest.'),
  ('reports','Report Center','Analytics & Insight','📈',false,280,'No report centre: no attendance or wage registers, and none of the factory returns.'),
  ('intelligence','AI & Integrations','Analytics & Insight','🧠',false,290,'No DomeBox sync, flight-risk scoring or WhatsApp assistant.')
on conflict (key) do update set
    name = excluded.name, category = excluded.category, icon = excluded.icon,
    is_core = excluded.is_core, sort = excluded.sort, impact = excluded.impact;

-- Dependencies are replaced wholesale, which is safe: nothing references them.
delete from module_requires;
insert into module_requires(module_key,requires_key) values
  ('recruitment','core-hr'),
  ('letters','core-hr'),
  ('attendance','ess'),
  ('essl','attendance'),
  ('shifts','attendance'),
  ('timesheets','ess'),
  ('leave','ess'),
  ('payroll','core-hr'),
  ('statutory','payroll'),
  ('compensation','core-hr'),
  ('loans','payroll'),
  ('expenses','ess'),
  ('travel','ess'),
  ('ewa','payroll'),
  ('performance','ess'),
  ('learning','ess'),
  ('engagement','ess'),
  ('offboarding','core-hr'),
  ('helpdesk','ess'),
  ('benefits','ess')
on conflict do nothing;

-- Resolving a licence: everything asked for, plus whatever those need, plus the
-- core. Written once when a licence is saved so has_module() stays a lookup.
create or replace function resolve_modules(p_keys text[]) returns text[]
language plpgsql stable as $$
declare result text[]; before int; 
begin
    select array_agg(key) into result from modules where is_core or key = any(p_keys);
    loop
        before := coalesce(array_length(result,1),0);
        select array_agg(distinct k) into result from (
            select unnest(result) as k
            union
            select mr.requires_key from module_requires mr where mr.module_key = any(result)
        ) x;
        exit when coalesce(array_length(result,1),0) = before;
    end loop;
    return result;
end $$;

create or replace function set_company_modules(p_company uuid, p_keys text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
    delete from company_modules where company_id = p_company;
    insert into company_modules(company_id, module_key)
        select p_company, unnest(resolve_modules(p_keys));
end $$;


-- ############################################################################
-- 0004_auth_link.sql
-- ############################################################################
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
    v_role    text;
    v_company uuid;
    v_name    text;
begin
    -- Everything in here is defensive on purpose. A trigger on auth.users that
    -- raises does not merely fail itself: it aborts the signup, and the only
    -- symptom Supabase shows is "Database error creating new user". Locking
    -- somebody out of creating accounts is far worse than failing to file one
    -- neatly, so nothing below is allowed to throw.
    v_role := coalesce(new.raw_user_meta_data->>'role', 'employee');
    if v_role not in ('super','hr','admin','employee') then v_role := 'employee'; end if;
    v_name := coalesce(nullif(new.raw_user_meta_data->>'name',''), split_part(new.email,'@',1));
    -- A company_id that is not a uuid must not take the signup down with it.
    begin
        v_company := nullif(new.raw_user_meta_data->>'company_id','')::uuid;
    exception when others then
        v_company := null;
    end;
    -- A provider account has no company; anyone else must have one, so an
    -- invite that forgets it lands as an unplaced employee rather than failing.
    if v_role = 'super' then v_company := null; end if;
    if v_role <> 'super' and v_company is null then
        insert into provisioning_log(actor, event, subject, detail)
        values ('auth trigger','Account created without a company', new.email,
                'Signed up with no company_id in metadata. Place it in Users & Access before it can see anything.');
    end if;

    begin
        insert into app_users (id, email, name, role, company_id, all_modules, status)
        values (new.id, new.email, v_name, v_role, v_company, true, 'Active')
        on conflict (id) do nothing;

        insert into provisioning_log(actor, event, subject, detail)
        values ('auth trigger', 'Account created', new.email, v_role ||
                coalesce(' · ' || (select name from companies where id = v_company), ' · unplaced'));
    exception when others then
        -- Record why and let the signup through. The account exists in Auth and
        -- can be given its app_users row from Users & Access.
        begin
            insert into provisioning_log(actor, event, subject, detail)
            values ('auth trigger', 'Could not file new account', new.email, sqlerrm);
        exception when others then null; end;
    end;
    return new;
end $$;

-- Supabase owns auth.users; this attaches to it without modifying it.
do $$
begin
    if to_regclass('auth.users') is not null then
        begin
            drop trigger if exists on_auth_user_created on auth.users;
            create trigger on_auth_user_created
                after insert on auth.users
                for each row execute function handle_new_auth_user();
        exception when insufficient_privilege then
            raise warning 'Could not attach the trigger to auth.users (permission denied). Everything else is set up; create accounts from Users & Access in the HRMS, or run just this trigger as a role with rights on the auth schema.';
        end;
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
    if to_regclass('auth.users') is not null then
        begin
            drop trigger if exists on_auth_user_email on auth.users;
            create trigger on_auth_user_email
                after update of email on auth.users
                for each row execute function handle_auth_user_email();
        exception when insufficient_privilege then
            null;   -- the first warning already said it; one is enough
        end;
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
language sql stable security definer set search_path = public as $$
    select key from modules where has_module(key);
$$;

-- ############################################################################
-- 0005_mobile.sql
-- ############################################################################
-- ============================================================================
-- What the employee phone app needs
--
-- Two gaps stood between the browser and a phone in somebody's hand:
--
--   1. There was nowhere to put an on-duty claim or a forgotten punch. Leave,
--      expenses and travel each had a table; attendance requests did not, and
--      they are the two things a factory worker raises most.
--
--   2. An approver could read their team's requests and could not answer them.
--      Every policy on leave_ledger and workflow_instances was select-only, so
--      approving from a phone would have failed silently at the database.
--
-- Safe to run twice, and safe to run on a database that already holds data.
-- ============================================================================

create table if not exists attendance_requests (
    id           uuid primary key default gen_random_uuid(),
    company_id   uuid not null references companies(id) on delete cascade,
    employee_id  uuid not null references employees(id) on delete cascade,
    kind         text not null check (kind in ('OD','ForgotPunch','Regularise')),
    from_date    date not null,
    to_date      date not null,
    -- Only a forgotten punch carries times; an on-duty claim covers whole days.
    in_time      time,
    out_time     time,
    place        text,
    reason       text not null,
    status       text not null default 'Pending'
                 check (status in ('Pending','Approved','Rejected','Withdrawn')),
    raised_on    timestamptz not null default now(),
    decided_by   text,
    decided_at   timestamptz,
    decision_note text,
    -- Where the phone was when it was raised, when the phone offered to say.
    lat          double precision,
    lng          double precision,
    constraint att_req_dates check (to_date >= from_date),
    constraint forgot_punch_needs_a_time
        check (kind <> 'ForgotPunch' or in_time is not null or out_time is not null)
);
create index if not exists idx_att_req_company_status
    on attendance_requests (company_id, status);
create index if not exists idx_att_req_employee
    on attendance_requests (employee_id, from_date);

alter table attendance_requests enable row level security;

-- The person raises their own, reads their own, and may take back one that
-- nobody has answered yet.
drop policy if exists att_req_self_read on attendance_requests;
create policy att_req_self_read on attendance_requests for select
    using (employee_id = my_employee());

drop policy if exists att_req_self_raise on attendance_requests;
create policy att_req_self_raise on attendance_requests for insert
    with check (employee_id = my_employee() and company_id = my_company()
                and has_module('attendance') and status = 'Pending');

drop policy if exists att_req_self_withdraw on attendance_requests;
create policy att_req_self_withdraw on attendance_requests for delete
    using (employee_id = my_employee() and status = 'Pending');

-- The approver sees their own team's, and HR sees the company's.
drop policy if exists att_req_team_read on attendance_requests;
create policy att_req_team_read on attendance_requests for select
    using ((is_control() and company_id = my_company())
           or (is_approver() and employee_id in (select my_team())));

-- ...and can answer them. This is the half that was missing: an inbox you can
-- read and not act on is not an inbox.
drop policy if exists att_req_team_decide on attendance_requests;
create policy att_req_team_decide on attendance_requests for update
    using ((is_control() and company_id = my_company())
           or (is_approver() and employee_id in (select my_team())))
    with check ((is_control() and company_id = my_company())
           or (is_approver() and employee_id in (select my_team())));

-- Same for leave: the team policy could read an application and never answer it.
drop policy if exists leave_team_decide on leave_ledger;
create policy leave_team_decide on leave_ledger for update
    using ((is_control() and company_id = my_company())
           or (is_approver() and employee_id in (select my_team())))
    with check ((is_control() and company_id = my_company())
           or (is_approver() and employee_id in (select my_team())));

drop policy if exists workflow_team_decide on workflow_instances;
create policy workflow_team_decide on workflow_instances for update
    using ((is_control() and company_id = my_company())
           or (is_approver() and employee_id in (select my_team())))
    with check ((is_control() and company_id = my_company())
           or (is_approver() and employee_id in (select my_team())));

-- An employee needs the holiday list on their phone, so it has to live in the
-- database rather than in one browser's storage.
create table if not exists holidays (
    company_id  uuid not null references companies(id) on delete cascade,
    holiday_date date not null,
    name        text not null,
    kind        text not null default 'Company',
    primary key (company_id, holiday_date)
);
alter table holidays enable row level security;
drop policy if exists holidays_read on holidays;
create policy holidays_read on holidays for select
    using (is_super() or company_id = my_company());
drop policy if exists holidays_write on holidays;
create policy holidays_write on holidays for all
    using (is_super() or (is_control() and company_id = my_company()))
    with check (is_super() or (is_control() and company_id = my_company()));

-- Whether this account is an approver, asked from the phone so the app can show
-- or hide the approvals tab without guessing from a job title.
create or replace function am_i_an_approver() returns boolean
language sql stable security definer set search_path = public as $$
    select is_approver();
$$;

-- What the phone needs at sign-in, in one round trip instead of five.
create or replace function my_day(p_date date default current_date)
returns table (
    employee_id uuid, employee_code text, employee_name text,
    punches     jsonb,
    is_holiday  boolean, holiday_name text,
    approver    boolean
)
language sql stable security definer set search_path = public as $$
    select e.id, e.code, e.name,
           coalesce((select jsonb_agg(jsonb_build_object(
                        'time', p.punch_time, 'direction', p.direction, 'source', p.source)
                        order by p.punch_time)
                     from punch_log p
                     where p.employee_id = e.id and p.punch_date = p_date), '[]'::jsonb),
           exists (select 1 from holidays h
                   where h.company_id = e.company_id and h.holiday_date = p_date),
           (select h.name from holidays h
            where h.company_id = e.company_id and h.holiday_date = p_date),
           is_approver()
    from employees e
    where e.id = my_employee();
$$;


-- ############################################################################
-- Did it work?
--
-- Two reports, because the two places you might run this show different things.
-- psql prints the NOTICE block; the Supabase SQL Editor shows only result sets,
-- so the SELECT at the very end is the one you will see there.
-- ############################################################################
do $$
declare
    v_tables   int; v_policies int; v_modules int; v_deps int;
    v_rls_off  text; v_auth text;
begin
    select count(*) into v_tables   from information_schema.tables where table_schema='public';
    select count(*) into v_policies from pg_policies where schemaname='public';
    select count(*) into v_modules  from modules;
    select count(*) into v_deps     from module_requires;

    -- Any table holding company data that is NOT protected is the one thing
    -- that must never pass quietly.
    select string_agg(c.relname, ', ') into v_rls_off
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and c.relkind='r' and not c.relrowsecurity
      and exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name=c.relname and column_name='company_id');

    -- to_regclass rather than information_schema: the latter hides objects the
    -- current role cannot read, which reported auth.users as absent when it was
    -- merely not ours to read.
    select case when to_regclass('auth.users') is not null
           then 'linked to Supabase Auth'
           else 'auth.users not present (running outside Supabase)' end into v_auth;

    set local client_min_messages = notice;
    raise notice '';
    raise notice '===========================================================';
    raise notice ' BISCS HRMS — setup report';
    raise notice '===========================================================';
    raise notice ' tables        : %', v_tables;
    raise notice ' policies      : %', v_policies;
    raise notice ' modules       : % (with % dependencies)', v_modules, v_deps;
    raise notice ' auth          : %', v_auth;
    if v_rls_off is null then
        raise notice ' tenant tables : all protected by row-level security';
    else
        raise warning ' UNPROTECTED   : %  <-- this must not happen, tell whoever set this up', v_rls_off;
    end if;
    raise notice '';
    if v_modules = 30 and v_rls_off is null then
        raise notice ' Looks right. Next:';
        raise notice '   1. Authentication -> Users -> Add user (tick Auto Confirm)';
        raise notice '   2. select bootstrap_owner(''you@company.com'',''Your Company Ltd'',''YCL'');';
        raise notice '   3. In the HRMS: Settings -> Backend -> project URL + anon key';
    else
        raise warning ' Something is off — expected 30 modules and no unprotected tables.';
    end if;
    raise notice '===========================================================';
end $$;

with checks as (
    select 1 as ord, 'Tables' as what,
           (select count(*)::text from information_schema.tables where table_schema='public') as found,
           '29' as expected
    union all
    select 2, 'Row-level security policies',
           (select count(*)::text from pg_policies where schemaname='public'), '76'
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
    select 8, 'Phone app tables (requests, holidays)',
           (select count(*)::text from information_schema.tables
            where table_schema='public'
              and table_name in ('attendance_requests','holidays')), '2'
    union all
    select 9, 'Approvers can answer, not just read',
           (select count(*)::text from pg_policies
            where schemaname='public' and cmd='UPDATE'
              and policyname in ('att_req_team_decide','leave_team_decide','workflow_team_decide')), '3'
    union all
    select 10, 'Companies set up so far',
           (select count(*)::text from companies), 'any'
    union all
    select 11, 'Accounts set up so far',
           (select count(*)::text from app_users), 'any'
)
select
    case when found = expected or expected = 'any' then 'OK' else 'CHECK THIS' end as status,
    what,
    found,
    case when expected = 'any' then '' else 'expected ' || expected end as note
from checks order by ord;
