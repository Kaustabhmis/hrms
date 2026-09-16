-- ============================================================================
-- Assign modules to a whole role at once
--
-- The Supabase SQL Editor shows the result of the LAST statement only, so
-- select one step with the mouse and press Run, then the next -- do not run
-- the whole file and expect to see every answer.
--
-- Needs setup.sql to have been run first.
--
-- Not sure which key is which? The screen called "People" belongs to the
-- module called core-hr; there is no module named People. Run this for the map:
--     select * from module_keys_v;
--
-- The company licence is still the ceiling: naming a module the company does
-- not hold grants nothing, and the result line tells you which ones those were.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- WHICH COMPANY?
--
-- The scripts below use "the first company", which is right when you have one.
-- Run this to see what you have -- the code is whatever YOU typed when you
-- created it, not a value from this file:
--
--     select id, name, code from companies order by name;
--
-- With more than one company, replace the lookup with an explicit code:
--     (select id from companies where code = 'YOUR-CODE')
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. Which company? This picks yours by code -- your company is found automatically when you have one.
--    Run this on its own first if you want to see what you have.
-- ---------------------------------------------------------------------------
select id, name, code from companies order by name;

-- ---------------------------------------------------------------------------
-- 2. The rule for everybody on the employee role.
--
--    What an employee needs: their own profile, their attendance, leave,
--    payslips, expense claims and a way to raise a ticket. Not payroll setup,
--    not the directory of everybody's salary -- those are HR screens, and the
--    role gate stops them anyway, but a module they cannot use should not be
--    on their menu pretending otherwise.
-- ---------------------------------------------------------------------------
select set_role_modules(
    (select id from companies order by name limit 1),
    'employee',
    -- Comma at the START of each line, so commenting one out never breaks
    -- the lines around it.
    array[
         'ess'          -- their own profile, requests and payslips
        ,'attendance'   -- clocking in and their own register
        ,'leave'        -- applying for leave and seeing the balance
        ,'payroll'      -- so their payslip is visible to them
        ,'expenses'     -- claiming a bill back
        ,'helpdesk'     -- raising a problem
        ,'notices'      -- the notice board
--      ,'timesheets'   -- booking hours to projects
--      ,'travel'       -- asking to travel and claiming it back
--      ,'benefits'     -- their medical cover
--      ,'learning'     -- training and courses
--      ,'performance'  -- their own goals and review
    ]
);

-- ---------------------------------------------------------------------------
-- 3. The same idea for HR and Admin, if you want it. Leave these out if you
--    would rather set those two by hand -- they are few, and they differ.
-- ---------------------------------------------------------------------------
-- select set_role_modules(
--     (select id from companies order by name limit 1),
--     'hr',
--     array['core-hr','attendance','essl','shifts','leave','payroll','statutory',
--           'expenses','loans','documents','letters','reports','helpdesk','workflows']
-- );

-- ---------------------------------------------------------------------------
-- 4. Check it. The first shows the rule, the second shows what each account
--    actually ended up with.
-- ---------------------------------------------------------------------------
select * from role_modules_v;

select u.email, u.role, u.all_modules,
       count(um.module_key) as modules_granted
from app_users u
left join user_modules um on um.user_id = u.id
where u.company_id = (select id from companies order by name limit 1)
group by u.email, u.role, u.all_modules
order by u.role, u.email;

-- ============================================================================
-- Notes
--
-- * From now on every NEW account with that role gets these modules on
--   creation, and an account changed to that role gets them then. You do not
--   have to run this again for new hires.
--
-- * To set the rule for future hires WITHOUT changing anybody already set up,
--   pass false as the fourth argument:
--
--       select set_role_modules(<company>, 'employee', array[...], false);
--
-- * To put one person back on "everything the company holds", overriding the
--   rule for them alone:
--
--       update app_users set all_modules = true where email = 'name@company.com';
--       delete from user_modules where user_id =
--              (select id from app_users where email = 'name@company.com');
--
-- * To drop the rule entirely, so the role has no default again:
--
--       delete from role_modules
--       where company_id = (select id from companies order by name limit 1)
--         and role = 'employee';
-- ============================================================================
