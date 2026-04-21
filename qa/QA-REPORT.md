# Cloud QA Test Report — TPG Recruiting ATS

**Run date:** 2026-04-21
**Branch:** `cursor/cloud-qa-test-cad4`
**Result:** **36/36 checks pass · 4 production bugs found and fixed**

---

## What this run did

A headless Chromium driven by Playwright clicked through every interactive
flow of the ATS UI as a real recruiter would. Backend calls were served
from a local harness (`qa/server.js`) that:

- Resolves the GAS `<?!= include('foo') ?>` template tags from
  `frontend/*.html` partials so the page renders identically to a real
  `clasp push` deploy.
- Shims `google.script.run` to POST to `/api/:fn`, which dispatches to
  the real `src/Helpers.ts` and `src/Analytics.ts` business logic
  (bundled with esbuild) backed by an in-memory `ISheetDB` mock that
  matches the production seed data (9 stages, 5 sources, 5 regions,
  7 refuse reasons).

This means every check below exercises the SAME analytics, joining,
history-logging, and validation code the live GAS deploy runs — only
the spreadsheet I/O layer is mocked. The 117 existing Jest unit tests
also still pass alongside the new QA flow.

---

## Bugs found and fixed during the run

The QA harness surfaced four production bugs that block core
functionality. Every bug has been fixed on this branch and the QA
re-run is now green.

### 1. Alpine teleport templates were never initialized → every modal/peek/settings panel was dead

**Symptom:** Clicking "Add Job", "Add Candidate", a candidate row
(peek), or the settings gear updated `Alpine.store('app').modal` /
`peek` / `settingsOpen` correctly, but no modal/panel ever rendered.

**Root cause:** The three `<template x-teleport="body">` wrappers (modals,
peek panel, settings panel) sat as siblings of `<div id="app"
x-data="atsApp()">`. Alpine's initial walker only descends into `[x-data]`
roots in the live DOM, and `<template>` content is in an inert
DocumentFragment — so Alpine never visited the inner `<div x-data>` AND
never processed the outer template's `x-teleport` directive. Result:
`template._x_teleport` stayed `undefined`, the templates were silently
inert, and no modal could open.

This is a known Alpine.js quirk
([alpinejs/alpine#4461](https://github.com/alpinejs/alpine/discussions/4461)).
Bumping Alpine alone does NOT fix it — the templates must live inside
an `[x-data]` ancestor that Alpine actually walks.

**Fix:** Moved the three teleport templates inside `<div id="app">` so
Alpine's walker reaches them. Also bumped Alpine to 3.14.9 (was 3.13.5)
to pick up the upstream stability fixes.

```startLine:585:frontend/index.html
  </main>

<!--
  Modal / Peek / Settings teleport templates MUST live inside the #app
  x-data root so Alpine's initial walk reaches them. Body-level templates
  outside any x-data scope are silently skipped by Alpine 3.x's walker
  (it only enters live-DOM elements that match its root selectors), which
  meant every modal flow was dead before this move.
-->

<!-- ── Modals (Add Candidate / Add Job / Edit Job) ─────── -->
```

### 2. Bootstrap's `pointer-events: none` on `.modal-dialog` made every modal button a no-op

**Symptom:** With bug 1 fixed, modals rendered — but clicking any
button inside a modal (Save, Cancel, the X close, even form fields)
fell through to the dim `.modal-overlay` backdrop, which fired
`closeModal()` and dismissed the dialog without saving.

**Root cause:** Bootstrap 5 sets `.modal-dialog { pointer-events: none }`
in its own CSS (so its plumbing can selectively re-enable pointer events
on `.modal-content`). This app uses `.modal-dialog` directly as the
content container with no `.modal-content` wrapper, so the inherited
`pointer-events: none` cascaded to every form field and footer button.

**Fix:** Re-enable pointer events on the project's `.modal-dialog` rule.

```startLine:555:frontend/styles.css.html
.modal-dialog {
  background: white;
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
  width: 540px; max-width: 95vw;
  max-height: 90vh;
  display: flex; flex-direction: column;
  animation: scaleIn 0.18s cubic-bezier(0.4,0,0.2,1);
  /*
   * Bootstrap 5 sets `.modal-dialog { pointer-events: none }` so its
   * own modal plumbing can selectively re-enable pointer events on the
   * inner `.modal-content`. We use `.modal-dialog` as the actual content
   * container, so inherit that and clicks on form fields, footer buttons,
   * and the close icon would all fall through to the backdrop and
   * accidentally dismiss the modal. Re-enable pointer events here.
   */
  pointer-events: auto;
}
```

### 3. Cross-component refresh was using Alpine 2.x's `__x.$data` API → reload-after-save never ran

**Symptom:** With bugs 1 and 2 fixed, modals submitted successfully and
the database persisted the change — but the parent UI never refreshed.
Adding a job left "Job Openings (0)" on screen. Saving a candidate from
the peek panel did not update the list. Saving recruiters in settings
did not refresh the topbar dropdown.

**Root cause:** Both `frontend/app.js.html` (5 callsites) and
`frontend/modals.html` (2 callsites) read the root component as
`document.querySelector('#app').__x.$data`. The `__x` shortcut belongs
to **Alpine 2.x**; on Alpine 3.x it is `undefined`, so every
`refreshCandidate`, `reloadAll`, `loadCandidates`, and `getJobOpenings`
call after a save threw a silent TypeError before reaching the GAS
shim.

**Fix:** Replaced all 7 occurrences with `Alpine.$data(document.querySelector('#app'))`,
the documented Alpine 3 API.

### 4. Peek panel `init()` returned early before setting up the candidate watcher → wrong stage saved on Advance

**Symptom:** Opening a candidate's peek panel showed the right stage in
the dropdown, but clicking "Advance ›" reverted the candidate one or
more stages instead of advancing them. Reproduction: set a candidate
to "Reviewed" via the inline list dropdown, open peek, click Advance —
candidate moves to **Applied**, not **Contacted**.

**Root cause:** The peek panel's `<div class="peek-panel"
x-data="peekComponent()" x-init="init()">` is mounted as soon as the
outer `<template x-if="$store.app.peek.open">` becomes true. At that
moment, `$store.app.peek.candidate` is still `null` (the
`getCandidateDetail` fetch is in flight). The original `init()` did:

```js
init: function () {
  var c = this.$store.app.peek.candidate;
  if (!c) return;                  // ← early return
  this.editStageId = c.stage_id;
  // ...
  this.$watch('$store.app.peek.candidate', ...);  // ← never reached
},
```

So when the candidate finally loaded, the `$watch` was never set up
and `editStageId` stayed at its declared default of `0`. The
`<select x-model="editStageId">` then defaulted to its first option
("Applied"). When the user clicked Advance, the panel computed the
next stage starting from "Applied" rather than from the candidate's
real stage, and saved the wrong transition.

**Fix:** Set up the `$watch` unconditionally on mount and let the
sync handler bail when `c` is null:

```startLine:558:frontend/app.js.html
      init: function () {
        var self = this;

        function syncFromCandidate(c) {
          if (!c) return;
          self.editStageId    = c.stage_id;
          self.editRecruiterId = c.recruiter_id == null ? '' : String(c.recruiter_id);
          self.editSourceId   = c.source_id == null ? '' : String(c.source_id);
          self.editRegionId   = c.region_id == null ? '' : String(c.region_id);
          self.editMotion     = c.motion || 'Inbound';
          self.editKanban     = c.kanban_state || 'Normal';
          self.editPostHire   = c.post_hire_status || '';
          self.editNotes      = c.notes || '';
        }

        // Always set up the watcher first — when openPeek() is in flight,
        // peek.candidate is null at mount time, so a guarded init that bailed
        // here used to skip setting up the watch entirely. Result: editStageId
        // stayed at 0, the <select x-model="editStageId"> rendered "Applied"
        // (the first option), and Advance/Save persisted the wrong stage.
        this.$watch('$store.app.peek.candidate', syncFromCandidate);

        // Cover the case where candidate is already loaded by mount (e.g. open
        // a second candidate while peek is still mounted from the first one).
        syncFromCandidate(this.$store.app.peek.candidate);
      },
```

---

## Behaviour worth flagging (not fixed — may be intentional)

**Status filter zeroes out "Hires This Period" KPI.** The dashboard
sends the topbar status filter (default: "Active") into
`computeKpis(...)`, which calls `filterCandidates(...)` and drops every
non-Active candidate before counting hires. That makes the
"Hires This Period" headline always read 0 when the default Active
filter is on, which is misleading — recruiters routinely keep the
filter on Active while glancing at the hire count.

The QA test confirms the KPI works correctly when the status filter
is cleared. If this is intentional ("KPIs reflect the current view"),
consider relabelling the card to "Active Hires" or showing both. If
it isn't, `computeKpis` should compute hire counts independent of
the status filter (the period date range is a separate, more
defensible filter).

---

## Coverage — the 36 checkpoints

| § | Checkpoint | Result | Screenshot |
|---|------------|--------|------------|
| 1 | Initial load shows topbar with brand and user | PASS | [01](screenshots/01-initial-load-shows-topbar-with-brand-and-user.png) |
| 1 | Initial KPI strip renders all four cards | PASS | [02](screenshots/02-initial-kpi-strip-renders-all-four-cards.png) |
| 1 | Empty state: no candidates yet | PASS | [03](screenshots/03-empty-state-no-candidates-yet.png) |
| 1 | Sync indicator shows Live status | PASS | [04](screenshots/04-sync-indicator-shows-live-status.png) |
| 2 | Job appears in Jobs section after creation | PASS | [05](screenshots/05-job-appears-in-jobs-section-after-creation.png) |
| 2 | Two jobs visible after second add | PASS | [06](screenshots/06-two-jobs-visible-after-second-add.png) |
| 3 | Inline recruiter assignment persists after refresh | PASS | [07](screenshots/07-inline-recruiter-assignment-persists-after-refresh.png) |
| 3 | Inline job status change to On Hold persists | PASS | [08](screenshots/08-inline-job-status-change-to-on-hold-persists.png) |
| 4 | New candidate appears in list | PASS | [09](screenshots/09-new-candidate-appears-in-list.png) |
| 4 | Active Candidates KPI updates to 1 | PASS | [10](screenshots/10-active-candidates-kpi-updates-to-1.png) |
| 4 | Active Candidates KPI is 4 after bulk add | PASS | [11](screenshots/11-active-candidates-kpi-is-4-after-bulk-add.png) |
| 4 | Source-default-motion auto-set: Quinn (Outbound source) is Outbound | PASS | [12](screenshots/12-source-default-motion-auto-set-quinn-outbound-source-is-outbound.png) |
| 5 | Search filter narrows list to 1 candidate | PASS | [13](screenshots/13-search-filter-narrows-list-to-1-candidate.png) |
| 5 | Source filter narrows list to 1 candidate | PASS | [14](screenshots/14-source-filter-narrows-list-to-1-candidate.png) |
| 5 | Reset clears the filter bar | PASS | [15](screenshots/15-reset-clears-the-filter-bar.png) |
| 6 | Inline stage change persists after server roundtrip | PASS | [16](screenshots/16-inline-stage-change-persists-after-server-roundtrip.png) |
| 6 | Inline recruiter assignment persists | PASS | [17](screenshots/17-inline-recruiter-assignment-persists.png) |
| 7 | Peek opens with correct candidate name + email | PASS | [18](screenshots/18-peek-opens-with-correct-candidate-name-email.png) |
| 7 | Peek shows stage history with at least 2 entries | PASS | [19](screenshots/19-peek-shows-stage-history-with-at-least-2-entries.png) |
| 7 | Advance stage button moves Riley one stage forward | PASS | [20](screenshots/20-advance-stage-button-moves-riley-one-stage-forward.png) |
| 7 | Notes field saves on blur | PASS | [21](screenshots/21-notes-field-saves-on-blur.png) |
| 8 | Kanban view shows columns for each enabled non-rejected stage | PASS | [22](screenshots/22-kanban-view-shows-columns-for-each-enabled-non-rejected-stage.png) |
| 8 | Kanban Contacted column has Riley card | PASS | [23](screenshots/23-kanban-contacted-column-has-riley-card.png) |
| 9 | Reject moves candidate to Rejected status | PASS | [24](screenshots/24-reject-moves-candidate-to-rejected-status.png) |
| 10 | Delete-job guard prevents deleting SDR (has candidates) | PASS | [25](screenshots/25-delete-job-guard-prevents-deleting-sdr-has-candidates.png) |
| 11 | Delete-job succeeds for AE (no candidates) | PASS | [26](screenshots/26-delete-job-succeeds-for-ae-no-candidates.png) |
| 12 | Edit job modal saves the new title | PASS | [27](screenshots/27-edit-job-modal-saves-the-new-title.png) |
| 13 | Settings panel opens with 5 tabs | PASS | [28](screenshots/28-settings-panel-opens-with-5-tabs.png) |
| 13 | New recruiter saved and visible in topbar filter | PASS | [29](screenshots/29-new-recruiter-saved-and-visible-in-topbar-filter.png) |
| 14 | Stage validation: error toast for duplicate Hired flag | PASS | [30](screenshots/30-stage-validation-error-toast-for-duplicate-hired-flag.png) |
| 15 | Hires This Period KPI increments to 1 (after clearing status filter) | PASS | [31](screenshots/31-hires-this-period-kpi-increments-to-1-after-clearing-status-filter.png) |
| 16 | Pipeline canvas renders pixels (non-empty) | PASS | [32](screenshots/32-pipeline-canvas-renders-pixels-non-empty.png) |
| 16 | Source effectiveness table has rows for each used source | PASS | [33](screenshots/33-source-effectiveness-table-has-rows-for-each-used-source.png) |
| 16 | Recruiter performance table includes assigned recruiter | PASS | [34](screenshots/34-recruiter-performance-table-includes-assigned-recruiter.png) |
| 17 | Active Candidates KPI is clickable and toggles "active" class | PASS | [35](screenshots/35-active-candidates-kpi-is-clickable-and-toggles-active-class.png) |
| 18 | No uncaught JavaScript errors during the entire run | PASS | [36](screenshots/36-no-uncaught-javascript-errors-during-the-entire-run.png) |

The single console message during the run is the expected `500` from
the delete-job guard rejecting `Sales Development Rep` (which still
has candidates). That's the application's intended "no, you can't"
channel and is filtered out by the final assertion.

---

## How to re-run this QA locally

Prerequisites: `npm install` (deps already pinned in `package.json`),
plus a one-time `npx playwright install chromium` for the headless
browser.

```bash
node qa/build-bundle.js                  # rebuild qa/.bundle/logic.cjs
node qa/server.js &                      # serves the app on :4567
node qa/qa.spec.mjs                      # exit code 0 = green
```

The harness writes `qa/results.json` (machine-readable) and refreshes
`qa/screenshots/*.png`. The QA server speaks the same `google.script.run`
contract as a live GAS deploy, so adding new checks to
`qa/qa.spec.mjs` requires no further plumbing.

---

## Files added by this run

```
qa/
  build-bundle.js   esbuild config that bundles src/Helpers + src/Analytics
                    (and the DEFAULT_* seeds from src/SheetDB) into one CJS
                    file the harness can require()
  mock-db.js        in-memory ISheetDB implementation
  handlers.js       JS port of the Code.ts wrappers, calling the bundled logic
  server.js         Express server: renders index.html, serves /api/:fn,
                    /__qa/state for inspection, /healthz for the test runner
  qa.spec.mjs       Playwright script — 36 checks across 18 sections
  QA-REPORT.md      this file
  screenshots/      one full-page PNG per checkpoint
  results.json      machine-readable run record
```

The QA harness leaves `src/`, `tests/`, `frontend/`, `appsscript.json`,
`build.js`, and `package.json` build/test scripts unchanged. The four
production fixes are in `frontend/index.html`, `frontend/styles.css.html`,
`frontend/app.js.html`, and `frontend/modals.html`.
