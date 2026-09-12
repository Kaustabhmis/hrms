# BISCS Enterprise HRMS & Payroll

Standalone, self-contained HRMS & Payroll demo module for the MAX ERP suite.
No backend, no build step, no dependencies — all state is held in memory in the
browser and resets on reload.

## Layout

```
index.html              MAX ERP launcher shell (placeholder — see note below)
modules/hrms/index.html The HRMS & Payroll module
tools/essl-sync/        Pulls punches out of the eSSL MySQL into a CSV the
                        module's eSSL importer reads
```

The module lives at `modules/hrms/` because its sidebar carries a
`← Back to MAX ERP` link pointing at `../../index.html`. Keeping that nesting
means the link resolves to the repo root when the module is dropped into the
real MAX ERP tree. The root `index.html` here is a minimal placeholder so the
link is not dead when the module is opened on its own; replace it with the real
MAX ERP shell.

## Running it

Open `modules/hrms/index.html` directly in a browser, or serve the repo root:

```
python3 -m http.server 8080
# then visit http://localhost:8080/modules/hrms/
```

It opens on a sign-in screen. On a browser that has not run it before, sign in
as `mis@dynamicengineers.in` with `Biscs@Super2026` — the screen says as much —
and it will ask you to replace that password straight away. Everything after
that follows from the account, so read **Signing in, and who sees what** below.

## Signing in, and who sees what

There is no role dropdown. The module opens on a **sign-in gate**, and the
account you sign in with decides everything after it — the role you hold, the
company whose data you see, and the modules that appear in the sidebar.

### The owner account

On first run in a browser the installation seeds one **super admin**:

| | |
|---|---|
| Email | `mis@dynamicengineers.in` |
| Password | `Biscs@Super2026` — the sign-in screen says so until it is changed |
| Holds | Every module of every company, plus the provider console |

The first sign-in refuses to go further without replacing that password. The
owner account cannot be deleted, demoted or suspended from inside the console,
so an installation can never be left with nobody able to administer it.

### Three gates, applied in order

1. **The account.** Sign-in is by email address. A wrong password and an unknown
   address give the same message, so the form does not leak which addresses
   exist; both are written to the provisioning log. A suspended account, or one
   attached to a closed company, is refused with the reason.
2. **The company licence.** Each company is issued a set of modules. A module
   the company does not hold does not exist for anyone in it — not in the
   sidebar, and not by calling `navigate()` from the console.
3. **The account's own grant.** A user's access is the company's licence
   narrowed to what their account is granted. A grant for something the company
   does not hold is never honoured: **the company licence is always the ceiling.**

On top of those, the role still decides which screens inside a module a person
may open — an HR admin and an employee both covered by *Time & Attendance* see
the attendance register and their own attendance respectively, never each
other's. Every one of these checks runs on navigation as well as on the menu,
so hiding a menu entry is not the only thing standing in the way.

> ⚠️ **This is entitlement, not security.** The module has no backend, so every
> check above runs in the browser and the registry lives in `localStorage`. The
> wrong screens are genuinely unreachable through the interface, but anyone who
> can open the developer console can change the rules. Put the same model behind
> a server before this holds anything that matters. See **Before you launch it**
> at the end of this file.

## The provider console

Visible only to a super admin, under **Provider Console** in the sidebar.

### Companies

Every organisation on the installation, each with its plan, status, seat count,
licence dates and the modules it holds. **Issue modules** opens the licensing
screen: tick and untick against the full catalog, or start from a plan preset —
**Starter**, **Professional** or **Enterprise** — and adjust from there. The plan
name changes itself to *Custom* as soon as the set stops matching a preset.

Dependencies are resolved for you. Issuing *Statutory & Tax* brings *Payroll
Engine* with it; withdrawing *Payroll Engine* withdraws everything that needs it
and says which. **Foundation** modules (Core HR, Employee Self-Service) are
always issued and cannot be unticked.

A company can be **Active**, **Suspended** or **Closed**. Suspending one drops
it to the foundation modules until it is reactivated, with a banner saying so on
every screen; closing it refuses sign-in for its accounts altogether. A licence
past its end date is flagged the same way, and one inside 30 days of expiry
warns.

**Open** switches the provider's view to that company. Each company keeps its own
copy of every HR collection under its own storage key, so switching tenant does
not show one company another's people, payroll or attendance. A newly created
company starts from the seeded demo dataset.

### Users & Access

Accounts are created per email address, against a company and a role — **HR
Admin**, **Manager**, **Employee (ESS)** or a further **Super Admin**. Each
account either:

- **follows the company licence** — the default, so a module issued to the
  company later reaches the account on its own; or
- **is hand-picked** — tick exactly what this person may open. Modules the
  company does not hold are greyed out and cannot be ticked.

Linking an account to an **employee record** is what makes the self-service
screens show that person's own attendance, leave and payslips. Passwords are set
by the provider when the account is created and can be reset from the same
screen; a new account is marked as still holding its issued password until the
holder replaces it, which the account list shows.

Passwords are stored salted and hashed — SHA-256 through WebCrypto where the
browser offers it, and a deterministic fallback where it does not, with each
record recording which was used. The plain text is never stored.

### Module Catalog

The 29 issuable modules across five categories — Foundation, Time, Payroll,
Talent, Operations and Insight — with exactly which screens each one opens, what
it requires, and how many companies hold it. This is the same definition the
licensing screen and the sidebar read, so the catalog cannot drift from what is
actually enforced.

### Provisioning Log

Every licence change, account change, password reset, sign-in and refused
sign-in, with who did it and when — exportable to CSV, as are the licence
register and the access register.

### Seats

A company carries a licensed seat count. Adding an employee past it asks first
and flags the over-count on a banner, rather than silently letting a company
outgrow what it pays for.

## Before you launch it

This is still a front-end module. Running it inside a company needs, at minimum:

1. **A backend.** Move the account registry, the licence model and every access
   check to a server. The client-side model here is the specification for it —
   the catalog, the dependency graph and the three gates map straight onto API
   authorisation — but it is not a substitute.
2. **Real authentication.** Single sign-on against your directory, or at least
   server-side password verification with rate limiting and session tokens.
3. **Real storage.** `localStorage` is per-browser and per-device: a payroll run
   saved on one machine does not exist on another, and clearing site data loses
   it.
4. **The statutory check** the payroll section already calls for — every rate,
   ceiling and slab verified against the Finance Act and the state rules in
   force, and the factory-return layouts signed off by a labour-law adviser.

## HR review changes (second pass)

Nine items raised by HR, and where each landed:

| # | Requirement | Where it lives |
|---|---|---|
| 1 | Employee calendar in dashboard | Command Center → **Employee Calendar** (month grid, prev/next/today) |
| 2 | Total count of present, absent etc. | Command Center + Universal Gateway → **Today's Attendance Snapshot** |
| 3 | No web check out | My Attendance → **Web Clock-Out** with session card and hours worked |
| 4 | No employee calendar found | ESS → **My Calendar** with own attendance, leave, holidays and month totals |
| 5 | Interview line up, interview, sorting, onboarding | ATS rebuilt as a 5-stage pipeline with scheduling, feedback and ATS→onboarding handover |
| 6 | Employee name in Today's Live Edge Logs | Gateway log now resolves ID → name, role, department, and check-in/out direction |
| 7 | Payslip needs industrial standard design | Full statutory payslip: letterhead, PF/ESIC codes, YTD columns, amount in words, employer contributions, print CSS |
| 8 | Auto appointment letter, only once HR unlocks | Letter Generator → **Appointment Letter**, gated behind an HR unlock toggle |
| 9 | ESIC needed in Statutory | Statutory Config → **ESIC** card + contribution register; ESIC flows through CTC, payroll and payslip |

### Notes on the statutory behaviour

ESIC follows the wage ceiling: only employees whose monthly gross is at or below
**₹21,000** are covered, at **0.75%** employee and **3.25%** employer share. Anyone
above the ceiling shows as *Above Ceiling* / *Exempt* rather than being charged.
The seed data includes one employee inside the ceiling (EMP-042, gross ₹20,000)
so the coverage path is visible, and two above it.

The demo works against a fixed date of **16-Apr-2026** (`DEMO_TODAY`) so the seeded
April calendar, attendance and payroll cycle line up. April is month 1 of
FY 2026-27, so payslip YTD columns equal the current month.

### Recruitment pipeline stages

`Sourced / Applied → Screening & Sorting → Interview Line-up → Interviewed → Offer & Onboarding`

Cards carry source, application date, expected CTC and screening score, and can be
sorted by score, application date or name. Scheduling an interview writes to the
**Scheduled Interviews** table; recording feedback sets the score and either advances
the candidate or rejects them. *Start Onboarding* pre-fills the onboarding form from
the candidate record and closes it once the employee is created.

## Payroll & salary process

The payroll engine is the core of the module. Nothing in it is randomised — every
figure derives from source data that can be inspected and changed.

### Six stages

| Stage | What it does | Source data |
|---|---|---|
| 1 · Period & Muster | Classifies every day of the period per employee | Holiday calendar, work week, leave ledger, recorded absences |
| 2 · Leave & LOP | Pro-rates each earning component by payable days | Muster from stage 1 |
| 3 · Variable Pay | Performance bonus, back-dated arrears, reimbursements | DomeBox task counts, salary revisions, queued expense claims |
| 4 · Statutory & Recovery | PF, ESIC, Professional Tax, TDS, loan EMI | `STAT_CONFIG`, tax declarations, loan schedules |
| 5 · Validation | Blocks execution on missing PAN/bank/ESIC number, negative net | The computed run |
| 6 · Execute | Locks the period, posts recoveries, generates outputs | — |

Executing a period stores the run, posts loan recoveries against each schedule,
marks queued reimbursements paid and closes pending arrears. **Reopen Period**
reverses all of that so a run can be corrected.

### Statutory calculations

- **Provident Fund** — 12% of earned basic, restricted to the ₹15,000 wage ceiling
  (so ₹1,800 for anyone above it). Employer share and EDLI shown separately.
- **ESIC** — 0.75% employee / 3.25% employer, only while monthly gross is at or
  below the ₹21,000 ceiling. Above it, employees are reported exempt.
- **Professional Tax** — state-wise monthly slabs, resolved from the employee's
  location (West Bengal, Maharashtra, Karnataka, plus a default).
- **TDS** — full slab computation under both regimes, with standard deduction,
  Chapter VI-A deductions (old regime only), section 87A rebate, surcharge tiers
  and 4% cess. Monthly TDS spreads the remaining annual liability over the months
  left in the financial year, net of tax already deducted in executed runs.
- **Gratuity** — 15/26 × last drawn basic × completed years, five-year minimum,
  ₹20 lakh cap.
- **Leave encashment** — (Basic + HRA) / 30 × earned-leave balance.

> ⚠️ **Verify the slabs before production use.** Every rate, ceiling and slab lives
> in `STAT_CONFIG` at the top of the script. They reflect the structure of Indian
> payroll but must be checked against the Finance Act and state rules in force for
> your assessment year.

### Generated files

All of these download as real files built from the executed run, not placeholders:
bank NEFT file, salary register, GL journal (which balances and says so if it does
not), PF ECR in EPFO's `#~#` format, ESIC return and challan, Form 24Q data,
state-wise PT report, leave register, F&F settlement statement, audit trail, and
every report in the Report Centre that has a data source behind it. A report with
no data source says so instead of pretending to download.

## Enterprise HRMS capabilities

These are the category-standard capabilities the established Indian HRMS products
are known for — Darwinbox's configurable workflow engine and journeys, Keka's
attendance policy engine and continuous-feedback model, factoHR's statutory
depth. They are implemented from HRMS domain knowledge as generic capabilities;
no vendor code, UI, or proprietary content is reproduced.

### Notice board

HR publishes official notices — a sudden work notice, a declared holiday, an
urgent activity — to a targeted audience, and can see exactly who has read and
acknowledged each one.

- **Categories** — Holiday Declaration, Urgent Activity, Work Notice, Policy /
  Circular, General Announcement. **Priorities** — Urgent, High, Normal.
- **Targeting** — everyone, specific departments, specific locations, or named
  individuals. The audience resolves at read time against the current employee
  list, and the composer shows live how many people a notice will reach and names
  them, refusing to publish to an audience that matches nobody.
- **Acknowledgement** — a notice can require one. Unacknowledged urgent notices
  show as a red banner on *every* screen until actioned, so a sudden roster
  change cannot be quietly missed. The sidebar carries an unread count.
- **Tracking** — per-notice read and acknowledgement progress, a per-employee
  table of who is outstanding, a reminder action that names them, and a CSV
  register with the full per-employee trail.
- **Lifecycle** — pin to top, effective and expiry dates (expired notices grey
  out rather than vanish), edit, archive, republish, delete.

**A holiday declaration is not just an announcement.** Publishing one writes the
date to the holiday calendar, which the attendance muster reads — so payable days
change and the payroll figures move with it. If the affected period has already
been executed the composer says so and tells you to reopen it. Archiving or
deleting the notice removes the holiday again. Verified: declaring 22 April took
one employee's present days from 18 to 17 and holidays counted from 3 to 4, and
archiving reverted both.

### Configurable approval workflow engine

Every employee request routes through a chain defined per request type, with an
SLA clock and an escalation path:

| Request type | Default chain | SLA | Auto-approve |
|---|---|---|---|
| Leave | Reporting Manager | 24h | — |
| Expense claim | Reporting Manager → Finance | 48h | ≤ ₹500 |
| Timesheet | Reporting Manager | 24h | — |
| Attendance regularisation | Reporting Manager | 24h | — |
| Comp-off credit | Reporting Manager | 24h | — |
| Travel request | Reporting Manager → Admin / Travel Desk | 48h | — |
| Increment proposal | Department Head → HR → CFO | 72h | — |
| Exit clearance | Manager → Finance → HR | 72h | — |

Only the final level commits the underlying record — the `commit*` / `discard*`
handlers are what the engine calls when a chain resolves, so the ledger and the
audit trail always agree with the chain. A level with no holder is skipped: an
employee with no reporting manager has that level dropped, and a chain that ends
up empty auto-clears. Breaching the SLA offers an **Escalate** action that
inserts the escalation level into the live chain. Chains, SLAs and auto-approval
limits are editable per type from **Approval Workflows**.

### Attendance policy engine

Shift timing with a grace window, late marks, half-day and short-day rules,
overtime and comp-off — all configurable, all feeding payroll:

- Late arrivals outside the grace window accumulate **late marks**; every N of
  them costs half a day, which reduces payable days in the payroll run.
- Overtime beyond a threshold is paid at an hourly rate with a monthly cap, and
  appears as a variable-pay line.
- **Regularisation requests** let an employee fix a missed punch or an off-site
  day; approval clears the recorded absence and reverses the loss of pay.
- **Comp-off** credits for working a week off or holiday, with an expiry window.
- Geo-fence radius is configured for the office location.

### Performance

- **Cascading goals** — company → department → individual, each with a weight.
  A parent's progress is the weighted roll-up of its children, so nothing is
  entered twice. Status is measured against the pace expected at this point in
  the cycle (On Track / At Risk / Off Track), not against a flat threshold.
- **Review cycle** — Self Appraisal → Manager Review → 360 Feedback →
  Calibration → Released, with each transition gated on the prior stage being
  complete.
- **Calibration** — final ratings set against a distribution guideline, with
  over-represented bands flagged and deviations from the suggested rating marked.
- **9-box grid** — placement derived from the calibrated rating and a goal-based
  potential score. Releasing a cycle populates it; nothing is hard-coded.
- **Continuous feedback**, **1-on-1s** with agendas and tracked action items, and
  **peer recognition** badges drawn against an annual recognition budget with a
  points leaderboard.

### Compensation planning

An increment cycle with a budget expressed as a percentage of the annual
wagebill. Proposals default to the rating guideline (5→12%, 4→9%, 3→6%, 2→3%),
budget consumption is tracked live and flagged when exceeded, salary grades carry
band minimum/midpoint/maximum with a **compa-ratio** per employee, and anything
above band maximum is called out. Approving a proposal through the increment
chain creates the salary revision — which then generates arrears if it is
back-dated.

### Employee lifecycle

- **Onboarding journeys** — a 12-task checklist across pre-joining, day one,
  week one and the 30/90-day milestones, each task with an owner and a due date
  anchored to the joining date. Started automatically for every new hire,
  including bulk imports and ATS conversions.
- **Exit clearance** — department-wise sign-off (Manager, IT, Finance, HR) that
  **blocks Full & Final** until complete. IT clearance refuses while assets are
  still assigned; Finance clearance warns while a loan balance is outstanding.
- **Probation & confirmation** — due dates computed from the joining date, with
  overdue and due-soon tracking, and confirmation decisions that surface goal
  attainment and the calibrated rating.

### People analytics

Eight charts built as inline SVG with no libraries: headcount trend, payroll cost
composition, headcount by department, tenure distribution, salary band position,
leave utilisation, exits by month, and a transparent attrition-risk score that
lists its own contributing factors rather than asserting a black-box number.
Every chart carries a hover tooltip and a **Show data table** toggle, and the
whole pack exports to CSV.

The categorical palette is the validated default order (blue, orange, aqua),
assigned in fixed order and never cycled. It was checked with the palette
validator: all checks pass on the lightness band, chroma floor, colour-vision
separation and normal-vision floor. The aqua slot sits below 3:1 contrast on
white, so every chart using it ships direct value labels *and* a table view as
the documented relief.

### Platform

- **Form 16 (Part B)** projection per employee with a side-by-side **regime
  comparison** and a one-click switch — showing exactly what the other regime
  would cost.
- **Helpdesk** with categories mapped to teams, priority multipliers on the SLA,
  assignment, and escalation on breach.
- **Expense policy** with per-category caps, a monthly cap per employee, and
  violations flagged to the approver rather than silently blocked.
- **Bulk import** — upload a CSV or Excel file (or paste CSV), every row validated
  (unknown manager, unknown grade, duplicate name, bad date, bad amount) before
  anything is written. See **Managing employees** below.
- **Employee 360° view** — one timeline per employee drawing on joining,
  revisions, loans, leave, expenses, recognition, feedback, 1-on-1s, assets,
  payroll runs, requests and exit.

## Report Center

Eighteen reports across four categories, each one definition — name, what it
needs, and a build function returning columns and rows. The preview on screen,
the CSV download and the printed sheet all render from that single definition,
so what HR sees is exactly what the file and the print-out contain.

Pick a report, set the period, then **Download CSV** or **Print**. Printing opens
a print-formatted sheet with the establishment header, the form number, a
signature block for the manager and the occupier, and landscape page setup for
the wide registers.

### Attendance

| Report | Covers |
|---|---|
| Daily | One date, every employee — status, punches, hours, late by, and how the day was arrived at |
| Monthly | Present, paid leave, loss of pay, week offs, overtime, late marks, payable days, attendance % |
| Quarterly | Three months side by side with the quarter's payable days; months not yet run show a dash |
| Yearly | Twelve columns, year to date, with the year's payable days and attendance |
| Employee-wise | One employee day by day, with punches, the mark and its basis |
| Department-wise | One line per department — headcount, days worked, leave, LOP, attendance % |

### Salary & Wages

- **Salary & Wages Register (printable)** — the wage register in Form X shape:
  rate of wages, days paid, LOP, overtime hours, each earning, every deduction,
  net wages and a signature column, with the establishment, factory licence, PF
  and ESI codes in the header. Totals tie to the payroll run they came from.
- **Wage Slip** — the Form XI slip for one employee, with the amount in words.
- **Department-wise Wage Cost** — gross, deductions, net and employer
  contributions per department, and total cost.

A wage report will not invent figures: with no payroll run for the month it says
so and tells you to run the statutory stage first.

### Leave

- **Leave Report** — credited, availed and balance by type per employee, with
  LWP days and encashable value. Credited is what the disbursement ledger has
  actually posted, not the annual entitlement.
- **Leave Application Register** — every application in the period with dates,
  days, status and who actioned it.
- **Register of Leave with Wages** — the annual Form 20 register: days worked,
  leave to credit, dates taken, the rate and the wages paid for leave.

### Factory Returns

- **Register of Adult Workers** (Form 16) — name, parentage, sex, date of birth,
  age, nature of work, group, relay and dates of joining and leaving.
- **Muster Roll** (Form 17) — the month day by day for every worker with the
  monthly totals.
- **Overtime Register** (Form 24) — every day overtime was worked, the hours, the
  rate and what was paid.
- **Annual Return** (Form 21) — workers on roll, average employed daily, man-days
  worked, days the factory worked, overtime, leave with and without wages, leave
  wages paid on discharge, accidents and recruitment.
- **Half-Yearly Return** (Form 22) — the same figures month by month for the half.
- **Statutory Contribution Summary** — PF, EDLI, ESI, professional tax and TDS,
  employee and employer side, with the remittance total.

**Establishment Details** holds the particulars that head every register — name,
address, factory licence, PF, ESI and PT registrations, occupier, manager, nature
of work and normal working hours. Employee records carry the father's or
husband's name and date of birth the factory registers require; both are on the
edit form and both import from a spreadsheet.

> **Verify before filing.** The statutory layouts here are reconstructions of the
> West Bengal Factories Rules and the Minimum Wages Rules forms. The form numbers
> and column order are close enough to work from, but check them against the
> current Rules — and have a labour-law adviser sign them off — before anything
> goes to an inspector. The annual return's accident, occupational-disease,
> canteen and safety-committee figures are placeholders that must be replaced
> with the real ones, and the overtime register applies the flat rate configured
> in the attendance policy rather than twice each worker's ordinary rate.

## Clock in, clock out, and marking attendance by hand

### Clocking

A punch is a real record, not a screen state. **Clock In** and **Clock Out** on
**My Attendance** write to a punch log, and the day's punches roll up into the
single daily record that late marks, half days, overtime and the payroll muster
all read.

- **Several sessions a day** are allowed — out for a client call at eleven, back
  at two. Worked time is the sum of the closed pairs, not last-out minus
  first-in, so a long lunch is not paid as hours worked.
- Clocking in past the shift start plus the grace period says so and books a
  late mark. Clocking out short of the full-day hours says that too, and below
  the half-day threshold the day is counted as half.
- With the geo-fence on, a web punch has to say which location it was made from.
- Guards: no second clock-in while a session is open, no clock-out without one,
  and no punch earlier than the last one on the same day.
- The biometric simulator on the Universal Gateway writes through the same path,
  so a simulated device day is indistinguishable from a real one, and the
  gateway's live log and its end-of-day batch push read the same punches.

Everything downstream is derived rather than stored: today's Present / Late /
On Leave / Absent counters on the dashboard, the calendar, and the muster all
read the punch log, the leave ledger, approved duty days and any HR mark — so
they cannot disagree with each other or with the payslip.

### Geo-fencing — optional, and HR's call

Geo-fencing is off unless HR wants it, and nothing else in the module depends on
it. Four modes, set under **Universal Gateway → Geo-fencing**:

| Mode | What a punch does |
|---|---|
| **Off** | No location is asked for at all |
| **Record only** | Coordinates are kept with the punch, nothing is judged |
| **Warn and flag** | The employee is told and has to confirm; the punch is written and flagged |
| **Refuse the punch** | A punch outside the fence is not written at all |

Alongside the mode, HR sets:

- **Locations** — as many as needed, each with latitude, longitude, radius and its
  own on/off switch. A punch is inside when it falls within any active location's
  radius. Adding, editing, disabling and removing are all in the same card, and
  removing the last active location while punches are being refused asks first.
- **GPS slop** — metres allowed on top of the radius, capped at the accuracy the
  device actually reported, so a phone with a poor fix is not punished for it.
- **Clock-out too, or clock-in only.**
- **What happens with no location** — permission refused, no signal, or an old
  browser: allow the punch and flag it, or refuse it.
- **Exemptions** — whole departments, named individuals, and optionally anyone on
  an approved out-duty or outstation day, who by definition is not at the office.

The employee sees the verdict on the clocking card *before* punching, with a
**Check my location** button, and the same check runs again at the punch itself.
A refused punch never reaches the log; an allowed-but-outside punch carries its
coordinates, the nearest fence, the distance and the fix accuracy, and shows as
flagged on their own attendance log, on the gateway, in the attendance register
export and in the **Geo-fence Exception Report**.

Because a page opened straight from a file is usually refused a real fix, the
settings carry a **simulated position** for testing the fence without moving.
Every punch it produces is stamped as simulated, shows as such on the register
and in the exception report, and can never pass for a real device fix.

### HR-side manual attendance

**Attendance Register** shows the whole month as a grid — one cell per employee
per day, coloured by what the day actually is: present, absent, half day, work
from home, duty, leave or week off. A cell outlined in amber was set by HR; a
dashed cell is a present day with no punch captured behind it, which is a gap in
the device data rather than an absence. Payable days and loss of pay for each
employee sit at the end of every row.

- **Click any day** to set it by hand — present, half day, work from home, on
  duty or absent, or clear an override back to what the punches say. A reason is
  compulsory.
- **Enter Punch** types a whole punch pair for someone: pick the employee, the
  date and the in and out times, and the day is rebuilt from them, so late marks
  and overtime recompute exactly as if the reader had captured it. Any recorded
  absence for that day is cleared.
- **Bulk Mark** sets the same mark across a date range for one employee, a
  department or everyone. Week offs, holidays and days already covered by
  approved leave are skipped rather than overwritten.
- Half days cost half a payable day, absences a full one, and both flow straight
  into the next payroll run.

Every manual entry is listed underneath with who set it, what it was before,
and why, and the whole register — grid, punch log and manual entries — exports
to CSV.

## eSSL biometric import

Punches from eSSL devices (and the eTimeTrackLite software behind them) come in
under **Time & Attendance → eSSL Device Import**, which is its own licensable
module (`essl`).

An imported punch is written with the same `pushPunch` call a web clock-in
makes, and the day is rebuilt with the same `syncDailyFromPunches`. So late
marks, half days, overtime and the payroll muster all recompute from imported
punches exactly as they do from live ones — there is no separate "imported
attendance" that could disagree with the payslip.

### Three ways in

Two routes, and they end in the same place:

| Route | What it is |
|---|---|
| **Straight from the database** | The screen pulls punches out of the eSSL MySQL itself, through a small connector service. No file changes hands. |
| **A file, by hand** | The raw `.dat` / `.txt` off the device, or an eTimeTrackLite export as `.xls`, `.xlsx` or CSV — including the grouped **Log Records (Employee Wise)** report. |

Both feed the same preview, the same de-duplication and the same commit, so
nothing is written until you have looked at it — and a punch imported one way is
recognised if it arrives again the other way.

### Importing straight from the database

A browser cannot open a MySQL connection, so `tools/essl-sync/server.js` runs
beside the eSSL database and hands punches over HTTP. Start it there, put its
address and token into **eSSL Device Import → Import from the eSSL database**,
and **Test connection** reports the database, the table, the row count and how
far the HRMS has already taken. Then pull either:

- **everything new since the last pull** — the connector keeps a watermark, so
  this is the day-to-day action and never fetches the same punch twice;
- **a date range** — ignores the watermark, for re-taking a period after a
  correction. Safe, because punches already in the log are skipped;
- **everything in the database** — for the first load.

The watermark only moves **after** an import is committed, never at fetch time,
so a pull you discard can be pulled again.

```
cd tools/essl-sync
cp .env.example .env      # database details, then a service port and token
npm install
node server.js
```

Set `ESSL_SERVICE_TOKEN`: without it, anyone who can reach the port can read
your punch data. The service is read-only — every query is a `SELECT`, and the
database user needs nothing more than `SELECT`. Keep it on the LAN; it holds
database credentials and is not built to face the internet.

### Nothing is hard-coded to one layout

eTimeTrackLite has shipped several schemas and every site exports something
slightly different, so the importer detects rather than assumes:

- **Columns** are matched against a table of aliases (`UserId`, `EmployeeCode`,
  `AC-No`, `Badge Number`, `LogDate`, `AttDateTime`, `Direction`, `AttDirection`
  and others), and **every one is remappable** from a dropdown that shows the
  first value in each column. A file with no header row is read positionally as
  a raw device log.
- **The date format is decided once, from the whole file, not per row.**
  `01/02/2026` is either 1 February or 2 January and no single row can say
  which — so every stamp in the file is inspected, and a day past 12 anywhere
  settles it. When nothing settles it, the import says so plainly and reads it
  day-first (which is what eSSL writes in India) rather than guessing quietly.
  A file containing rows that only fit day-first *and* rows that only fit
  month-first is flagged as mixed. The format can always be set by hand.
- **Direction** comes from the device's own state code where there is one
  (ZKTeco numbering: 0 check-in, 1 check-out, 2 break-out, 3 break-in, 4 OT-in,
  5 OT-out) as well as the usual text forms. Where the device records no
  direction, the person's punches for that day are sorted and alternated from
  the first — which is what an in/out reader actually produces.

### Device ID → employee

A device knows people by an enrolment number, not by name. **Auto-match by
code** takes the digits out of each employee code (EMP-042 → 42), which is how
most eSSL enrolments are numbered; anything that clashes is left for a human.
Unmapped IDs found during an import are listed with a punch count and a button
to map each one, and their punches are **held back rather than guessed at**.

### What the preview tells you before you commit

Punches to be written, employee-days affected, punches already in the log,
unmapped device IDs, rows that cannot be read and why, and punches falling
outside someone's service dates — a punch dated before joining or after leaving
is skipped, not imported.

**Re-importing is safe.** eSSL exports overlap constantly, so every punch is
checked against the log on employee, date, time and direction, and one already
there is skipped. Re-importing the same file writes nothing.

Committing an import clears any *recorded absence* on a day the punches
disprove, and says how many. Every import is a numbered batch in the history
table, and **Undo** removes exactly the punches that batch wrote and rebuilds
those days from whatever is left.

### HR uploads the log book by hand

**Attendance Register → Upload eSSL Log Book**, or **eSSL Device Import** in the
sidebar. Both are open to any HR Admin account whose company holds the `essl`
module — no provider account needed. The shortcut on the register hides itself
where the module is not licensed.

#### The file route

#### The `.xls` eSSL actually exports is read directly

eSSL exports **Log Records (Employee Wise)** as a genuine legacy binary `.xls`
(an OLE compound file holding a BIFF8 workbook), not a spreadsheet dressed up
with that extension. The module reads it natively — the compound-file container
and the BIFF records that carry cell values are walked by hand, so there is
still no library and no upload to a server. Checked against a real 375 KB export:
all **2,543 rows across 15 sheets** come out identical to a reference reader.

The report runs over as many sheets as it needs, and **every sheet is read**, not
just the first. The employee importer reads `.xls` now too.

#### It is a grouped report, not a table

In this layout the employee is a **section heading** —
`Employee | LB0016 : Surajit Sarkar` — and the punch rows beneath it carry only a
timestamp and a device name. There is no employee column to map. The importer
detects the shape and carries the heading down the rows, pulling out employee
code, name, department, timestamp and device from the report structure. The
preview says when it has done this, and hides the column pickers, which mean
nothing in that layout.

Because the report names each person, **Match by name** resolves unmapped codes
against the directory in one click. In practice: import the employee master
first, then the log book, and the mapping largely does itself.

#### Repeat reads — the one that would have cost you money

eSSL readers commonly register the same finger **twice, a second or two apart**.
In the real export checked here, **594 of 1,249 consecutive punch pairs were
within two seconds of each other.**

That matters because direction is derived by alternating in/out. Left alone,
`09:16:45` and `09:16:46` become a complete work session of **one second**, and
the real 09:16 → 19:02 day disappears:

| | Worked hours across 781 employee-days |
|---|---|
| Alternating the raw reads | 3,921 |
| Collapsing repeat reads first | 5,176 |
| **Lost to loss-of-pay if unhandled** | **1,255 hours** |

So punches closer together than a set window are treated as one read. The window
is configurable (off, 5s, 30s, 1m, **2m default**, 5m) and the preview reports
how many reads were collapsed. The punch keeps a count of how many times it was
actually read.

#### Missing punches are named, not buried

After collapsing, an **odd number of reads** in a day means someone clocked in
and never out, or the reader missed one. Those days still import — the punch is
real — but the preview **lists them by employee and date** rather than letting
them become a quiet short day in payroll. Fix them on the Attendance Register,
or let the employee raise a Forgot Punch request.

### `tools/essl-sync` — CSV, where the HRMS cannot reach the database

Where the machine running the HRMS cannot reach the eSSL machine over the
network, the same tool writes the punches to a CSV to carry across by hand:

```
cd tools/essl-sync
cp .env.example .env      # then fill in host, user, password, database
npm install
node sync.js --probe      # list the tables and columns, write nothing
node sync.js              # pull new punches since the last run
node sync.js --full       # ignore the watermark and pull everything
```

**Run `--probe` first.** It prints the tables in the database and the columns in
the punch table, and names any configured column that is not actually there.
`DeviceLogs` with `DeviceLogId` / `UserId` / `LogDate` / `Direction` / `DeviceId`
is the common shape and the default, but it is not a promise — every table and
column name is an environment variable precisely because yours may differ.

The script keeps a **watermark** (the highest log id already pulled) in
`.watermark`, so each punch is fetched exactly once however often it runs — put
it on a cron job or Task Scheduler and it becomes an incremental feed. It writes
timestamps year-first so the importer never has to guess the date format.

Give it a **read-only MySQL user**; it only ever issues `SELECT`.

`sync.js` and `server.js` share `lib.js`, so the query, the schema settings and
the watermark behave identically whichever route you use.

## Attendance requests and the special powers console

Four request types cover the days an employee worked but the reader did not see.
Each has its own rules, all set by HR under **Attendance Requests**.

| Type | What it is for | Shipped rules |
|---|---|---|
| **Out Duty (OD)** | A day away from the base office — client visit, bank errand, site inspection | 6 days a month, 48 a year, max 3 in a row, field locations only, back-dated up to 3 days, ₹300/day |
| **Forgot Punch (FP)** | In office, but a punch did not register | 3 days a month, 18 a year, single day, office locations only, back-dated up to 7 days, in and out times required |
| **Outstation / Travelling Job (OS)** | A multi-day job in another city | 2 **requests** a month, 12 a year, up to 15 days each, field locations, travel reference required, manager then HR, ₹800/day |
| **Swipe Request (SW)** | No punch at all — dead card, failed reader | 2 days a month, 12 a year, single day, office locations only, back-dated up to 15 days |

### How many, and where from

Both are rules, not code. Per type HR sets:

- **How many** — a cap per month and per year, counted either in **days claimed** or
  in **requests raised**. A five-day outstation trip is one request but five days,
  and the unit decides which cap it consumes. Approved and pending count together,
  so nobody can queue their way past a limit.
- **Where from** — a list of company locations, each marked `office` or `field`.
  A type may additionally require the work to be **at an office** (forgot punch,
  swipe request) or **away from one** (out duty, outstation), and a request from
  any other location is refused.
- Longest single claim, back-dating window, how far ahead it may be raised, which
  fields are compulsory (times, place, reason, proof), the approval route
  (manager, manager then HR, or HR alone), whether it counts as present, and the
  per-day allowance.

The locations list itself is editable; removing a location removes it from every
type that allowed it.

### One engine, checked before and after

The employee sees the verdict in the form before submitting — days claimed,
allowance, and every refusal or warning. The approver sees the same verdict
re-run against current quotas and the calendar. Approval does real work:

- Out duty and outstation days are written to the muster as duty days, so a field
  day is never mistaken for an absence, and any recorded absence for that day is
  cleared — reversibly, so rejecting an approved request puts the absence back.
- Forgot punch and swipe requests write the missing attendance record, so late
  marks, half days and overtime all recompute from the real times.
- Allowances ride into the payroll run as a taxable earning, shown on the payslip
  as *Out Duty / Outstation Allowance*.

### The special powers console

Some days cannot be fixed within the rules — a request that is a fortnight too
late, an employee who has run out of out duty in a month when the work did not,
a transport strike nobody could punch through. HR and the super admin have a
console for exactly those, and it is deliberately awkward to reach:

- It is **not in the menu**. Typing `sudo` while signed in as HR prompts for the
  super admin passcode (`BISCS-OVERRIDE` by default, changeable from inside), and
  only a correct passcode reveals the console. A wrong attempt is audited.
- It is gated by role as well as by the lock, so it never appears for an employee,
  and locking it removes the entry again.

Once unlocked it can:

1. **Approve a refused request anyway** — the console lists exactly which pending
   requests the rules are refusing and what for. A justification is compulsory.
2. **Grant extra quota** — headroom above the cap for one employee on one type,
   per month or per year, expiring on its own.
3. **Credit special attendance** — mark days present for one employee, a whole
   department or everyone, with no request at all. Days already covered by
   approved leave are left alone rather than paid twice.
4. **Delegate the power** — hand it to somebody else for a fixed window, after
   which it lapses. It can be revoked early.

Every one of those, plus the unlock, the lock and a passcode change, is written to
the **Special Powers Register** with who, what, why and when, mirrored into the
main audit trail, and exportable to CSV. Grants can be reversed, and reversing an
attendance credit restores whatever it overwrote.

## Leave management and the leave rule set

Leave is defined in one place — the **rule set** on **Leave & Capacity
Management** — and everything else reads from it. The screen that shows a rule is
the screen that enforces it, so there is no second copy of the policy to drift.

### The rule set

Eight types ship configured: casual, sick, earned, compensatory off, maternity,
paternity, bereavement and leave without pay. Each carries its own rules, all
editable in place:

| Rule | What it controls |
|---|---|
| Entitlement and accrual | Days per year, credited monthly, once at year start, or only on the event |
| Eligibility | Gender, minimum service, and whether probation blocks the type |
| Application shape | Minimum per application, longest single spell, half-day permitted |
| Timing | Advance notice expected, and how far back an application may be dated |
| Documentation | What is required, and beyond how many days |
| Clubbing | Types that may not sit adjacent to one another |
| Year end | Carry forward and its cap, and whether the remainder lapses |
| Encashment | Encashable at all, in service, the yearly cap, and on exit |

Global rules sit above them: probation length, the sandwich rule (whether week
offs inside a spell are charged), whether a balance may go negative, whether a
shortfall is refused or granted unpaid, half days, the overlap check, and a
per-department capacity guard. **Blackout windows** freeze leave for named dates,
either refusing applications or only warning the approver.

Maternity leave is counted in calendar days regardless of the sandwich rule,
since that is how the statutory entitlement runs.

### One rule engine, three callers

Every application goes through the same evaluation — the employee applying, HR
applying on someone's behalf, and the approver re-checking at approval. The
employee sees the verdict in the apply form *before* submitting; the approver sees
the same verdict, re-run against today's balances and calendar, in the pending
queue. It checks eligibility, dates, overlap with existing leave, minimum and
maximum spell, notice and back-dating, blackouts, team capacity, documentation,
clubbing, and balance — returning refusals and warnings separately.

An approver may override a refusal; the override is written to the audit trail
with the rules it overrode.

**Balance shortfall** is handled by splitting rather than converting. Where a
spell runs past the balance, the paid days are taken first and the remainder is
written as a separate LWP record, so the payslip shows which dates were paid and
which were not.

### Disbursement

Leave is disbursed, not merely calculated. Every day an employee can take was
credited by a posting on the **disbursement ledger** — an opening balance, an
accrual run, an approved comp-off, an HR adjustment — and every day removed
without being taken is a negative posting. Balance is credits minus leave taken,
so any number on screen can be traced to the postings behind it.

- **Run Accrual** credits what each employee earned for a month. Joiners and
  leavers are pro-rated to the days actually served, probation-blocked types are
  skipped with the reason shown, and a period already credited is skipped rather
  than doubled — the run is safe to repeat. The preview lists every posting and
  every skip before anything is written.
- **Adjust Balance** posts a correction. It requires a reason, which stays on the
  ledger.
- **Year-End Close** works closing balances out to the last day of the financial
  year: each type carries forward up to its cap, the excess is encashed where the
  rule set allows and lapses otherwise, and encashment is queued for payroll.
  Postings are dated at the year end, so current balances do not move.
- **Encash Leave** raises an in-service payout, capped by both the balance and the
  type's yearly limit. Approving one removes the days from the balance and queues
  the money in the same action, so days and rupees cannot drift apart.

Encashment reaches payroll as a taxable earning in the variable pay stage. It is
deliberately not a PF, ESIC or professional tax wage, so it is added after the
statutory bases are worked out. Executing the run marks it paid; reopening the
period returns it to the queue.

Both the rule set and the full disbursement ledger export to CSV.

## Managing employees

Everything lives under **Core HR → Org Directory (SSOT)**. The directory has a
search box plus department and status filters, and shows grade, compa-ratio and
reporting manager alongside the usual columns. Rows missing a PAN, UAN or ESIC
number are flagged so statutory exports do not fail later.

### Add one at a time

**Add Employee** opens the onboarding form: identity, department, grade,
designation, date of joining, reporting manager, location, statutory IDs, bank
details, employment type and annual CTC. The salary structure is derived from
the global CTC structure as you type, so the monthly break-up is visible before
you save. The new employee is written to the directory, the leave ledger opens
with accrual pro-rated to the joining date, and the action is recorded in the
audit trail.

### Edit

**Edit** on any row opens the same fields pre-filled, with a live impact preview
of what changes. Two edits are treated as more than field updates:

- **Changing the CTC** offers to record a proper **salary revision** instead of
  silently rewriting pay. Choose an effective date; if it is in the past, arrears
  are calculated and picked up by the next payroll run.
- **Changing the reporting manager** is validated against the org chart — a
  change that would create a circular reporting line is refused.

### Delete

**Delete** first runs an integrity check and refuses to remove an employee who:

- has payslips in an executed payroll period,
- has an outstanding loan balance, or
- is the reporting manager for other employees.

When none of those apply, the dialog lists everything the delete will remove
(leave ledger, requests, timesheets, expenses, goals, reviews, documents,
letters, recognition, 1-on-1s and more across ~20 collections), releases any
assets back to inventory, and asks you to type the employee code to confirm.
Deletions are written to the audit trail.

### Bulk upload — CSV or Excel

**Import Employees** takes a `.csv`, `.xlsx` or `.xlsm` file by drag-and-drop or
file picker, or pasted CSV text if you would rather not use a file.

- **Excel is read natively** — the `.xlsx` is unzipped and parsed in the browser
  with no library and no upload to a server. Date cells stored as Excel serials
  are converted, and shared strings are resolved. If a browser is too old to
  provide `DecompressionStream`, the importer says so and asks for a CSV instead.
- **CSV parsing is RFC-4180** — quoted fields containing commas and newlines,
  escaped quotes, `,` or `;` delimiters (detected), and a UTF-8 BOM are all
  handled.
- **Headers are aliased**, so real spreadsheets usually map without any manual
  step: `Employee Name` → name, `Annual CTC` → ctc, `Date of Joining` → doj,
  `Reporting Manager` → manager, `Designation` → role, and so on. Amounts written
  as `₹6,00,000` are coerced to numbers. Unknown columns are ignored.
- **Every row is validated before anything is written**: unknown department,
  grade or manager, duplicate employee code or name, malformed date, non-numeric
  CTC. The preview shows exactly which rows will be created, which will update an
  existing employee, and which are rejected and why. Managers can be referenced by
  name, including managers defined earlier in the same file.
- **Import is create-or-update.** A row whose employee code already exists updates
  that record; blank cells leave the existing value untouched.

**Export Directory** writes a CSV in the same shape the importer reads, so a
round-trip — export, edit in Excel, re-import — works without reshaping columns.

## Modules wired to real state

| Module | Behaviour |
|---|---|
| Leave | Configurable rule set per type, accrual disbursed to a credit ledger, one rule engine shared by employee, HR and approver, shortfall split into paid and LWP records, year-end carry forward / lapse / encashment |
| Attendance | Clock in / out writing a real punch log, several sessions a day, rolled into the daily record that drives late marks, half days and overtime; muster from calendar + leave + duty days + HR marks |
| Attendance register | Month grid marked from punches, leave and duty days, clickable per day, with manual punch entry and bulk marking, all logged with a reason |
| Geo-fencing | Optional, HR-controlled: off, record, warn or refuse; any number of fenced locations with their own radius, GPS-slop tolerance, department and individual exemptions, and an exception report |
| Attendance requests | OD, forgot punch, outstation and swipe requests with per-type caps and allowed locations; approval writes duty days or rebuilds the punch record and pays the allowance |
| Special powers | Hidden, passcode-gated console for force approvals, quota grants, special attendance credits and delegation, all on their own register |
| Loans | Amortisation schedule, EMI capped at outstanding, recovery posted on payroll execution and reversed on reopen |
| Expenses | Pending → Approved → Queued for Payroll → Paid, reimbursed with salary as a non-taxable line |
| Salary revisions | Effective-dated, back-dated revisions accrue arrears picked up by the next run, impact preview before saving |
| Offboarding | Notice shortfall recovery, gratuity eligibility, leave encashment, loan settlement, asset recovery flags |
| Timesheets | ESS submission → manager approval → billable value at project rates and utilisation |
| Assets | Assign / return with custody history; assets held by exiting staff flagged for F&F |
| Manager inbox | Built from genuinely pending leave, expense and timesheet records; approving mutates the real ledger |
| Audit trail | Every execution, approval, master-data change and export, exportable to CSV |

Session state persists to browser `localStorage` via **Save** in the top bar,
under the open company's own key; **Reset** clears that company's HR data and
reloads the seeded demo, leaving companies, accounts and the provisioning log
alone.

## What the module covers

- **Email sign-in with per-account access** — no role switch; the account decides the role, the company and the modules. See **Signing in, and who sees what**.
- **Core HR** — org directory (SSOT), onboarding with auto-calculated salary structure,
  document centre & e-signatures, ATS kanban, org chart, announcement feed.
- **Time & attendance** — universal edge gateway (biometric punch simulator with
  offline-first batching), project timesheets, shift roster, leave management.
- **Payroll** — five-stage payroll engine (telemetry fetch → LOP → bonuses →
  statutory taxes → execute), payslip vault with printable statutory payslips,
  loans & advances, expense claims, statutory compliance exports (EPF, TDS, PT, ESIC),
  letter generator with HR-gated appointment letters.
- **Talent** — OKRs & 360 reviews, 9-box succession grid, exit & offboarding with F&F,
  learning modules, engagement/eNPS.
- **Intelligence** — DomeBox task-sync bridge, earned wage access, AI flight-risk
  predictor, WhatsApp zero-app assistant.
- **Reporting** — report centre spanning payroll, time, compliance, talent, ops,
  ATS, and audit registers.
- **Config** — multi-vertical architecture switch and a global CTC structure editor
  that drives onboarding previews and payroll runs.

## How the menu is arranged

Both the sidebar and the module catalog follow the employee lifecycle, and they
use the same grouping — so a licence maps onto what actually appears in the menu:

**Company → People → Hire &amp; Onboard → Time &amp; Attendance → Payroll &amp;
Compensation → Statutory &amp; Compliance → Talent &amp; Exit → Approvals →
Analytics &amp; Reports → Workplace → Intelligence → System**

A heading with nothing visible underneath hides itself, so a company licensed
for a handful of modules gets a short menu rather than a page of empty sections.

## Configuring the CTC structure

`ctcStructure` in the inline script defines earnings and deductions. Each component
has a calculation `type` of `% of Gross`, `% of Basic`, `Flat Amount`, or `Remainder`,
plus an optional `cap` for deductions. Components are resolved in that order, so
`Remainder` absorbs whatever gross is left. Edits made through
**Multi-Vertical Arch → Global CTC Structure Setup** apply immediately to onboarding
previews and to the next payroll run.

## Status

Front-end only — no backend and no build step. The module opens on the sign-in
gate; HR data is seeded in `employees`, `helpdeskTickets`, `essLeaveHistory` and
`essExpenseHistory`, and the account and licence registry lives under its own
`localStorage` key apart from tenant data. Downloads, API syncs and e-signature
flows are simulated with toasts. Read **Before you launch it** above before
putting this in front of a real company.
