# KIWI — production assistant in the KPI app

Staff click **🥝 KIWI** in the KPI app header and ask questions in plain English
("How many cases did Line 2 make yesterday?", "What caused the most downtime this
week?"). KIWI looks the answer up and replies in a sentence or two.

```
SharePoint shift report folder
   │  OneDrive app syncs it to an always-on office PC (your normal Microsoft sign-in)
   ▼
kiwi_sync.py (every 5 min, only when a workbook changed) ── HTTPS + token ──►
   Supabase function `kiwi-ingest` ── validates every field ──►
   public.kiwi_replace_month()  (service role only; replaces exactly one month)
   ▼
schema plant (tables, not exposed to the API)  ──►  schema kiwi (read-only views)
   ▲
   │  read-only login, 8 s limit, one statement, max 200 rows
Supabase function `kiwi` ◄── question ── KPI app (signed-in user with a profile)
   │  AI writes a SELECT, gets rows, writes the answer
   ▼
browser gets the answer text only
```

## What KIWI can read

| Source | Views (schema `kiwi`) |
|---|---|
| Supervisors' shift report (SharePoint, synced) | `shift_production`, `shift_downtime`, `shift_notes`, `shift_line_summary`, `shift_people`*, `data_freshness` |
| KPI app | `daily_production`, `downtime_log` (author left out), `monthly_targets`, `non_working_days` |
| PLC recordings | `tank_batches`, `tank_readings` |

\* Absence / part-day names: only users whose app role is in `KIWI_PEOPLE_ROLES`
(default `manager`). Enforced by the database: everyone else's questions run as a
login that has no access to that view at all.

## Security, in one place

| Risk | What stops it |
|---|---|
| Someone outside uses KIWI | Function requires a signed-in Supabase user **with a row in `profiles`**; the public anon key alone is refused |
| KIWI's AI writes or deletes data | DB login has SELECT on `kiwi` views only; transaction is read-only; writes are refused by Postgres |
| AI query reads other tables (auth, comments authors, plant) | Login has no rights outside `kiwi` views; query text checked as well |
| Chained statements / injection | Query sent with a parameter = Postgres's one-statement protocol; tested |
| Slow query hogs the database | 8 s statement timeout on the login and per transaction; 200-row cap |
| Staff download the reports | Files never leave SharePoint/the sync PC; browser only gets answer text |
| Someone uploads fake shift data | `kiwi-ingest` needs a 64-char token (hashed compare), fails closed if unset, validates every field, ignores unknown fields |
| A bad upload wipes history | DB function only accepts exactly one calendar month, and every row must be inside it; whole upload is one transaction |
| Secrets in the browser or repo | AI key, DB passwords, token: Supabase secrets / `kiwi_sync.conf` (git-ignored, locked to one Windows user) |

## Setup (about 20 minutes)

### 1. Supabase settings check
Supabase → Authentication → Sign In / Providers: make sure **"Allow new users to sign up"
is OFF** (accounts are created by you). Otherwise anyone could create a login.

### 2. Database
SQL Editor → run `kiwi/database/001_kiwi_shift_reports.sql`, then
`kiwi/database/002_kiwi_kpi_views.sql` (both safe to re-run). Then set two passwords
(generate long random ones, e.g. a password manager, 32+ characters):

```sql
alter role kiwi_reader         with login password '<reader password>';
alter role kiwi_manager_reader with login password '<manager password>';
```

Connection strings: Supabase → **Connect** → *Transaction pooler*, with the role and
project ref as the user name:

```
postgresql://kiwi_reader.<project-ref>:<reader password>@<pooler-host>:6543/postgres
postgresql://kiwi_manager_reader.<project-ref>:<manager password>@<pooler-host>:6543/postgres
```

### 3. AI key
console.anthropic.com → sign in with a company email → **Billing**: add a card and a
monthly spend limit → **API keys** → *Create key* named `kiwi`. Copy it once; it isn't
shown again. Don't paste it anywhere except the command below.

### 4. Secrets and deploy (Supabase CLI, from the `kpi` folder)

```bash
T=$(openssl rand -hex 32); echo "$T"     # the upload token: keep it for step 5
supabase secrets set ANTHROPIC_API_KEY='<key>' \
  KIWI_DB_URL='<kiwi_reader connection string>' \
  KIWI_MANAGER_DB_URL='<kiwi_manager_reader connection string>' \
  KIWI_SYNC_TOKEN="$T"
# optional: KIWI_PEOPLE_ROLES=manager,supervisor   KIWI_MODEL=claude-sonnet-5-5

supabase functions deploy kiwi
supabase functions deploy kiwi-ingest --no-verify-jwt   # token-protected, like plc-ingest
supabase functions deploy production-detail             # now requires a signed-in user
supabase secrets list                                   # KIWI_SYNC_TOKEN shows as a digest
```

### 5. SharePoint → KIWI (on an always-on Windows office PC)

Pick a PC that stays on and signed in. **Not** the plant collection PC: it sits on
the PLC network and shouldn't also hold a Microsoft 365 session.

1. In SharePoint, open the shift report folder → **Sync** (or *Add shortcut to My
   files*). OneDrive now keeps a local copy, e.g.
   `C:\Users\<you>\<Company>\Production - Shift Reports`.
2. Install Python 3, then `pip install openpyxl`.
3. Copy `kiwi/importer/` to that PC. Copy `kiwi_sync.conf.example` to
   `kiwi_sync.conf` and fill in the function URL, token and folder.
4. Test: `python kiwi_sync.py --dry-run`, then `python kiwi_sync.py`.
5. Schedule it: `powershell -ExecutionPolicy Bypass -File install_kiwi_sync.ps1`
   (runs every 5 minutes; locks `kiwi_sync.conf` to your Windows account).

A supervisor saves the report → OneDrive syncs it (≈1 min) → next pass sends it
(≤5 min) → KIWI answers from it. Unchanged files are never re-sent. Log:
`kiwi_sync.log`. Older months: `python kiwi_sync.py --file "<path>.xlsx"`.

### 6. App
Commit and push to `main`; GitHub Pages rebuilds as usual. No new frontend secrets.

## How the workbook is read
- Never modified. Sections are found by their labels (1st/2nd Shift, Downtime
  Tracking - Line 1/2, Employee Information), so an extra row doesn't break it.
- Each tab is that day of the month; the month comes from the dates in the file. If
  a typed date disagrees with its tab (tab 1 of November dated 10/1), the tab wins
  and a warning is logged.
- Downtime durations like "295 min", "11min", "1 hr 5 min" become minutes; the
  original text is kept too.

## Testing
```bash
cd supabase/functions/kiwi
deno test -A kiwi_test.ts          # SQL checks + upload validation
KIWI_DB_URL=... KIWI_MANAGER_DB_URL=... deno test -A kiwi_test.ts   # + database and full loop (fake AI)
```
Every question and query is logged with the user's email in Supabase → Edge
Functions → kiwi → Logs.

## Not built yet
- Line 2 **stops and alarms** from the PLC (`line2_dash.db`) aren't in Supabase, so KIWI
  can't yet compare supervisor-reported downtime with PLC-recorded stops. Adding them
  to `tank_sync.py` → `plc-ingest` would.
- `sync-production` isn't in this repo, so it wasn't reviewed. Give it the same
  signed-in check as `production-detail` if it doesn't already have one.
