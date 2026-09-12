# Independent audit

Run against the working tree, as an auditor rather than as the author. Every
finding below was produced by a check that can be re-run, not by reading code
and forming an impression. Where a check said "clean", the check is named so you
can disbelieve it and run it yourself.

## Summary

| Area | Result |
|---|---|
| Payroll arithmetic | Clean — 8 invariants across every row |
| Statutory figures | Clean — 8 hand-computed spot checks |
| Data integrity | Clean — duplicates, orphans, cycles, impossible dates |
| Access model | Clean — licence ceiling, suspension, dependencies |
| Password handling | Clean — salted, hashed, no plain text in storage |
| Cross-site scripting | **2 defects found and fixed** |
| Tax projection | **1 defect found and fixed** |
| Backend row-level security | **2 defects found and fixed** (in new code) |
| Persistence | Clean — 89 of 89 collections |

## Defects found

### 1. Taxable earnings never reached the tax calculation — fixed

The TDS projection was `structure × 12 + bonus + arrears`. **Overtime, leave
encashment and the out-duty allowance are taxable pay and were not in it.** Nor
were ad-hoc lines, once those existed.

The consequence is not a rounding difference: tax is under-deducted all year and
the employee discovers it as a bill at filing. Worse, it is invisible — every
figure on the payslip looks right.

Fixed: the projection includes every taxable earning. Verified by adding a
₹10,000 taxable line and watching monthly TDS move by ₹173, and a ₹5,000
non-taxable line and watching it not move at all.

### 2. Employee-supplied text written straight into HTML — fixed

Eight places built HTML with template literals and dropped values in unescaped:
candidate names, positions, interview panels and remarks on the ATS board;
employee names in the letter generator, the peer directory and a dropdown.

Names arrive from a spreadsheet import. A name of
`<img src=x onerror="...">` would have run.

Fixed: all eight escaped. Verified by putting exactly that payload in an
employee name and rendering the directory, ESS directory, analytics, the
drill-down and the letter dropdown — it now appears as text.

### 3. Tenant policy handed every employee the whole company — fixed

*(New backend code.)* Postgres ORs permissive policies. The tenant policy said
"anyone in this company"; the self-service policy next to it could only widen
that, never narrow it. **Every employee could read every colleague's salary,
PAN and bank details.**

It fails silently: nothing errors, the screens look right, and the data is
exposed only to whoever thinks to query it.

Fixed: tables holding personal data are opened to control roles only; employees
reach their own rows through explicit `_self` and `_team` policies. Verified: an
employee now sees herself and her manager, and nothing else.

### 4. A policy that could not see what it needed — fixed

*(New backend code.)* The policy letting an employee read their own payslip
checked `payroll_periods` for an executed status — but `payroll_periods` is
itself closed to employees, so the subquery returned nothing and the employee
**silently lost access to their own payslip**. A related policy on `employees`
queried `employees` and recursed until Postgres aborted.

Fixed with `security definer` functions that run outside RLS. Both only appeared
by running the policies against a real database.

## What was checked and found clean

**Payroll arithmetic** — for every row: net equals its own parts; earnings
equal their parts; earned components sum to gross earned; PF is 12% of earned
basic capped at the ceiling; ESIC is charged only at or below the ceiling; PT
matches the state formula; no negative figures anywhere; payable days never
exceed calendar days; loan EMI never exceeds the outstanding balance.

One apparent ESIC discrepancy turned out to be **the code being right and the
check being naive**: overtime is ESI wages for contribution but is excluded from
the coverage ceiling test, and the module does exactly that.

**Statutory** — PF at ₹1,800 on the ceiling and ₹1,200 below it; ESIC at 0.75%
and 3.25%; nothing charged above ₹21,000; PT correct for West Bengal,
Maharashtra and Karnataka at several salaries.

**Integrity** — no duplicate employee codes, no orphan references across eight
collections, no circular reporting lines, nobody leaving before they joined.

**Access** — a user grant cannot exceed the company licence (granting everything
on a two-module licence returns two modules); a suspended company drops to core;
dependencies resolve both ways; core modules cannot be dropped.

**Passwords** — salted and hashed; two accounts with the same password produce
different hashes; the correct password verifies and a wrong one does not; no
plain text anywhere in `localStorage`.

**Persistence** — all 89 collections are saved and restored; no phantom names.

## Still true, and still the main risk

**The browser-only mode is entitlement, not security.** Every check runs in the
page and the registry is in `localStorage`. The wrong screens are genuinely
unreachable through the interface, but anyone who opens the console can change
the rules. `supabase/` is the fix and it is built; what remains is routing the
module's 89 collections through it, screen by screen.

**The statutory rates are still unverified against the Finance Act.** Every rate,
ceiling and slab is in `STAT_CONFIG` and the factory-return layouts are
reconstructions of the West Bengal rules. An auditor can say the arithmetic is
self-consistent; only a labour-law adviser can say the numbers are the right
ones for your assessment year.

**Three buttons remain decorative** — Upload New Policy, Create New Survey and
Deploy Architecture Changes — because they need document and survey stores that
do not exist. They are new features, not repairs.
