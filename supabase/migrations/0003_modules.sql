-- ============================================================================
-- Module catalog.
-- Generated from MODULE_CATALOG in modules/hrms/index.html so the database and
-- the browser cannot disagree about what a module is or what it needs.
-- ============================================================================
delete from module_requires; delete from modules;
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
  ('intelligence','AI & Integrations','Analytics & Insight','🧠',false,290,'No DomeBox sync, flight-risk scoring or WhatsApp assistant.');
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
  ('benefits','ess');

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
