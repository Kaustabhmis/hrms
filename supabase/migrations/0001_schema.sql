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
    -- A provider account belongs to no company; everyone else must have one.
    constraint provider_has_no_company check (
        (role = 'super' and company_id is null) or (role <> 'super' and company_id is not null))
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
