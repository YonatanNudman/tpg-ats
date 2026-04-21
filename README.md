# TPG Recruiting ATS

Interim applicant tracking system for The Pipeline Group, built as a Google Apps Script web app backed by a Google Sheet. Replaces the paused LQ HR app for Janice's recruiting team until Rippling arrives (~3 months).

## Architecture

| Layer | Tech |
|-------|------|
| Frontend | HTML + Alpine.js + Bootstrap 5 + Chart.js + SortableJS (single-page, inline-edit UX) |
| Backend | Google Apps Script (V8 runtime), bundled from TypeScript with esbuild |
| Data | Google Sheets (8 tabs: candidates, jobs, history, stages, sources, regions, recruiters, refuse_reasons) |
| Tests | Jest + ts-jest (117 unit tests — pure business logic, mocked `ISheetDB`) |
| Deploy | Clasp (`clasp push` + `clasp deploy`) |
| Concurrency | `LockService.getScriptLock()` wraps all writes; 15s client-side sync poll via `getSyncFingerprint` |

## Directory layout

```
src/
  types.ts         TypeScript interfaces + ISheetDB contract
  SheetDB.ts       Google Sheets I/O (only file that calls SpreadsheetApp)
  Analytics.ts     Pure analytics functions (KPIs, funnel, velocity, SLA, etc.)
  Helpers.ts       logHistory, joinCandidate, daysBetween, user email
  Code.ts          doGet() + all frontend-callable functions
frontend/
  index.html       One-page shell: topbar + filters + KPIs + table + jobs + analytics
  app.js.html      Alpine.js store + atsApp() + peekComponent() + settingsComponent()
  modals.html      Add Candidate / Add+Edit Job modals
  styles.css.html  Single-page styles (matches LQ HR MudBlazor palette)
tests/
  Analytics.test.ts    40+ tests for all analytics functions
  Candidates.test.ts   filter/join/logHistory/seed-data tests
  Helpers.test.ts      daysBetween, logHistory, joinCandidate
  Jobs.test.ts         CRUD guard, status filter, expiry detection
  Settings.test.ts     replace* contract, stage flag validation, idempotent seeding
build.js           esbuild bundler → dist/Code.js (strips ES modules for GAS)
appsscript.json    GAS manifest (webapp: DOMAIN access, USER_ACCESSING execute)
tsconfig.json      For Jest (module: commonjs)
tsconfig.gas.json  For GAS bundle compilation
```

## Build / Test / Deploy

```bash
# Install deps
npm install

# Run unit tests (117 tests)
npm test

# Build bundle (TS → dist/Code.js + copies frontend/ + appsscript.json)
node build.js

# Push to GAS (requires clasp login + .clasp.json with your scriptId)
clasp push --force

# Update existing deployment
clasp deploy --deploymentId <DEPLOYMENT_ID> --description "Release notes"
```

## Key design notes

### SheetDB abstraction
All `SpreadsheetApp` calls are isolated in `src/SheetDB.ts`. Every business-logic function takes an `ISheetDB` interface, which makes the logic fully unit-testable without touching Google's servers. Tests inject `jest.fn()` mocks.

### GAS-compatible bundle
TypeScript source uses standard ES6 `import`/`export` for the type system. `build.js` runs esbuild with `format: 'esm'`, `treeShaking: false`, then post-processes to strip `export` keywords — leaving plain function declarations that GAS V8 can run as globals.

### Single-page inline UX
Matches the original LQ HR app's pattern: one scrollable page with a global filter bar, KPI cards with inline drill-downs, a candidates table where stage/recruiter/source/motion are inline dropdowns (save on change), a collapsible jobs section, collapsible analytics with charts, and a right-side peek panel for candidate detail. No sidebar navigation, no separate pages.

### Multi-user sync
Client polls `getSyncFingerprint` every 15s (skipped when tab is hidden or peek panel is open). The fingerprint is a lightweight signature of candidate/job state — if it changes, the client reloads. `LockService` on the backend prevents concurrent-write corruption.

## Known trade-offs

- **Reject flow** uses a `prompt()` for reason ID (interim — will become a proper dialog)
- **No ETag-based optimistic locking** — last-write-wins on updates (acceptable for small teams)
- **Analytics are computed on every filter change** (not cached) — fine at current data volumes

## Tests — 117 green

Covers: `daysBetween`, `logHistory`, `joinCandidate/s`, `filterCandidates`, `computeKpis`, `computePipelineSnapshot`, `computeFunnelConversion`, `computeRecruiterPerformance`, `computeSourceEffectiveness`, `computeTimeToHireTrend`, `computeStageVelocity`, `computeSlaBreaches`, `replaceStages/Sources/Regions/Recruiters/RefuseReasons`, `seedDefaultData` idempotency, stage flag uniqueness, sequence ordering, delete-with-candidates guard, posting expiry detection.

Tests do **not** cover: Alpine.js rendering, `google.script.run` integration, Chart.js output, or multi-user race conditions — those need E2E testing against a live spreadsheet.
