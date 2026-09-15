-- ============================================================================
-- What each module key actually switches on
--
-- The app calls a screen "People"; the module that owns it is called
-- "core-hr". Two vocabularies, no map between them, and the only way to find
-- out was to ask. This puts the answer in the database.
--
-- Generated from the module catalog in the application. Safe to run twice.
-- ============================================================================

alter table modules add column if not exists screens text;

update modules m set screens = v.screens
from (values
    ('core-hr', 'Today at a glance, People, Add people, Who reports to whom, New joiner checklist, Probation, Settings'),
    ('ess', 'My details, My requests, Colleagues'),
    ('notices', 'Notice board, Write a notice'),
    ('workflows', 'workflows, Approvals'),
    ('audit', 'History of changes'),
    ('recruitment', 'Hiring'),
    ('documents', 'Documents'),
    ('letters', 'Letters'),
    ('attendance', 'Live attendance, Attendance register, Attendance corrections, Override attendance, My attendance, Fix my attendance, My calendar'),
    ('essl', 'Get attendance from the machine'),
    ('shifts', 'Shifts'),
    ('timesheets', 'Timesheets, My timesheet'),
    ('leave', 'Leave, My leave'),
    ('payroll', 'Run salary, Payslips, My payslips'),
    ('statutory', 'PF, ESI and tax rules, Form 16 and tax, My tax declarations'),
    ('compensation', 'Increment planning, Salary changes'),
    ('loans', 'Loans and advances'),
    ('expenses', 'Expense claims, My expenses'),
    ('travel', 'Travel, My travel'),
    ('ewa', 'Salary advance on demand'),
    ('performance', 'Goals and reviews, Praise and feedback, Who could step up, My goals'),
    ('learning', 'Courses'),
    ('engagement', 'Staff surveys, Surveys'),
    ('offboarding', 'People leaving'),
    ('assets', 'Company property'),
    ('helpdesk', 'Helpdesk, My tickets'),
    ('benefits', 'My insurance'),
    ('analytics', 'Charts and trends'),
    ('reports', 'Reports'),
    ('intelligence', 'DomeBox sync, Who might leave, WhatsApp')
) as v(key, screens)
where m.key = v.key;

-- The list to read when you are choosing keys. Search it for the word you know:
--     select * from module_keys_v where screens ilike '%payslip%';
create or replace view module_keys_v as
    select key         as module_key,
           name        as module_name,
           category,
           is_core     as always_on,
           screens     as screens_it_switches_on
    from modules
    order by sort, key;

grant select on module_keys_v to public;
