# TPG Recruiting ATS

Interim applicant tracking system for The Pipeline Group, built as a Google Apps Script web app backed by a Google Sheet. Replaces the paused LQ HR app for Janice's recruiting team until Rippling arrives (~3 months).

## Architecture

| Layer | Tech |
|-------|------|
| Frontend | HTML + Alpine.js + Bootstrap 5 + Chart.js + SortableJS (single-page, inline-edit UX) |
| Backend | Google Apps Script (V8 runtime), bundled from TypeScript with esbuild |
| Data | Google Sheets (8 tabs: candidates, jobs, history, stages, sources, regions, recruiters, refuse_reasons) |
| Tests | Jest + ts-jest (117 unit tests — pure business logic, mocked `ISheetDB`); Playwright cloud QA (36 click-through checks, see `qa/QA-REPORT.md`) |
| Deploy | Clasp (`clasp push` + `clasp deploy`) |
| Concurrency | `LockService.getScriptLock()` wraps all writes; 15s client-side sync poll via `getSyncFingerprint` |
| Performance | Three-layer cache in `SheetDB`: per-execution row cache (de-duplicates the 8 reads in `getDashboardData` → 1 per sheet), `CacheService` settings cache (60s TTL, busted on `replace*`), and a 5s dogpile cache on the fingerprint endpoint that coalesces concurrent multi-user polls |

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

# Run the cloud QA suite — spins up a local express harness with an
# in-memory ISheetDB, runs the same Helpers/Analytics code the GAS deploy
# uses, drives Chromium through 36 click-through checks, writes
# qa/QA-REPORT.md + qa/screenshots/. Requires a one-time:
#   npx playwright install chromium
npm run qa:server &      # serves the app on http://localhost:4567
npm run qa               # runs the Playwright check suite

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

### Performance & caching
The cost model on Apps Script is dominated by `SpreadsheetApp` roundtrips (~100–300 ms each). Three caches layered in `src/SheetDB.ts` and `src/Code.ts:getSyncFingerprint` collapse that I/O:

1. **Per-execution row cache** (`SheetDB._rowCache`) — a private `Map<sheetName, rows>` populated by `_getRows` and invalidated on every write. Each GAS request gets a fresh `SheetDB` instance via `getDB()`, so the cache never crosses request boundaries. Eliminates the N-reads-per-request pattern in `getDashboardData` (was 8 sheet reads → 1 per sheet). Also lets `_nextId` and `updateCandidate/updateJob` reuse the same scan instead of issuing extra `getRange().getValues()` calls.
2. **Settings cache via `CacheService`** (60 s TTL, key prefix `tpg.ats.settings.v1.`) — covers stages, sources, regions, recruiters, refuse reasons. Shared across all users of the script, so an update via `replaceStages` (etc.) invalidates the entry immediately for everyone. Settings change rarely but get read on every dashboard load and every sync poll, so this is the largest cache hit rate.
3. **Sync fingerprint dogpile cache** (`Code.ts:SYNC_FP_CACHE_KEY`, 5 s TTL) — coalesces the ~20 polls/min generated by 5 recruiters each polling every 15 s. The first poll in any 5 s window pays the read cost; the rest get a near-instant string lookup. `userEmail` is intentionally excluded from the cached value and recomputed per call. Worst-case staleness for cross-user change detection is 5 s on top of the 15 s poll, which is still well under the 30 s baseline already inherent in the polling model.

Net effect at current data volumes: dashboard load drops from ~2 s to ~300 ms, fingerprint polling drops from ~140 sheet reads/minute (5 users × 4 polls × 7 reads) to ~10–20.

## Known trade-offs

- **No ETag-based optimistic locking** — last-write-wins on updates (acceptable for small teams)
- **Analytics computation itself is not memoized** — `computeKpis` etc. re-run on every filter change. Fine at current data volumes; the big I/O cost is the sheet reads, which *are* now cached.
- **Sync fingerprint can be up to 5 s stale** by design (dogpile cache TTL). Trade-off accepted to keep concurrent-user polling cheap.

## Tests — 117 green

Covers: `daysBetween`, `logHistory`, `joinCandidate/s`, `filterCandidates`, `computeKpis`, `computePipelineSnapshot`, `computeFunnelConversion`, `computeRecruiterPerformance`, `computeSourceEffectiveness`, `computeTimeToHireTrend`, `computeStageVelocity`, `computeSlaBreaches`, `replaceStages/Sources/Regions/Recruiters/RefuseReasons`, `seedDefaultData` idempotency, stage flag uniqueness, sequence ordering, delete-with-candidates guard, posting expiry detection.

Tests do **not** cover: Alpine.js rendering, `google.script.run` integration, Chart.js output, or multi-user race conditions — those need E2E testing against a live spreadsheet.
