# TPG ATS — Deployment Guide

## Prerequisites
```bash
npm install -g @google/clasp
clasp login   # Authenticate with yonatan@thepipelinegroup.io
```

## Step 1 — Create the Google Spreadsheet

In Google Drive, create a new spreadsheet named **"TPG ATS Database"** and add these 8 sheets (tabs) in order:

| Tab Name        | Columns (Row 1 headers)                                                                                    |
|-----------------|------------------------------------------------------------------------------------------------------------|
| `candidates`    | id, first_name, last_name, email, phone, job_id, stage_id, recruiter_id, source_id, region_id, motion, status, rating, linkedin_url, resume_url, notes, refuse_reason_id, kanban_state, post_hire_status, date_applied, date_last_stage_update, created_by, created_at |
| `jobs`          | id, title, department, location, region_id, status, head_count, recruiter_id, salary_range, posted_date, closes_date, posting_expires, notes, created_at |
| `history`       | id, timestamp, candidate_id, candidate_name, job_id, job_title, stage_from_id, stage_from_name, stage_to_id, stage_to_name, changed_by, days_in_previous_stage |
| `stages`        | id, name, sequence, color, is_hired, is_rejected, is_offer, target_hours, is_enabled |
| `sources`       | id, name, medium, default_motion, is_enabled |
| `regions`       | id, name, is_enabled |
| `recruiters`    | id, name, email, is_active |
| `refuse_reasons`| id, name, is_enabled |

Copy the spreadsheet ID from the URL: `https://docs.google.com/spreadsheets/d/**SPREADSHEET_ID**/edit`

## Step 2 — Create the GAS Project

```bash
cd /Users/yonatan/1\ \)\ TPG/TPG-ATS

# Create a new standalone GAS web app project
clasp create --type webapp --title "TPG Recruiting ATS"
# → Creates .clasp.json with the scriptId
```

## Step 3 — Connect Script to Spreadsheet

Option A — Use as bound script (recommended):
1. Open the Google Spreadsheet
2. Extensions → Apps Script → it creates a bound script
3. Use that script ID in `.clasp.json`

Option B — Keep standalone script:
- In `src/SheetDB.ts`, change the SheetDB constructor call to pass the spreadsheet ID:
  ```typescript
  function getDB(): SheetDB {
    if (!_db) _db = new SheetDB("YOUR_SPREADSHEET_ID_HERE");
    return _db;
  }
  ```

## Step 4 — Push Code

```bash
clasp push
```

This pushes:
- `src/*.ts` → GAS script files (`.gs`) — TypeScript compiled by GAS V8
- `frontend/*.html` → HTML template files
- `appsscript.json` → project manifest

## Step 5 — Deploy as Web App

1. In the Apps Script editor: **Deploy → New Deployment → Web App**
2. Settings:
   - **Execute as:** User accessing the web app
   - **Who has access:** Anyone in The Pipeline Group (thepipelinegroup.io)
3. Copy the deployment URL and share with Janice's team

## Step 6 — First Run

Visit the URL — `ensureDefaultData()` runs automatically and seeds:
- 9 pipeline stages (Applied → Hired/Rejected)
- 5 sources (LinkedIn, Indeed, Referral, Outbound, Other)
- 5 regions (US East, West, Central, International, Remote)
- 7 refuse reasons (No-Show, Withdrew, Failed Assessment, etc.)

## Updating After Code Changes

```bash
clasp push                    # Push code changes
# In Apps Script: Deploy → Manage Deployments → Update existing deployment
```

## Verification Checklist

- [ ] URL loads, sidebar renders with correct nav items
- [ ] Default data seeded in all 6 settings tabs
- [ ] Add Candidate → card appears in Kanban "Applied" column
- [ ] Drag card to next stage → history logged, dates updated
- [ ] Peek Panel opens with correct candidate data + history
- [ ] Reject candidate → status = Rejected, removed from active Kanban
- [ ] Add Job → appears in Jobs page and candidate form dropdown
- [ ] Delete Job with candidates → error shown, job NOT deleted
- [ ] Dashboard KPIs match raw Sheets data (manual spot-check)
- [ ] Two users can submit simultaneously (LockService prevents corruption)
- [ ] `getCurrentUserEmail()` returns each user's email correctly
- [ ] Settings → add stage → Kanban shows new column on next refresh

## Running Tests (local)

```bash
npm test    # 117 tests, all should pass
```
