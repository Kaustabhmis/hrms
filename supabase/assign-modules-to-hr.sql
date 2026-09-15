-- ============================================================================
-- Give hr@dynamicengineers.in a specific set of modules
--
-- HOW TO RUN THIS IN THE SUPABASE SQL EDITOR
--
-- The editor shows you the result of the LAST statement only. So do not press
-- Run on the whole file and expect to see everything -- select one step with
-- the mouse and press Run, then the next. Each step below is one statement.
--
-- Needs setup.sql to have been run first.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- STEP 1  What are the module keys?
--
-- The app and the database use different words for the same thing. The screen
-- called "People" belongs to the module called core-hr; there is no module
-- named People. This is the map. Read it before choosing keys.
-- ---------------------------------------------------------------------------
select * from module_keys_v;

-- Looking for a particular screen? Search by the word you know:
--     select * from module_keys_v where screens_it_switches_on ilike '%payslip%';
--     select * from module_keys_v where screens_it_switches_on ilike '%People%';


-- ---------------------------------------------------------------------------
-- STEP 2  Does the account exist, and what does it hold now?
--
-- No rows means no account. Create the login first -- Logins & Access in the
-- HRMS, or Supabase -> Authentication -> Users -- then come back.
-- ---------------------------------------------------------------------------
select email, role, all_modules as follows_company_licence,
       (select count(*) from user_modules where user_id = app_users.id) as hand_picked
from app_users
where lower(email) = 'hr@dynamicengineers.in';


-- ---------------------------------------------------------------------------
-- STEP 3  Assign the modules.
--
-- The comma is at the START of each line on purpose. It means you can comment
-- a line out, or uncomment one, without ever having to fix the commas on the
-- lines around it. Only the first line has no comma, and it is a module HR
-- always needs anyway.
--
-- To remove something: put -- in front of its line.
-- To add something: take the -- off its line.
-- ---------------------------------------------------------------------------
select set_user_modules('hr@dynamicengineers.in', array[
     'core-hr'        -- People, Add people, Who reports to whom, Probation, Settings
    ,'ess'            -- their own details, requests and payslips
    ,'attendance'     -- the attendance register and live punches
    ,'essl'           -- pulling punches off the eSSL machine
    ,'shifts'         -- shift scheduling
    ,'leave'          -- the leave ledger and its rules
    ,'payroll'        -- running salary, payslips, salary revisions
    ,'statutory'      -- PF, ESI, PT, TDS and Form 16
    ,'expenses'       -- expense claims
    ,'loans'          -- loans and advances
    ,'documents'      -- the document centre
    ,'letters'        -- offer, appointment and experience letters
    ,'reports'        -- the report centre
    ,'helpdesk'       -- IT and HR tickets
    ,'workflows'      -- who approves what, and the approval inbox
    ,'notices'        -- the notice board
--  ,'audit'          -- who changed what
--  ,'recruitment'    -- hiring and the applicant tracker
--  ,'performance'    -- goals, appraisals, 9-box
--  ,'offboarding'    -- resignations, clearance, full & final
--  ,'analytics'      -- headcount and attrition charts
--  ,'timesheets'     -- project timesheets
--  ,'travel'         -- the travel desk
--  ,'assets'         -- company property issued to staff
--  ,'benefits'       -- medical cover
--  ,'compensation'   -- increment planning
--  ,'learning'       -- training and courses
--  ,'engagement'     -- staff surveys
--  ,'ewa'            -- salary advance on demand
--  ,'intelligence'   -- attrition prediction, DomeBox, WhatsApp
]);


-- ---------------------------------------------------------------------------
-- STEP 4  Check it. This is exactly what that account can open.
-- ---------------------------------------------------------------------------
select module, can_open
from user_access_v
where email = 'hr@dynamicengineers.in'
order by can_open desc, module;


-- ---------------------------------------------------------------------------
-- STEP 5  Something still missing? This says which of the two gates is shut.
--
-- Both must be open: the COMPANY has to be licensed for the module, and the
-- ACCOUNT has to be granted it.
--
--   company_licensed = f  -> the company does not hold it. Companies -> tick it,
--                            or use set_company_modules(...).
--   account_granted  = f  -> uncomment its line in STEP 3 and run that again.
-- ---------------------------------------------------------------------------
select module, company_licensed, account_granted
from user_access_v
where email = 'hr@dynamicengineers.in' and not can_open
order by company_licensed desc, module;


-- ============================================================================
-- Afterwards
--
-- * Back to "everything the company holds":
--       select grant_all_modules('hr@dynamicengineers.in');
--
-- * A per-person grant is overwritten if somebody changes this account's ROLE,
--   or re-runs set_role_modules(<company>,'hr',...). Set the person, then leave
--   the role alone.
--
-- * The same job without SQL: sign in as the owner, Logins & Access, open the
--   account, untick "Everything this company is licensed for", tick what you
--   want. It warns you what stops working before you save.
-- ============================================================================
