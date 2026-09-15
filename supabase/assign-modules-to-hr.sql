-- ============================================================================
-- Give hr@dynamicengineers.in a specific set of modules
--
-- Paste into the Supabase SQL Editor and run. Needs setup.sql to have been run
-- first (it carries set_user_modules).
--
-- Run the whole file: the last two queries tell you whether it worked and, if
-- something is still missing, which of the two gates is stopping it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Does the account exist, and what does it hold now?
--    If this returns no rows, create the login first -- Logins & Access in the
--    HRMS, or Supabase -> Authentication -> Users.
-- ---------------------------------------------------------------------------
select email, role, all_modules as follows_company_licence,
       (select count(*) from user_modules where user_id = app_users.id) as hand_picked
from app_users
where lower(email) = 'hr@dynamicengineers.in';

-- ---------------------------------------------------------------------------
-- 2. The modules themselves.
--
--    This list is what an HR manager running a factory actually needs: the
--    people, the muster, the leave ledger, the payroll and what the law wants
--    out of it, plus the paperwork. Add or remove lines to taste -- the full
--    list of keys is in step 4 below.
--
--    'ess' is in there on purpose. HR is an employee too: they clock in, take
--    leave and are paid, and without it their own self-service disappears.
-- ---------------------------------------------------------------------------
select set_user_modules('hr@dynamicengineers.in', array[
    'core-hr',      -- the people, the org chart, bulk import
    'ess',          -- their own attendance, leave and payslips
    'attendance',   -- the muster and the register
    'essl',         -- pulling punches off the eSSL machine
    'shifts',       -- who works which shift
    'leave',        -- the leave ledger and its rules
    'payroll',      -- running salary
    'statutory',    -- PF, ESI, PT and TDS
    'expenses',     -- expense claims
    'loans',        -- advances and recovery
    'documents',    -- files against a person
    'letters',      -- offer, appointment and experience letters
    'reports',      -- the report centre
    'helpdesk',     -- tickets
    'workflows',    -- who approves what
    'notices'       -- the notice board
    -- 'audit',         -- uncomment to let HR see who changed what
    -- 'recruitment',   -- uncomment if this HR also hires
    -- 'performance',   -- uncomment for appraisals
    -- 'offboarding',   -- uncomment for exits and full & final
    -- 'analytics'      -- uncomment for the charts
]);

-- ---------------------------------------------------------------------------
-- 3. Did it work? This is what that account can open, and nothing else.
-- ---------------------------------------------------------------------------
select module, can_open
from user_access_v
where email = 'hr@dynamicengineers.in'
order by can_open desc, module;

-- ---------------------------------------------------------------------------
-- 4. If something you ticked is still not showing, this says why. There are
--    two gates and both must be open: the COMPANY has to be licensed for the
--    module, and the ACCOUNT has to be granted it.
-- ---------------------------------------------------------------------------
select module, company_licensed, account_granted, can_open
from user_access_v
where email = 'hr@dynamicengineers.in'
  and not can_open
order by company_licensed desc, module;
--  company_licensed = f  -> issue the module to the company first:
--      Companies -> the company -> tick it. Or:
--      select set_company_modules((select id from companies where code='DEPL'),
--             array['recruitment', ... every key the company should hold ...]);
--  account_granted  = f  -> add the key to the array in step 2 and re-run.

-- ============================================================================
-- Afterwards
--
-- * To put this account back on "everything the company holds":
--       select grant_all_modules('hr@dynamicengineers.in');
--
-- * Careful: a per-person grant is overwritten if somebody changes this
--   account's ROLE, or re-runs set_role_modules(<company>,'hr',...). Both
--   reapply the role rule. Set the person, then leave the role alone.
--
-- * The same thing without SQL: sign in as the owner, Logins & Access, open
--   the account, untick "Everything this company is licensed for", tick what
--   you want. It warns you what stops working before you save.
-- ============================================================================
