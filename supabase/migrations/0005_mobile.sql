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

select 'Mobile backend ready' as step,
       (select count(*) from pg_policies where tablename = 'attendance_requests') as att_req_policies,
       (select count(*) from pg_policies where tablename = 'holidays') as holiday_policies,
       (select count(*) from pg_policies
        where tablename = 'leave_ledger' and cmd = 'UPDATE') as leave_decide_policies;
