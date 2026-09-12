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
migrations/0004_auth_link.sql auth.users -> app_users, and the one-time bootstrap
setup.sql                     all four in one paste, with a report at the end
```

`0003` is generated from `MODULE_CATALOG` in `modules/hrms/index.html`, so the
database and the browser cannot disagree about what a module is or what it
requires. Regenerating it is part of adding a module, not an afterthought.

## Connecting it — the whole thing, once

### 1. Make a project

At [supabase.com](https://supabase.com), **New project**. Pick a region:
**Mumbai (ap-south-1)** if employee data should stay in India. Note the database
password somewhere — you will not be shown it again.

### 2. Run the setup

**Dashboard → SQL Editor → New query.** Paste **`supabase/setup.sql`** — the
whole file, one paste — and run it.

It ends by telling you whether it worked:

```
===========================================================
 BISCS HRMS — setup report
===========================================================
 tables        : 27
 policies      : 67
 modules       : 30 (with 20 dependencies)
 auth          : linked to Supabase Auth
 tenant tables : all protected by row-level security

 Looks right. Next:
   1. Authentication -> Users -> Add user (tick Auto Confirm)
   2. select bootstrap_owner('you@company.com','Your Company Ltd','YCL');
   3. In the HRMS: Settings -> Backend -> project URL + anon key
===========================================================
```

The line that matters is **tenant tables**. If any table carrying `company_id`
is not protected, that report says so as a warning rather than letting it pass
quietly — which is the failure that would otherwise look exactly like success.

Running it again is safe: it repairs rather than breaks, and prints the same
report. Verified by running it twice over one database and by rebuilding from
scratch and re-running the full security suite against the result.

`setup.sql` is generated from `migrations/*.sql`. Edit the migrations; if you
prefer to run them one at a time, they work that way too, in numbered order.

### If the trigger warning appears

The setup may end with:

> *Could not attach the trigger to auth.users (permission denied).*

Everything else is in place — only the convenience of auto-creating the
`app_users` row is missing. Create accounts from **Users & Access** in the HRMS
instead, or run that one trigger from a role with rights on the `auth` schema.
The setup does not stop for it, because nothing else depends on it.


### 3. Create your own login

**Dashboard → Authentication → Users → Add user.** Use your real email and a
password you will remember. Tick *Auto Confirm User* so there is no email round
trip.

The trigger from `0004` creates the matching `app_users` row for you. That is
the step people get wrong by hand: `app_users.id` **is** the auth uid, which is
what lets a JWT resolve to a row with no lookup table in between.

### 4. Make yourself the owner

Back in the SQL Editor, once:

```sql
select bootstrap_owner('you@yourcompany.com', 'Your Company Ltd', 'YCL');
```

It makes you the super admin and creates your company with every module, and
tells you so:

```
Done. you@yourcompany.com is the super admin; Your Company Ltd (YCL) holds all 30 modules.
```

Run it before creating the login and it says so plainly rather than failing:
*"No account for … Create the login in Supabase Auth first, then run this
again."* It is safe to run twice.

### 5. Point the module at it

**Dashboard → Project Settings → API.** Copy the **Project URL** and the
**anon public** key.

In the HRMS: sign in as the super admin, then **Settings → Backend**. Paste
both, press **Test connection**. It should say:

> **Connected.** The catalog has 30 module(s), so the migrations are in place.

If it cannot reach the project, or the migrations have not been run, it says
which — those are different messages on purpose.

> **Use the anon key, not the service-role key.** The anon key is meant to be
> public: row-level security is what protects the data. The service-role key
> bypasses every policy, and putting it in a browser hands your whole database
> to anyone who opens the developer tools. The settings screen refuses a key
> that looks like one.

### 6. Add everyone else

Two ways round, and they end in the same place:

- **From the HRMS** — *Users & Access* → *Add User*, as now. You will also need
  to create the login in Supabase Auth until the invite flow is wired.
- **From Supabase** — *Authentication → Add user*, and put the placement in the
  user metadata so the trigger files them correctly:

  ```json
  { "name": "Sunita Rao", "role": "hr", "company_id": "<the uuid from companies>" }
  ```

  Roles are `super`, `hr`, `admin` or `employee`. An account created with no
  `company_id` lands as an unplaced employee that can see **nothing at all**,
  and the provisioning log records why — that is deliberate, so a stray sign-up
  is inert rather than a hole.

### 7. Check it is actually enforcing

Sign in as an ordinary employee and try to reach the directory. You should get
nothing — and the interesting part is that the rows never leave the database,
so it is not the page choosing to hide them.

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

**`FORCE ROW LEVEL SECURITY` breaks security-definer helpers.** FORCE subjects
the table owner to its own policies, and the helpers here run as the owner —
so `my_role()` reads `app_users`, whose policy asks `is_super()`, which asks
`my_role()`, until the stack gives out. It is invisible when the owner is a
superuser, because superusers bypass RLS regardless; it appears the moment the
owner is an ordinary role, which is exactly what Supabase gives you. These
tables therefore use ENABLE, not FORCE — the arrangement Supabase expects,
since its API connects as `authenticated`/`anon` and never as the owner.

**Extensions and `information_schema` both need care.** `pgcrypto` is not
needed at all (`gen_random_uuid()` is core from PostgreSQL 13) and `citext` is
replaced by a `lower()` unique index, so the setup needs no rights beyond its
own tables. And `information_schema` hides objects the current role cannot
read, so it reported `auth.users` as absent when it was merely not ours —
`to_regclass` does not depend on privileges.

All of these were found by testing against a database owned by a non-superuser
with no rights on `auth`, which is the only way they show up.

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
- **Inviting a user from inside the HRMS** still needs the login created in
  Supabase Auth separately. The trigger handles the other direction already.

I could not test against a live Supabase project — that needs your credentials.
Everything here was verified against stock PostgreSQL 16, which is what Supabase
runs; what remains untested is the hosted auth layer and the network path.
