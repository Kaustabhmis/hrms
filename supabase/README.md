# Backend — Supabase

The HRMS module runs with no backend at all, and still will. This is what it
uses when there is one.

The point is not storage. It is that **the three gates stop being decisions the
page makes and become decisions Postgres makes**. In browser-only mode the
access model is honest but unenforceable: anyone who can open the developer
console can grant themselves every module. With this in place, an account that
asks for another company's employees gets an empty list — not because the
application filtered them out, but because the database will not return them.

## What is here

```
migrations/0001_schema.sql    26 tables, money as numeric(14,2)
migrations/0002_rls.sql       row-level security, the three gates
migrations/0003_modules.sql   the module catalog, generated from the module itself
```

`0003` is generated from `MODULE_CATALOG` in `modules/hrms/index.html`, so the
database and the browser cannot disagree about what a module is or what it
requires. Regenerating it is part of adding a module, not an afterthought.

## Setting it up

1. Create a project at supabase.com. Pick a region — **Mumbai (ap-south-1)** if
   employee data should stay in India.
2. Run the three migrations in order, in the SQL editor or with the Supabase CLI:
   ```
   supabase db push
   ```
3. In the module: **Settings → Backend**, enter the project URL and the **anon**
   key, and press *Test connection*. It reports how many modules it can see,
   which confirms the migrations landed.
4. Create your accounts in Supabase Auth, then insert the matching `app_users`
   rows. `app_users.id` **is** the auth uid — that is what lets a JWT resolve to
   a row with no lookup table in between.

Use the anon key. It is designed to be public: row-level security is what
protects the data, not the key. **Never put the service-role key in a browser** —
it bypasses every policy. The settings screen refuses one that looks like it.

## How the gates work

| Gate | Where it lives |
|---|---|
| Who you are | `auth.uid()` → a row in `app_users`, via `me()` / `my_role()` |
| Your company | `company_id` on every tenant table, filtered by policy |
| Your modules | `has_module(key)` — the company licence, narrowed by your own grant |

Role sits on top: `is_control()` covers Super Admin, HR and Admin;
`is_approver()` adds an employee with people reporting to them, read from the
org chart exactly as the browser reads it.

### Two things that are easy to get wrong

**Permissive policies OR together.** A tenant policy saying "anyone in this
company" cannot be narrowed by adding a self-service policy next to it — it can
only be widened. Tables holding personal data are therefore opened to control
roles only, and employees reach their own rows through explicit `_self` and
`_team` policies. Getting this wrong is silent: every employee reads the whole
company and nothing looks broken.

**A policy cannot query its own table, and cannot see a protected one.** The
policy on `employees` looking up your manager recurses into itself; the policy
letting you read your payslip has to check `payroll_periods`, which is itself
closed to you, so the subquery returns nothing and you silently lose access to
your own payslip. Both go through `security definer` functions — `my_manager()`,
`my_team()`, `period_is_executed()` — which run outside RLS.

Both of these were found by testing the policies against a real database rather
than reading them, which is the only way they show up.

## Verifying it yourself

Everything above was checked against PostgreSQL 16 with two companies, five
accounts and a real executed payroll period. The policies are tested by setting
`app.current_user_id`, which `auth.uid()` falls back to when there is no JWT —
so the same policies can be exercised without an auth server:

```sql
set role app_user;
set app.current_user_id = '<the uid to test as>';
select count(*) from employees;
```

What that run showed:

| As | Result |
|---|---|
| DE HR | 2 employees, 0 Acme rows, has payroll |
| Acme HR | 1 employee, 0 DE rows, no payroll (not licensed), 0 DE payroll rows |
| Employee, no reports | herself and her manager; not an approver; her own payslip only |
| Employee with reports | approver, by the org chart |
| Super Admin | all 3 employees, both companies |

And the refusals:

| Attempt | Outcome |
|---|---|
| Employee creates an employee | refused by policy |
| Employee raises her own salary | 0 rows updated |
| Employee reads payroll adjustments | 0 rows |
| Employee applies for leave as somebody else | refused by policy |
| Employee widens the company licence | refused by policy |
| Employee rewrites the audit trail | 0 rows — update is revoked |
| Acme HR inserts into DE | refused by policy |
| Acme HR renames a DE employee | 0 rows updated |
| Anyone edits an executed payroll row | *"Payroll period is executed and locked. Reopen it first."* |

## What is deliberately not done yet

- **The module still reads its own collections.** The adapter (`modules/hrms/lib/supabase-adapter.js`)
  gives the module `read`/`insert`/`update`/`remove` against these tables and
  handles auth, but the ~89 in-memory collections are not yet routed through it.
  That migration is screen by screen — employees first, then attendance, then
  payroll — and the module keeps working throughout because the adapter falls
  back to local storage whenever a backend is not configured.
- **Passwords move to Supabase Auth** when you create the accounts there. The
  browser-side hashing stays only for the offline mode.
- **`app_users` rows are inserted by hand** at the moment. A trigger on
  `auth.users` to create them is the obvious next step.

I could not test against a live Supabase project — that needs your credentials.
Everything here was verified against stock PostgreSQL 16, which is what Supabase
runs; what remains untested is the hosted auth layer and the network path.
