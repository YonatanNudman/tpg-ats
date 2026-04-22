# AGENTS.md — context for the next AI session

This file is the next AI session's "what hurts" map. Read it before
making changes to anything in this repo. The goal is so you don't
re-walk a hunt that's already been settled.

## What this app is

A Google Apps Script web app that wraps a Google Sheet as the database
for a recruiting pipeline. Bridge tool — three-month interim while the
team migrates from per-recruiter Excel trackers to Rippling ATS +
LaunchQ BI. Small user base (5–10 recruiters), one spreadsheet, one
deployment.

## Architecture in one paragraph

`src/Code.ts` exposes a flat list of frontend-callable GAS functions
(`createCandidate`, `getDashboardData`, `bulkAdvanceStage`, etc.) that
the SPA frontend calls via `google.script.run`. `src/SheetDB.ts` is
the only thing that touches `SpreadsheetApp` — every read goes through
a per-execution row cache, every write invalidates that cache and a
shared `CacheService`-backed settings cache. `src/Analytics.ts` and
`src/Helpers.ts` are pure functions over `CandidateRow[] / JobRow[]`.
The frontend (`frontend/index.html` + `frontend/app.js.html` + `frontend/modals.html` +
`frontend/styles.css.html`) is a single Alpine.js app served as
inlined `<?!= include() ?>` templates from `Code.ts:doGet`. No build
step on the frontend; `node build.js` just bundles `src/*.ts → dist/Code.js`
via esbuild and copies the frontend HTML/JS templates as-is.

## Deploy + verify loop

```
npm test                  # 135+ jest tests, ~3s
node build.js             # bundle to dist/, runs structural checks
clasp push --force        # uploads dist/ to GAS
clasp deploy --deploymentId <ID> --description "vNN ..."
                          # promotes the upload to a versioned deploy
npm run smoke             # post-deploy reachability check
```

Production deployment ID:
`AKfycby8Uh4_8Xp0UnLwJIWob7-WRq3brrYQBNav_PHKgR2VFv6Qs_fsWQOYc2SzymX7AFupqA`

The live URL embeds that ID:
`https://script.google.com/a/macros/thepipelinegroup.io/s/<ID>/exec`

## Gotchas you will hit (and the fixes already in place)

### 1. `instanceof Date` is unreliable in the GAS V8 runtime

Cells returned by `SpreadsheetApp.getRange().getValues()` for date-typed
cells come back as Date-like objects from a different realm — they have
all the Date methods but `val instanceof Date` returns FALSE against
the local Date constructor. Sometimes they arrive as primitive strings
in `Date.prototype.toString()` format ("Wed Apr 22 2026 00:00:00
GMT-0400 (Eastern Daylight Time)") instead.

**The fix lives in `parseStr` in `src/SheetDB.ts`:** duck-type for
`.toISOString()` + `.getTime()`, AND a defensive backstop regex that
re-parses Date-toString strings into ISO. `slice(0, 10)` everywhere
downstream gives a calendar-date YYYY-MM-DD prefix that compares
correctly. **DO NOT** introduce raw lex compares on date strings, and
**DO NOT** use `Date.parse(c.date_applied).getTime()` in filters
(that's the bug that hid one candidate from the funnel for a half day).

Tests: `tests/Helpers.test.ts > parseStr` covers all three branches.

### 2. Schema columns auto-migrate on doGet

`SheetDB.validateSchema()` doesn't error when a sheet has FEWER
columns than expected — it appends the missing trailing column headers
in place. This is how `filled` was added to the jobs sheet without a
manual migration. Reads return `undefined` for new cells on existing
rows, which `parseNum` returns as 0 (the right empty default).

**If you add a new column:** add it at the END of the `*_COLS` map,
update the parser/serializer, ship — the sheet auto-pads on next read.
Mid-sequence inserts will silently corrupt every read because the
column indices change. Don't do that.

### 3. The `@blur` + `@click` double-save race

If you wire up an explicit "Save" button on a textarea that also has
`@blur="save()"`, clicking the button does this:

  1. mousedown moves focus from textarea to button
  2. textarea blur fires → save() runs synchronously
  3. `:disabled="!isDirty()"` instantly disables the button
  4. mouseup → click registers on a now-disabled button → nothing happens

User clicks Save and visually NOTHING changes (the toast comes 300ms
later in the corner, easy to miss). Pattern: ALWAYS guard with an
inflight flag (`notesSaving`) so the second invocation is a no-op,
and let the disabled logic stay open during the success-flash window
(`notesJustSaved` overrides disabled for 1.5s).

See `frontend/app.js.html` → `peekComponent.saveNotes`.

### 4. Cursor browser can't interact through GAS iframes

The deployed app runs inside a sandboxed iframe inside the Google
script.google.com chrome. Cursor's browser tool (`browser_click`,
`browser_mouse_click_xy`) cannot click into the iframe — the click
hits the outer `<iframe id="sandboxFrame">` element and stops.
Workarounds:

- For inspection: use `?debug=1` to see live state, or open the app's
  `mobilebasic` HTML view for the spreadsheet itself
- For verification of changes: rely on screenshots after navigation,
  not interaction
- For the user's actual testing: they use real browsers and it works
  fine — this is purely an automation limitation

### 5. Auto-assign IDs in Settings → Save

When the Settings UI adds a new row (recruiter, stage, source, region,
refuse_reason), it seeds `id: 0` as a "please assign me on save"
sentinel. The `replace*` methods in `SheetDB.ts` MUST run input
through `assignIds()` before writing, otherwise every new row gets
saved as `id=0` and collides with previously-added 0-id rows.
The two recruiters that broke "I can't see the recruiters" had both
collapsed to `id=0` from this bug. Fixed; tests cover it; don't
remove the `assignIds()` call from any `replace*` method.

## Live debug surface

Append `?debug=1` to the deployed URL → opens a panel showing:

- Deployed version, user, timezone, spreadsheet ID
- Schema validation result
- Per-sheet row counts
- Failure counters (last hour, via CacheService)
- Sample raw vs parsed candidate row (this is what would have caught
  the parseStr Date bug in seconds)
- Last 30 gasCall round-trips with timing + errors
- Persisted localStorage section state

This replaces the throw-away diagnostic panels we used to ship in
v25-v31 during the "candidate not in funnel" hunt. Use it first when
something looks wrong.

## When you're shipping

- Always: `npm test`, `node build.js`, `clasp push --force`,
  `clasp deploy --deploymentId <PROD_ID> --description "vN brief description"`
- Then: navigate to `?_cb=vN` to bust browser cache and verify visually
- Smoke: `npm run smoke` (idempotent reachability check)
- The user pushes to a different GitHub account than the one in
  `gh auth` by default — the per-repo credential pin is set, so
  `git push origin main` Just Works from this folder.

## What's intentionally NOT here

- Keyboard shortcuts (user said no)
- Mobile/tablet responsive (user said no — desktop only)
- Frontend modularization (would add per-page-load `include()`
  roundtrips for marginal value on a 3-month tool)
- Quota monitoring, feature flags, audit log enrichment (low value
  for the size + lifespan of this app)
- Roles/permissions, growth-ceiling planning (per user direction)

## Keep adding to this file

If you spend more than 30 minutes hunting something non-obvious, add a
section here. The compounding payoff is huge.
