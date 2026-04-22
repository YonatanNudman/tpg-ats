/**
 * Code.ts — Google Apps Script entry point.
 *
 * All functions declared here are callable from the frontend via
 * google.script.run.functionName(args).
 *
 * Import statements are used for TypeScript type-checking only.
 * Clasp strips import/export when pushing to GAS — all symbols
 * become globally available in the GAS runtime (V8 engine).
 *
 * Jest compiles imports to CommonJS require() for unit tests.
 * Code.ts itself is not directly unit-tested (it depends on GAS APIs);
 * its pure-logic helpers are tested via Analytics.test.ts, Helpers.test.ts, etc.
 */

import { SheetDB } from "./SheetDB";
import {
  logHistory,
  joinCandidate,
  joinCandidates,
  todayStr,
  nowStr,
  getCurrentUserEmail as getSessionEmail,
} from "./Helpers";
import {
  // computeKpis + computePipelineSnapshot used to feed the dashboard bundle
  // but the funnel-primary frontend doesn't consume them. They remain
  // exported from Analytics.ts for the unit tests and as building blocks
  // for any future endpoint that needs them.
  computeFunnelConversion,
  computeRecruiterPerformance,
  computeSourceEffectiveness,
  computeTimeToHireTrend,
  computeStageVelocity,
  computeSlaBreaches,
  computeStaleCandidates,
} from "./Analytics";
import type {
  SettingsResult,
  StageRow,
  SourceRow,
  RegionRow,
  RecruiterRow,
  RefuseReasonRow,
  CandidateFilters,
  CandidateRow,
  CandidateDetailResult,
  CreateCandidateInput,
  UpdateCandidateInput,
  JobRow,
  CreateJobInput,
  UpdateJobInput,
  DashboardFilters,
  DashboardResult,
} from "./types";

// ============================================================
// Web App entry point
// ============================================================

function doGet(_e: GoogleAppsScript.Events.DoGet): GoogleAppsScript.HTML.HtmlOutput {
  // Schema sanity check before serving HTML. Catches the "someone renamed
  // a sheet in the UI" / "someone deleted a column" class of failure with
  // a clear human-readable error page instead of letting the app load and
  // crash later inside a random handler with an opaque undefined-object
  // error. Cheap (just looks up sheets + reads getLastColumn per sheet).
  try {
    const validation = getDB().validateSchema();
    if (!validation.ok) {
      return _renderSchemaErrorPage(validation.errors);
    }
  } catch (err) {
    // Validator itself threw — usually means the spreadsheet ID is
    // wrong, the script doesn't have permission, or Sheets API is down.
    // Still surface something helpful instead of a 500.
    const msg = (err as Error)?.message || String(err);
    return _renderSchemaErrorPage([`Could not access spreadsheet: ${msg}`]);
  }

  ensureDefaultData();
  return HtmlService.createTemplateFromFile("frontend/index")
    .evaluate()
    .setTitle("TPG Recruiting ATS")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Friendly error page for schema validation failures. Inline HTML so we
 * don't depend on the frontend templates rendering correctly to surface
 * what's wrong with them. Keeps the message blunt and actionable —
 * tells the user (typically a TPG admin) exactly which sheet/columns
 * are missing and links to the source spreadsheet.
 */
function _renderSchemaErrorPage(errors: string[]): GoogleAppsScript.HTML.HtmlOutput {
  const items = errors.map(e => `<li>${e.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</li>`).join("");
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`;
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>TPG ATS — Setup needed</title>
        <style>
          body { font: 15px/1.5 system-ui, -apple-system, sans-serif; color: #1a1a2e;
                 max-width: 720px; margin: 60px auto; padding: 0 24px; }
          h1   { color: #E14B4B; font-size: 22px; margin-bottom: 6px; }
          .lead{ color: #5b6178; margin-bottom: 24px; }
          ul   { background: #fff5f5; border-left: 4px solid #E14B4B;
                 padding: 12px 16px 12px 36px; border-radius: 4px; }
          li   { margin: 4px 0; }
          a    { color: #F2831F; font-weight: 600; }
          .footer { margin-top: 28px; font-size: 13px; color: #8a90a2; }
        </style>
      </head>
      <body>
        <h1>TPG ATS can't start — spreadsheet schema mismatch</h1>
        <p class="lead">
          The web app refuses to load because the backing spreadsheet is
          missing one or more sheets/columns the app expects.
        </p>
        <ul>${items}</ul>
        <p>
          Open the
          <a href="${sheetUrl}" target="_blank" rel="noopener">backing spreadsheet</a>
          and either restore the missing structure or recreate the
          mentioned sheet with the listed columns in order.
        </p>
        <p class="footer">
          Why this page instead of the app: the app would crash with
          opaque errors halfway through loading. Failing here lets you
          fix the schema and retry without guessing.
        </p>
      </body>
    </html>
  `;
  return HtmlService.createHtmlOutput(html)
    .setTitle("TPG ATS — Setup needed")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Inlines an HTML partial from the frontend/ directory.
 * Called inside index.html via <?!= include('styles.css') ?>
 * All frontend files are pushed under the 'frontend/' prefix by clasp.
 */
function include(filename: string): string {
  return HtmlService.createHtmlOutputFromFile("frontend/" + filename).getContent();
}

// ============================================================
// Shared DB instance (lazily initialized on first request)
// ============================================================

// HR APP spreadsheet — the single source of truth for all ATS data.
// Using openById (not getActiveSpreadsheet) so this works whether the
// script is bound to the sheet or deployed as standalone.
const SPREADSHEET_ID = "1DsAZf0kaKZaYqcZDc4SzgmAvLLME5LOBYIYValoOOcE";

let _db: SheetDB | null = null;

function getDB(): SheetDB {
  if (!_db) _db = new SheetDB(SPREADSHEET_ID);
  return _db;
}

function withLock<T>(fn: () => T): T {
  const lock = LockService.getScriptLock();
  lock.waitLock(30_000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// Error message normalization
// ============================================================
//
// Catches the most common backend failure shapes and rewrites them
// into actionable user-readable messages so the toast tells the user
// what to do, not just that something broke. Previously the frontend
// surfaced raw "TypeError: undefined is not an object…" strings,
// which are useless to a recruiter trying to decide whether to retry,
// refresh, or escalate.
//
// Categories also feed the failure counter so the ?debug=1 panel can
// show "9 lock-timeout failures in the last hour" at a glance.
//
// Conflict prefix is preserved untouched — the frontend matches on it
// to surface a Reload action button, and rewriting the prefix would
// silently break that detection.

function _humanizeError(err: unknown, context: string): Error {
  const raw = err instanceof Error ? err.message : String(err);
  let category = "unknown";
  let humanMsg = raw;

  if (raw.startsWith(CONFLICT_PREFIX)) {
    // Don't touch — frontend depends on this prefix for the Reload affordance.
    category = "conflict";
    humanMsg = raw;
  } else if (/Lock(Service)?.*(timeout|wait)/i.test(raw) || raw.includes("lock could not be acquired")) {
    category = "lock-timeout";
    humanMsg = "The sheet is busy with another save. Try again in a moment.";
  } else if (raw.includes("not found") || raw.includes("Not found")) {
    category = "not-found";
    humanMsg = raw;   // these are already actionable ("Candidate 42 not found")
  } else if (/Quota|exceeded.*time/i.test(raw)) {
    category = "quota";
    humanMsg = "Hit a Google Apps Script quota limit. Wait a minute and retry; if it persists, contact admin.";
  } else if (/permission|authoriz/i.test(raw)) {
    category = "permission";
    humanMsg = "Permission denied. You may need to refresh the page to re-authenticate.";
  } else if (/network|fetch|connect/i.test(raw)) {
    category = "network";
    humanMsg = "Network error reaching the sheet. Check your connection and retry.";
  } else if (/required/i.test(raw) && raw.length < 80) {
    category = "validation";
    humanMsg = raw;
  } else {
    // Unknown shape — keep the raw message but prefix with a hint so
    // the recruiter knows it's worth surfacing rather than retrying.
    category = "unknown";
    humanMsg = "Unexpected error: " + raw + " — refresh and retry; if it sticks, copy this message to support.";
  }

  _bumpFailureCounter(context + ":" + category);
  return new Error(humanMsg);
}

// Wraps every frontend-callable function in a try/catch that normalizes
// the error before re-throwing. google.script.run ferries the message
// across to the client; the rewritten message is what the user sees.
function _wrapHandler<TArgs extends unknown[], TReturn>(
  name: string,
  fn: (...args: TArgs) => TReturn,
): (...args: TArgs) => TReturn {
  return function (...args: TArgs): TReturn {
    try {
      return fn(...args);
    } catch (err) {
      throw _humanizeError(err, name);
    }
  };
}

// ============================================================
// Settings / Initialization
// ============================================================

function ensureDefaultData(): void {
  getDB().seedDefaultData();
}

function getSettings(): SettingsResult {
  const db = getDB();
  return {
    stages:        db.getAllStages(),
    sources:       db.getAllSources(),
    regions:       db.getAllRegions(),
    recruiters:    db.getAllRecruiters(),
    refuseReasons: db.getAllRefuseReasons(),
  };
}

function saveStages(stages: StageRow[]): void {
  withLock(() => getDB().replaceStages(stages));
}

function saveSources(sources: SourceRow[]): void {
  withLock(() => getDB().replaceSources(sources));
}

function saveRegions(regions: RegionRow[]): void {
  withLock(() => getDB().replaceRegions(regions));
}

function saveRecruiters(recruiters: RecruiterRow[]): void {
  withLock(() => getDB().replaceRecruiters(recruiters));
}

function saveRefuseReasons(reasons: RefuseReasonRow[]): void {
  withLock(() => getDB().replaceRefuseReasons(reasons));
}

/**
 * Frontend-callable: returns the active user's email.
 * Bundles as a top-level GAS function so google.script.run can invoke it by name.
 */
function getCurrentUserEmail(): string {
  return getSessionEmail();
}

// ============================================================
// Candidate functions
// ============================================================

function getCandidates(filters: CandidateFilters): CandidateRow[] {
  const db = getDB();
  let all = db.getAllCandidates();

  if (filters.jobId)       all = all.filter(c => c.job_id       === filters.jobId);
  if (filters.stageId)     all = all.filter(c => c.stage_id     === filters.stageId);
  if (filters.recruiterId) all = all.filter(c => c.recruiter_id === filters.recruiterId);
  if (filters.sourceId)    all = all.filter(c => c.source_id    === filters.sourceId);
  if (filters.regionId)    all = all.filter(c => c.region_id    === filters.regionId);
  if (filters.motion)      all = all.filter(c => c.motion       === filters.motion);
  if (filters.status)      all = all.filter(c => c.status       === filters.status);

  if (filters.search) {
    const q = filters.search.toLowerCase();
    all = all.filter(c =>
      `${c.first_name} ${c.last_name}`.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q)
    );
  }

  // Calendar-date comparison (slice to YYYY-MM-DD on both sides) so a
  // candidate whose date_applied was stored at midnight in a non-UTC
  // locale (Sheets coerces date cells to native Date in the spreadsheet's
  // timezone) doesn't get filtered out of a same-day endDate window.
  // See dateOnly() in Analytics.ts for the full rationale.
  if (filters.startDate) {
    const start = String(filters.startDate).slice(0, 10);
    all = all.filter(c => {
      const d = String(c.date_applied || "").slice(0, 10);
      return !d || d >= start;
    });
  }
  if (filters.endDate) {
    const end = String(filters.endDate).slice(0, 10);
    all = all.filter(c => {
      const d = String(c.date_applied || "").slice(0, 10);
      return !d || d <= end;
    });
  }

  return joinCandidates(all, db);
}

/**
 * Duplicate-candidate check by email (case-insensitive, trimmed).
 * Returns a list of matching candidates with enough info for the UI to
 * offer "Open existing" / "Add anyway" choices. Email match is the
 * conservative signal — phone collisions are noisy; name collisions are
 * frequent among common names.
 */
function findDuplicateCandidatesByEmail(email: string): CandidateRow[] {
  if (!email) return [];
  const db = getDB();
  const needle = String(email).trim().toLowerCase();
  if (!needle) return [];
  const matches = db.getAllCandidates().filter(c =>
    (c.email || "").trim().toLowerCase() === needle
  );
  if (matches.length === 0) return [];
  // Join so the UI can show job title + stage name + status, not just IDs
  return matches.map(c => joinCandidate(
    c,
    db.getAllStages(),
    db.getAllJobs(),
    db.getAllRecruiters(),
    db.getAllSources(),
    db.getAllRegions(),
    db.getAllRefuseReasons()
  ));
}

function getCandidateDetail(id: number): CandidateDetailResult {
  const db = getDB();
  const candidate = db.getCandidateById(id);
  if (!candidate) throw new Error(`Candidate ${id} not found`);

  return {
    candidate: joinCandidate(
      candidate,
      db.getAllStages(),
      db.getAllJobs(),
      db.getAllRecruiters(),
      db.getAllSources(),
      db.getAllRegions(),
      db.getAllRefuseReasons()
    ),
    history: db.getHistoryForCandidate(id),
  };
}

function createCandidate(data: CreateCandidateInput): CandidateRow {
  return withLock(() => {
    const db = getDB();
    const stages = db.getAllStages()
      .filter(s => s.is_enabled)
      .sort((a, b) => a.sequence - b.sequence);
    if (stages.length === 0) throw new Error("No pipeline stages configured");

    const firstStage = stages[0];
    const today = todayStr();
    const userEmail = getSessionEmail();

    // Auto-set motion from source default if not explicitly provided
    let motion = data.motion ?? "Inbound";
    if (data.source_id) {
      const src = db.getAllSources().find(s => s.id === data.source_id);
      if (src) motion = src.default_motion;
    }

    const candidate = db.appendCandidate({
      first_name:             data.first_name,
      last_name:              data.last_name,
      email:                  data.email,
      phone:                  data.phone,
      job_id:                 data.job_id,
      stage_id:               firstStage.id,
      recruiter_id:           data.recruiter_id ?? null,
      source_id:              data.source_id ?? null,
      region_id:              data.region_id ?? null,
      motion,
      status:                 "Active",
      rating:                 0,
      linkedin_url:           data.linkedin_url ?? "",
      resume_url:             "",
      notes:                  data.notes ?? "",
      refuse_reason_id:       null,
      kanban_state:           "Normal",
      post_hire_status:       "",
      date_applied:           today,
      date_last_stage_update: today,
      created_by:             userEmail,
      created_at:             nowStr(),
    });

    const job = db.getJobById(data.job_id);
    logHistory(
      db,
      candidate.id, `${data.first_name} ${data.last_name}`,
      data.job_id, job?.title ?? "",
      null, "",                         // null from_stage = initial placement
      firstStage.id, firstStage.name,
      userEmail, today
    );

    return candidate;
  });
}

// ============================================================
// Conflict detection (poor-man's optimistic locking)
// ============================================================
//
// All candidate writes accept an optional `expectedDate` argument — the
// `date_last_stage_update` value the client last loaded. If the server's
// current value is newer (i.e. a teammate has since touched this
// candidate), the write is rejected with a CONFLICT_PREFIX error so the
// frontend can prompt the user to reload + retry instead of silently
// overwriting.
//
// Known limitation: date_last_stage_update only bumps on stage changes,
// so concurrent edits to OTHER fields (recruiter assignment, notes,
// etc.) on the same candidate at the same time still last-write-wins.
// Catching those would require an `updated_at` column + sheet migration,
// which is out of scope for this 3-month interim tool. The high-value
// case — two recruiters racing to advance the same candidate's stage —
// is fully covered.
const CONFLICT_PREFIX = "CONFLICT: ";

function _assertNoConflict(currentDate: string, expectedDate?: string | null): void {
  if (!expectedDate) return;   // legacy caller / opt-out
  if (currentDate && currentDate !== expectedDate) {
    throw new Error(
      `${CONFLICT_PREFIX}This candidate was updated by someone else after you loaded it. ` +
      `Reload to see the latest changes, then retry.`
    );
  }
}

function updateCandidate(id: number, data: UpdateCandidateInput, expectedDate?: string): void {
  withLock(() => {
    const db = getDB();
    const candidate = db.getCandidateById(id);
    if (!candidate) throw new Error(`Candidate ${id} not found`);
    _assertNoConflict(candidate.date_last_stage_update, expectedDate);
    db.updateCandidate(id, data);
  });
}

function updateCandidateStage(id: number, newStageId: number, expectedDate?: string): void {
  withLock(() => {
    const db = getDB();
    const candidate = db.getCandidateById(id);
    if (!candidate) throw new Error(`Candidate ${id} not found`);
    if (candidate.stage_id === newStageId) return;
    _assertNoConflict(candidate.date_last_stage_update, expectedDate);

    const stages = db.getAllStages();
    const fromStage = stages.find(s => s.id === candidate.stage_id);
    const toStage   = stages.find(s => s.id === newStageId);
    if (!toStage) throw new Error(`Stage ${newStageId} not found`);

    const userEmail = getSessionEmail();
    const today = todayStr();

    let newStatus = candidate.status;
    if (toStage.is_hired)    newStatus = "Hired";
    else if (toStage.is_rejected) newStatus = "Rejected";

    logHistory(
      db,
      id, `${candidate.first_name} ${candidate.last_name}`,
      candidate.job_id, "",
      candidate.stage_id, fromStage?.name ?? "",
      newStageId, toStage.name,
      userEmail, candidate.date_last_stage_update
    );

    db.updateCandidate(id, {
      stage_id:               newStageId,
      status:                 newStatus,
      date_last_stage_update: today,
    });
  });
}

function rejectCandidate(id: number, refuseReasonId: number, expectedDate?: string): void {
  withLock(() => {
    const db = getDB();
    const candidate = db.getCandidateById(id);
    if (!candidate) throw new Error(`Candidate ${id} not found`);
    _assertNoConflict(candidate.date_last_stage_update, expectedDate);

    const stages = db.getAllStages();
    const rejectedStage = stages.find(s => s.is_rejected && s.is_enabled);
    if (!rejectedStage) throw new Error("No rejected stage configured");

    const fromStage = stages.find(s => s.id === candidate.stage_id);
    const userEmail = getSessionEmail();
    const today = todayStr();

    logHistory(
      db,
      id, `${candidate.first_name} ${candidate.last_name}`,
      candidate.job_id, "",
      candidate.stage_id, fromStage?.name ?? "",
      rejectedStage.id, rejectedStage.name,
      userEmail, candidate.date_last_stage_update
    );

    db.updateCandidate(id, {
      stage_id:               rejectedStage.id,
      status:                 "Rejected",
      refuse_reason_id:       refuseReasonId,
      date_last_stage_update: today,
    });
  });
}

function deleteCandidate(id: number): void {
  withLock(() => getDB().deleteCandidate(id));
}

function assignRecruiter(id: number, recruiterId: number): void {
  withLock(() => getDB().updateCandidate(id, { recruiter_id: recruiterId }));
}

// ============================================================
// Bulk operations — batch endpoints for the multi-select UI
// ============================================================
//
// Each bulk endpoint runs every individual write in a single withLock
// span so the whole batch is atomic relative to other writers (no
// interleaving with a single-row save mid-batch). Per-row failures
// don't abort the rest — the result envelope reports per-id success
// so the UI can highlight the failures and let the user retry just
// those. This matters when 50+ candidates are being processed and a
// single conflict shouldn't tank the whole bulk.
//
// All bulk endpoints follow the same shape so the frontend can use
// a single executeBulk() helper:
//   { successIds: [...], failures: [{ id, message }] }
//
// Conflict detection is OPT-IN per row (each id can carry an
// expectedDate) but bulk usage typically passes none — the UX is
// "I have these N people in front of me, advance them all" and a
// stale read is acceptable for a batch operation.

interface BulkResult {
  successIds: number[];
  failures: Array<{ id: number; message: string }>;
}

function _runBulk(
  ids: number[],
  perRow: (id: number) => void,
): BulkResult {
  const successIds: number[] = [];
  const failures: Array<{ id: number; message: string }> = [];
  // Single lock span for the whole batch so concurrent single-row
  // writes don't slip in between bulk steps and produce surprising
  // mid-batch state.
  withLock(() => {
    for (const rawId of ids) {
      const id = Number(rawId);
      if (!id || isNaN(id)) {
        failures.push({ id: rawId, message: "Invalid id" });
        continue;
      }
      try {
        perRow(id);
        successIds.push(id);
      } catch (e: unknown) {
        // Humanize per-row failures so the action-bar toast tells the
        // user something useful even when the batch is half-failed,
        // e.g. "Candidate 42 not found" instead of "TypeError: ...".
        const humanized = _humanizeError(e, "bulk");
        failures.push({ id, message: humanized.message });
      }
    }
  });
  return { successIds, failures };
}

function bulkAdvanceStage(ids: number[], targetStageId: number): BulkResult {
  if (!Array.isArray(ids) || ids.length === 0) return { successIds: [], failures: [] };
  const stageId = Number(targetStageId);
  if (!stageId) throw new Error("targetStageId required");

  const db = getDB();
  const targetStage = db.getAllStages().find(s => s.id === stageId);
  if (!targetStage) throw new Error(`Stage ${stageId} not found`);
  if (!targetStage.is_enabled) throw new Error(`Stage "${targetStage.name}" is not enabled`);

  const stages = db.getAllStages();
  const userEmail = getSessionEmail();
  const today = todayStr();

  return _runBulk(ids, function (id) {
    const candidate = db.getCandidateById(id);
    if (!candidate) throw new Error(`Candidate ${id} not found`);
    if (candidate.stage_id === stageId) return;   // already there, no-op success

    const fromStage = stages.find(s => s.id === candidate.stage_id);
    let newStatus = candidate.status;
    if (targetStage.is_hired)         newStatus = "Hired";
    else if (targetStage.is_rejected) newStatus = "Rejected";

    logHistory(
      db,
      id, `${candidate.first_name} ${candidate.last_name}`,
      candidate.job_id, "",
      candidate.stage_id, fromStage?.name ?? "",
      stageId, targetStage.name,
      userEmail, candidate.date_last_stage_update,
    );

    db.updateCandidate(id, {
      stage_id:               stageId,
      status:                 newStatus,
      date_last_stage_update: today,
    });
  });
}

function bulkAssignRecruiter(ids: number[], recruiterId: number | null): BulkResult {
  if (!Array.isArray(ids) || ids.length === 0) return { successIds: [], failures: [] };
  const rid = recruiterId == null ? null : Number(recruiterId);

  const db = getDB();
  if (rid != null) {
    const r = db.getAllRecruiters().find(x => x.id === rid);
    if (!r) throw new Error(`Recruiter ${rid} not found`);
  }

  return _runBulk(ids, function (id) {
    const candidate = db.getCandidateById(id);
    if (!candidate) throw new Error(`Candidate ${id} not found`);
    db.updateCandidate(id, { recruiter_id: rid });
  });
}

function bulkRejectCandidates(ids: number[], refuseReasonId: number): BulkResult {
  if (!Array.isArray(ids) || ids.length === 0) return { successIds: [], failures: [] };
  const reasonId = Number(refuseReasonId);
  if (!reasonId) throw new Error("refuseReasonId required");

  const db = getDB();
  const stages = db.getAllStages();
  const rejectedStage = stages.find(s => s.is_rejected && s.is_enabled);
  if (!rejectedStage) throw new Error("No rejected stage configured");

  const userEmail = getSessionEmail();
  const today = todayStr();

  return _runBulk(ids, function (id) {
    const candidate = db.getCandidateById(id);
    if (!candidate) throw new Error(`Candidate ${id} not found`);
    if (candidate.status === "Rejected") return;   // already rejected, no-op success

    const fromStage = stages.find(s => s.id === candidate.stage_id);
    logHistory(
      db,
      id, `${candidate.first_name} ${candidate.last_name}`,
      candidate.job_id, "",
      candidate.stage_id, fromStage?.name ?? "",
      rejectedStage.id, rejectedStage.name,
      userEmail, candidate.date_last_stage_update,
    );

    db.updateCandidate(id, {
      stage_id:               rejectedStage.id,
      status:                 "Rejected",
      refuse_reason_id:       reasonId,
      date_last_stage_update: today,
    });
  });
}

function updateKanbanState(id: number, state: "Normal" | "Blocked" | "Ready"): void {
  withLock(() => getDB().updateCandidate(id, { kanban_state: state }));
}

function updatePostHireStatus(id: number, status: CandidateRow["post_hire_status"]): void {
  withLock(() => getDB().updateCandidate(id, { post_hire_status: status }));
}

// ============================================================
// Job functions
// ============================================================

function getJobOpenings(statusFilter?: string): JobRow[] {
  const db = getDB();
  const jobs = db.getAllJobs();
  const regions    = db.getAllRegions();
  const recruiters = db.getAllRecruiters();
  const candidates = db.getAllCandidates();
  const regionMap    = new Map(regions.map(r    => [r.id, r.name]));
  const recruiterMap = new Map(recruiters.map(r => [r.id, r.name]));

  return jobs
    .filter(j => !statusFilter || j.status === statusFilter)
    .map(j => ({
      ...j,
      region_name:    j.region_id    ? (regionMap.get(j.region_id)       ?? "") : "",
      recruiter_name: j.recruiter_id ? (recruiterMap.get(j.recruiter_id) ?? "") : "",
      candidate_count: candidates.filter(c => c.job_id === j.id && c.status === "Active").length,
    }))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

function createJobOpening(data: CreateJobInput): JobRow {
  return withLock(() =>
    getDB().appendJob({
      title:           data.title,
      department:      data.department,
      location:        data.location,
      region_id:       data.region_id ?? null,
      status:          data.status,
      head_count:      data.head_count,
      filled:          data.filled ?? 0,
      recruiter_id:    data.recruiter_id ?? null,
      salary_range:    data.salary_range ?? "",
      posted_date:     data.posted_date  ?? todayStr(),
      closes_date:     data.closes_date  ?? "",
      posting_expires: data.posting_expires ?? "",
      notes:           data.notes ?? "",
      created_at:      nowStr(),
    })
  );
}

function updateJobOpening(id: number, data: UpdateJobInput): void {
  withLock(() => getDB().updateJob(id, data));
}

function deleteJobOpening(id: number): void {
  withLock(() => {
    const db = getDB();
    const hasCandidate = db.getAllCandidates().some(c => c.job_id === id);
    if (hasCandidate) {
      throw new Error("Cannot delete a job with existing candidates. Close the job instead.");
    }
    db.deleteJob(id);
  });
}

// ============================================================
// Dashboard
// ============================================================

/**
 * Dashboard bundle for the funnel-primary layout.
 *
 * Trimmed (see DashboardResult comment in types.ts): no longer computes
 * KPI strip metrics, the pipeline snapshot bar chart, or the recent-hires
 * list — those are either unused by the new UI or fetched separately.
 *
 * Drops three calls (computeKpis, computePipelineSnapshot, joinCandidates +
 * recentHires sort) per dashboard request. At a few candidates that's
 * micro-optimization; once the workspace grows past a few hundred rows it
 * compounds nicely with the per-execution row cache.
 */
function getDashboardData(filters: DashboardFilters): DashboardResult {
  const db = getDB();
  const candidates  = db.getAllCandidates();
  const jobs        = db.getAllJobs();
  const stages      = db.getAllStages();
  const sources     = db.getAllSources();
  const recruiters  = db.getAllRecruiters();
  const allHistory  = db.getAllHistory();   // single scan, used by funnel + velocity

  return {
    funnelConversion:     computeFunnelConversion(allHistory, stages, filters),
    recruiterPerformance: computeRecruiterPerformance(candidates, recruiters, filters),
    sourceEffectiveness:  computeSourceEffectiveness(candidates, sources, filters),
    timeToHireTrend:      computeTimeToHireTrend(candidates),
    stageVelocity:        computeStageVelocity(allHistory, stages, filters),
    slaBreaches:          computeSlaBreaches(candidates, stages, recruiters, jobs, filters),
    staleCandidates:      computeStaleCandidates(candidates, stages, recruiters, jobs, filters),
  };
}

// ============================================================
// Per-section dashboard endpoints
// ============================================================
//
// The funnel-primary dashboard layout lets each section have its own
// filter row that overrides the global filters. To keep network round
// trips light, each section gets a standalone endpoint that recomputes
// only its own slice — instead of re-running the entire getDashboardData
// bundle every time one filter changes anywhere on the page.
//
// All three endpoints share the per-execution row cache in SheetDB, so
// once one of them populates the candidates+settings reads, the others
// in the same execution are essentially free. They DON'T share between
// executions (each frontend call is its own GAS request).

// (getPipelineFunnel removed — the frontend computes the funnel client-side
//  from `allCandidates`, since the data is already loaded for other dashboards
//  and per-section filter changes don't need a network round trip. Re-add
//  here if a server-side compute becomes useful, e.g. when the candidate
//  list grows past what's reasonable to ship to the browser.)

/**
 * Recruiter performance leaderboard — supports an OPTIONAL `hiresFilters`
 * override so the dashboard's "Hires period" picker can scope just the
 * Hires column independently of the rest of the table.
 */
function getRecruiterPerformance(
  filters: DashboardFilters,
  hiresFilters?: DashboardFilters
): import("./types").RecruiterPerformanceItem[] {
  const db = getDB();
  return computeRecruiterPerformance(
    db.getAllCandidates(),
    db.getAllRecruiters(),
    filters,
    hiresFilters
  );
}

function getSourceEffectiveness(filters: DashboardFilters): import("./types").SourceEffectivenessItem[] {
  const db = getDB();
  return computeSourceEffectiveness(db.getAllCandidates(), db.getAllSources(), filters);
}

// ============================================================
// Multi-user sync fingerprint
// ============================================================

/**
 * Computes the raw fingerprint signature. Settings reads (5 of the 7 sheet
 * reads here) are now CacheService-backed in SheetDB, so on a warm cache
 * they cost ~5ms instead of ~5×200ms. Candidates + jobs still require full
 * reads to detect status/stage/title edits.
 */
function _computeSyncFingerprint(db: SheetDB): string {
  const candidates = db.getAllCandidates();
  const jobs = db.getAllJobs();

  // ── Candidates signal: detect adds, stage changes, status changes ──
  let maxCandidateId = 0;
  let latestStageUpdate = "";
  let activeCount = 0;
  for (const c of candidates) {
    if (c.id > maxCandidateId) maxCandidateId = c.id;
    if (c.date_last_stage_update > latestStageUpdate) latestStageUpdate = c.date_last_stage_update;
    if (c.status === "Active") activeCount++;
  }

  // ── Jobs signal: catch edits (status change, title rename), not just adds ──
  let jobHash = 0;
  let maxJobId = 0;
  for (const j of jobs) {
    if (j.id > maxJobId) maxJobId = j.id;
    jobHash = (jobHash + j.id * 31 + (j.status || "").length * 13 + (j.title || "").length) | 0;
  }

  // ── Settings signal: any add/remove/rename/toggle on any settings list
  // triggers a refresh for all other open tabs. Hash the name + active/enabled
  // flags for each list. 5 tiny strings joined together; cheap to compute. ──
  function hashList(
    rows: Array<{ id: number; name: string }>,
    flag?: (r: any) => number
  ): string {
    let h = rows.length;
    for (const r of rows) {
      h = (h * 131 + (r.name || "").length + r.id) | 0;
      if (flag) h = (h + flag(r)) | 0;
    }
    return String(h);
  }

  const settingsSig = [
    hashList(db.getAllRecruiters(),    (r: any) => r.is_active ? 1 : 0),
    hashList(db.getAllStages(),        (s: any) => (s.is_enabled ? 1 : 0)
                                                 + (s.is_hired ? 2 : 0)
                                                 + (s.is_rejected ? 4 : 0)
                                                 + (s.is_offer ? 8 : 0)
                                                 + ((s.sequence | 0) * 16)),
    hashList(db.getAllSources(),       (s: any) => s.is_enabled ? 1 : 0),
    hashList(db.getAllRegions(),       (r: any) => r.is_enabled ? 1 : 0),
    hashList(db.getAllRefuseReasons(), (r: any) => r.is_enabled ? 1 : 0),
  ].join(",");

  return [
    candidates.length,
    activeCount,
    maxCandidateId,
    latestStageUpdate,
    jobs.length,
    maxJobId,
    jobHash,
    settingsSig,
  ].join("|");
}

const SYNC_FP_CACHE_KEY     = "tpg.ats.sync.fp.v1";
const SYNC_FP_CACHE_TTL_SEC = 5;

/**
 * Returns a lightweight fingerprint the frontend polls every ~15s.
 * If the fingerprint changes between polls, the client refetches the
 * current view's data. Much cheaper than refetching everything every tick.
 *
 * ── Dogpile cache (5s TTL) ─────────────────────────────────────
 * With 5 recruiters each polling on a 15s tick, the script services ~20
 * fingerprint requests/minute. Without coalescing, each one independently
 * reads 7 sheets. The CacheService entry below is shared across all users —
 * the first poll in any 5s window pays the read cost; the rest get a near-
 * instant string lookup. Worst-case staleness for cross-user change
 * detection is 5s on top of the 15s client poll, vs ~30s already inherent
 * in the polling model. userEmail is NOT cached (it's per-call from Session).
 */
function getSyncFingerprint(): { sig: string; userEmail: string } {
  const userEmail = getSessionEmail();

  if (typeof CacheService !== "undefined") {
    try {
      const cached = CacheService.getScriptCache().get(SYNC_FP_CACHE_KEY);
      if (cached) return { sig: cached, userEmail };
    } catch { /* fall through to compute */ }
  }

  const sig = _computeSyncFingerprint(getDB());

  if (typeof CacheService !== "undefined") {
    try {
      CacheService.getScriptCache().put(SYNC_FP_CACHE_KEY, sig, SYNC_FP_CACHE_TTL_SEC);
    } catch { /* over-quota — non-fatal */ }
  }

  return { sig, userEmail };
}

function getRecentHires(days = 90): CandidateRow[] {
  const db = getDB();
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];
  return db.getAllCandidates()
    .filter(c => c.status === "Hired" && c.date_last_stage_update >= cutoff)
    .map(c => joinCandidate(
      c,
      db.getAllStages(), db.getAllJobs(), db.getAllRecruiters(),
      db.getAllSources(), db.getAllRegions(), db.getAllRefuseReasons()
    ));
}

/**
 * Recent team activity — powered by the existing history sheet.
 * Returns the N most recent history entries, each a stage transition
 * with who/what/when already denormalized. The frontend turns each row
 * into a human sentence ("Brad moved Sarah from Reviewed → Contacted 2h ago").
 *
 * Single `getAllHistory` scan + client-side sort, so this is O(n) over
 * total history rows. Current-period filter is a frontend concern (user
 * might want "this week" vs "last 30 days").
 */
// ============================================================
// Real-time presence (who's viewing which candidate right now)
// ============================================================
// Keyed in CacheService to avoid sheet writes — every peek panel
// ping is just a few cache bytes. Expires after 60s of silence so
// stale viewers clean up automatically even if the client tab dies
// without sending a "leaving" signal.

const PRESENCE_TTL_SEC = 60;
const PRESENCE_KEY_PREFIX = "presence:";

/**
 * Client pings this every ~15s while it has a candidate peek panel open.
 * Server records {email, timestamp} under a key scoped to the candidate.
 * We store per-viewer entries (one cache key per viewer) so we can list
 * them all without reading a single giant value.
 */
function touchPresence(candidateId: number): { ok: boolean } {
  if (typeof CacheService === "undefined") return { ok: false };
  if (!candidateId) return { ok: false };
  const email = getSessionEmail() || "unknown";
  const key = PRESENCE_KEY_PREFIX + candidateId + ":" + email;
  const value = JSON.stringify({ email, ts: Date.now() });
  try {
    CacheService.getScriptCache().put(key, value, PRESENCE_TTL_SEC);
    // Also maintain an "index" key listing viewer emails for this candidate.
    // The index itself expires so it can be rebuilt if all viewers are stale.
    const idxKey = PRESENCE_KEY_PREFIX + candidateId + ":__idx";
    const existing = CacheService.getScriptCache().get(idxKey);
    const viewers: string[] = existing ? JSON.parse(existing) : [];
    if (viewers.indexOf(email) < 0) viewers.push(email);
    CacheService.getScriptCache().put(idxKey, JSON.stringify(viewers), PRESENCE_TTL_SEC);
  } catch { /* cache over-quota or some other flake — non-fatal */ }
  return { ok: true };
}

/**
 * Called by the peek panel when it opens, and by its polling tick.
 * Returns the list of OTHER users (not the caller) currently viewing
 * the given candidate. Filters out expired entries (defense-in-depth
 * against the TTL race).
 */
function getPresence(candidateId: number): Array<{ email: string; secondsAgo: number }> {
  if (typeof CacheService === "undefined") return [];
  if (!candidateId) return [];
  const myEmail = getSessionEmail() || "unknown";
  const idxKey = PRESENCE_KEY_PREFIX + candidateId + ":__idx";
  let viewers: string[] = [];
  try {
    const raw = CacheService.getScriptCache().get(idxKey);
    viewers = raw ? JSON.parse(raw) : [];
  } catch { return []; }

  const now = Date.now();
  const out: Array<{ email: string; secondsAgo: number }> = [];
  for (const v of viewers) {
    if (v === myEmail) continue;
    try {
      const raw = CacheService.getScriptCache().get(PRESENCE_KEY_PREFIX + candidateId + ":" + v);
      if (!raw) continue;  // expired
      const rec = JSON.parse(raw);
      out.push({ email: rec.email, secondsAgo: Math.round((now - rec.ts) / 1000) });
    } catch { /* skip bad entry */ }
  }
  return out;
}

// ============================================================
// App-wide presence (who's on the app right now)
// ============================================================
//
// Same shape as the per-candidate presence above, but scoped to the
// app as a whole rather than a single candidate. Powers the avatar
// stack in the topbar — the "Google Sheets style" indicator that
// shows everyone currently using the app. Uses the same 60s TTL so
// browser tab closures auto-clean within a minute even without an
// explicit "leaving" signal.

const APP_PRESENCE_BUCKET = "__app__";   // sentinel candidate ID for app-level keys

function touchAppPresence(): { ok: boolean } {
  if (typeof CacheService === "undefined") return { ok: false };
  const email = getSessionEmail() || "unknown";
  const cache = CacheService.getScriptCache();
  const key = PRESENCE_KEY_PREFIX + APP_PRESENCE_BUCKET + ":" + email;
  const value = JSON.stringify({ email, ts: Date.now() });
  try {
    cache.put(key, value, PRESENCE_TTL_SEC);
    const idxKey = PRESENCE_KEY_PREFIX + APP_PRESENCE_BUCKET + ":__idx";
    const existing = cache.get(idxKey);
    const viewers: string[] = existing ? JSON.parse(existing) : [];
    if (viewers.indexOf(email) < 0) viewers.push(email);
    cache.put(idxKey, JSON.stringify(viewers), PRESENCE_TTL_SEC);
  } catch { /* cache flake — non-fatal */ }
  return { ok: true };
}

// Returns ALL active viewers (including self). The frontend filters
// out the caller for the avatar stack but uses the self-entry to
// show the user's own status / freshness. Same shape as getPresence.
function getAppPresence(): Array<{ email: string; secondsAgo: number; isSelf: boolean }> {
  if (typeof CacheService === "undefined") return [];
  const myEmail = getSessionEmail() || "unknown";
  const cache = CacheService.getScriptCache();
  const idxKey = PRESENCE_KEY_PREFIX + APP_PRESENCE_BUCKET + ":__idx";
  let viewers: string[] = [];
  try {
    const raw = cache.get(idxKey);
    viewers = raw ? JSON.parse(raw) : [];
  } catch { return []; }

  const now = Date.now();
  const out: Array<{ email: string; secondsAgo: number; isSelf: boolean }> = [];
  for (const v of viewers) {
    try {
      const raw = cache.get(PRESENCE_KEY_PREFIX + APP_PRESENCE_BUCKET + ":" + v);
      if (!raw) continue;   // expired
      const rec = JSON.parse(raw);
      out.push({
        email: rec.email,
        secondsAgo: Math.round((now - rec.ts) / 1000),
        isSelf: rec.email === myEmail,
      });
    } catch { /* skip bad entry */ }
  }
  // Self first (so the avatar stack reads self → others left to right)
  return out.sort((a, b) => (a.isSelf === b.isSelf ? a.email.localeCompare(b.email) : a.isSelf ? -1 : 1));
}

/**
 * Bulk create candidates in one locked transaction.
 * Accepts an array of CreateCandidateInput — each validated the same way
 * createCandidate does. Failures are collected per-row and returned so the
 * UI can show "24 created, 2 skipped with reasons". Held-lock window is
 * the whole batch, so concurrent single-adds queue behind it.
 */
function bulkCreateCandidates(rows: CreateCandidateInput[]): {
  created: number;
  skipped: Array<{ row: number; email: string; reason: string }>;
  ids: number[];
} {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("No rows to import");
  }
  // Hard cap to protect GAS's 6-minute execution budget
  if (rows.length > 500) {
    throw new Error("Import limited to 500 candidates per batch (received " + rows.length + ")");
  }
  return withLock(() => {
    const db = getDB();
    const stages = db.getAllStages()
      .filter(s => s.is_enabled)
      .sort((a, b) => a.sequence - b.sequence);
    if (stages.length === 0) throw new Error("No pipeline stages configured");
    const firstStage = stages[0];
    const today = todayStr();
    const userEmail = getSessionEmail();
    const sources = db.getAllSources();

    const skipped: Array<{ row: number; email: string; reason: string }> = [];
    const ids: number[] = [];
    let created = 0;

    rows.forEach((data, i) => {
      try {
        if (!data.first_name || !data.last_name) {
          skipped.push({ row: i + 1, email: data.email || "", reason: "Missing name" });
          return;
        }
        if (!data.email) {
          skipped.push({ row: i + 1, email: "", reason: "Missing email" });
          return;
        }
        if (!data.job_id) {
          skipped.push({ row: i + 1, email: data.email, reason: "Missing job_id" });
          return;
        }

        let motion = data.motion ?? "Inbound";
        if (data.source_id) {
          const src = sources.find(s => s.id === data.source_id);
          if (src) motion = src.default_motion;
        }

        const candidate = db.appendCandidate({
          first_name: data.first_name,
          last_name: data.last_name,
          email: data.email,
          phone: data.phone || "",
          job_id: data.job_id,
          stage_id: firstStage.id,
          recruiter_id: null,
          source_id: data.source_id ?? null,
          region_id: data.region_id ?? null,
          motion,
          status: "Active",
          rating: 0,
          linkedin_url: "",
          resume_url: "",
          notes: data.notes ?? "",
          refuse_reason_id: null,
          kanban_state: "Normal",
          post_hire_status: "",
          date_applied: today,
          date_last_stage_update: today,
          created_by: userEmail,
          created_at: nowStr(),
        });

        logHistory(
          db,
          candidate.id, `${data.first_name} ${data.last_name}`,
          data.job_id, db.getJobById(data.job_id)?.title ?? "",
          null, "",
          firstStage.id, firstStage.name,
          userEmail, today
        );

        ids.push(candidate.id);
        created++;
      } catch (err: any) {
        skipped.push({ row: i + 1, email: data.email || "", reason: err.message || String(err) });
      }
    });

    return { created, skipped, ids };
  });
}

// ============================================================
// Client error logging
// ============================================================
//
// Frontend window.onerror / unhandledrejection handlers POST to this
// endpoint so we can see what's breaking in production without asking
// users for screenshots. Output goes to the GAS execution log
// (Apps Script editor → Executions tab) and to console.error so a
// project owner can review them post-hoc. Intentionally NOT writing
// to a sheet — keeps the volume bounded under a runaway-error scenario.
//
// Best-effort: if the log call itself fails for any reason, swallow.
// Error reporting must never become its own outage.

interface ClientErrorPayload {
  kind: string;        // "JS error" | "Unhandled promise" | etc.
  message: string;
  stack?: string;
  url?: string;
  ua?: string;
  ts?: string;
}

function logClientError(payload: ClientErrorPayload): { ok: boolean } {
  try {
    const userEmail = getSessionEmail() || "unknown";
    // console.error in GAS routes to Stackdriver / Cloud Logging when the
    // project is GCP-linked. Otherwise it lands in the Apps Script
    // execution log, which is enough to debug without infrastructure.
    console.error("[client-error]", JSON.stringify({
      user: userEmail,
      kind: payload.kind,
      message: payload.message,
      url: payload.url,
      ua: payload.ua,
      ts: payload.ts,
      stack: payload.stack ? payload.stack.slice(0, 2000) : undefined,
    }));
    // Also bump the failure counter so the ?debug=1 panel can surface
    // recent error volume without us having to query Cloud Logging.
    _bumpFailureCounter("client:" + payload.kind);
  } catch (_e) {
    // Never throw — this would loop the unhandledrejection handler.
  }
  return { ok: true };
}

// ============================================================
// Failure counter (for ?debug=1 panel)
// ============================================================
//
// CacheService-backed rolling counter of recent backend failures by
// category. Surfaced in getDebugInfo() so the ops health check is
// "open ?debug=1, look for non-zero counters" instead of digging
// through Cloud Logging. Counters auto-expire after 1 hour so the
// panel reflects "recent" trouble, not historical noise.

const FAILURE_COUNTER_KEY    = "tpg.ats.failure-counters.v1";
const FAILURE_COUNTER_TTL_SEC = 3600;

function _bumpFailureCounter(category: string): void {
  if (typeof CacheService === "undefined") return;
  try {
    const cache = CacheService.getScriptCache();
    const raw = cache.get(FAILURE_COUNTER_KEY);
    const counters: Record<string, number> = raw ? JSON.parse(raw) : {};
    counters[category] = (counters[category] || 0) + 1;
    cache.put(FAILURE_COUNTER_KEY, JSON.stringify(counters), FAILURE_COUNTER_TTL_SEC);
  } catch (_e) { /* never throw from instrumentation */ }
}

function _readFailureCounters(): Record<string, number> {
  if (typeof CacheService === "undefined") return {};
  try {
    const raw = CacheService.getScriptCache().get(FAILURE_COUNTER_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_e) { return {}; }
}

// ============================================================
// Debug endpoint (?debug=1 panel)
// ============================================================
//
// Single endpoint that returns everything the ?debug=1 panel needs
// to show in one round-trip: deployed version, user identity, schema
// validation result, sample raw vs parsed candidate, settings cache
// state, recent failure counters. Replaces the throw-away diagnostic
// panels we kept shipping during the v25-v31 parseStr Date hunt.

interface DebugInfo {
  version: string;            // commit SHA / deploy id (best-effort)
  user: string;
  serverTime: string;
  schema: { ok: boolean; errors: string[] };
  sampleCandidate: {
    raw: unknown;             // first cell, untouched, with type info
    parsed: unknown;          // what _rowToCandidate produced
  } | null;
  counts: {
    candidates: number;
    jobs: number;
    history: number;
    stages: number;
    sources: number;
    regions: number;
    recruiters: number;
  };
  failureCounters: Record<string, number>;
  spreadsheetId: string;
  scriptTimezone: string;
}

function getDebugInfo(): DebugInfo {
  const db = getDB();
  const schema = db.validateSchema();
  // Sample candidate: read row 2 from the candidates sheet directly so
  // we can show both the RAW cell values (with their types) and the
  // PARSED CandidateRow side-by-side. This is the diagnostic that
  // would have caught the parseStr-Date bug in seconds instead of
  // requiring 6 redeploys to pin down.
  let sampleCandidate: DebugInfo["sampleCandidate"] = null;
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName("candidates");
    if (sheet && sheet.getLastRow() >= 2) {
      const row = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
      sampleCandidate = {
        raw: row.map(v => ({
          value: v instanceof Date ? v.toString() : v,
          type:  v === null ? "null" : v === undefined ? "undefined" :
                 v instanceof Date ? "Date" : typeof v,
        })),
        parsed: db.getAllCandidates()[0] || null,
      };
    }
  } catch (_e) { /* schema check above will already report any sheet access errors */ }

  return {
    version: ScriptApp.getScriptId(),
    user: getSessionEmail() || "unknown",
    serverTime: new Date().toISOString(),
    schema,
    sampleCandidate,
    counts: {
      candidates: db.getAllCandidates().length,
      jobs:       db.getAllJobs().length,
      history:    db.getAllHistory().length,
      stages:     db.getAllStages().length,
      sources:    db.getAllSources().length,
      regions:    db.getAllRegions().length,
      recruiters: db.getAllRecruiters().length,
    },
    failureCounters: _readFailureCounters(),
    spreadsheetId: SPREADSHEET_ID,
    scriptTimezone: Session.getScriptTimeZone(),
  };
}

// ============================================================
// Weekly Sheets snapshot to Drive
// ============================================================
//
// Sheets has built-in version history but no scheduled snapshots — if a
// recruiter accidentally clears a column, restoring requires hunting
// through the version-history dialog. This function copies the entire
// backing spreadsheet to a date-stamped file in a "TPG ATS Backups"
// folder so we always have a known-good restore point.
//
// Driven by a time-based trigger (set up once via installSnapshotTrigger
// below). Saturdays around 2am gives us a quiet-window snapshot.
//
// Idempotent: if today's snapshot already exists, skip. Trims to the
// most recent N snapshots so the folder doesn't grow forever.

const BACKUP_FOLDER_NAME = "TPG ATS Backups";
const BACKUP_KEEP_COUNT  = 12;   // ~3 months of weekly snapshots

function snapshotSpreadsheetToDrive(): { ok: boolean; message: string } {
  if (typeof DriveApp === "undefined" || typeof SpreadsheetApp === "undefined") {
    return { ok: false, message: "DriveApp/SpreadsheetApp unavailable (non-GAS env)" };
  }
  try {
    const folder = _findOrCreateFolder(BACKUP_FOLDER_NAME);
    const today  = new Date().toISOString().split("T")[0];   // YYYY-MM-DD
    const name   = `TPG ATS Backup ${today}`;

    // Idempotency — skip if today's snapshot already exists.
    const existing = folder.getFilesByName(name);
    if (existing.hasNext()) {
      return { ok: true, message: `Snapshot ${name} already exists; skipped` };
    }

    const original = DriveApp.getFileById(SPREADSHEET_ID);
    original.makeCopy(name, folder);

    _trimOldBackups(folder, BACKUP_KEEP_COUNT);
    return { ok: true, message: `Created ${name}` };
  } catch (err) {
    const msg = (err as Error)?.message || String(err);
    console.error("[snapshotSpreadsheetToDrive]", msg);
    return { ok: false, message: msg };
  }
}

function _findOrCreateFolder(name: string): GoogleAppsScript.Drive.Folder {
  const it = DriveApp.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(name);
}

function _trimOldBackups(folder: GoogleAppsScript.Drive.Folder, keep: number): void {
  // Sort by name desc — names are date-stamped so this is chronological.
  const files: Array<{ id: string; name: string }> = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf("TPG ATS Backup") === 0) {
      files.push({ id: f.getId(), name: f.getName() });
    }
  }
  files.sort((a, b) => b.name.localeCompare(a.name));   // newest first
  for (let i = keep; i < files.length; i++) {
    try { DriveApp.getFileById(files[i].id).setTrashed(true); }
    catch (_e) { /* swallow — best effort cleanup */ }
  }
}

/**
 * One-time setup — run from the Apps Script editor (Run → installSnapshotTrigger)
 * to wire up the weekly trigger. Idempotent: removes any prior snapshot
 * trigger before adding the new one so re-running can't double-schedule.
 */
function installSnapshotTrigger(): { ok: boolean; message: string } {
  if (typeof ScriptApp === "undefined") {
    return { ok: false, message: "ScriptApp unavailable (non-GAS env)" };
  }
  try {
    const triggers = ScriptApp.getProjectTriggers();
    let removed = 0;
    for (const t of triggers) {
      if (t.getHandlerFunction() === "snapshotSpreadsheetToDrive") {
        ScriptApp.deleteTrigger(t);
        removed++;
      }
    }
    ScriptApp.newTrigger("snapshotSpreadsheetToDrive")
      .timeBased()
      .onWeekDay(ScriptApp.WeekDay.SATURDAY)
      .atHour(2)
      .create();
    return { ok: true, message: `Installed weekly Saturday 2am trigger (removed ${removed} prior).` };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message || String(err) };
  }
}

function getRecentActivity(limit = 50): import("./types").HistoryRow[] {
  const history = getDB().getAllHistory();
  // Newest first — timestamp is an ISO string, lexicographic compare is fine
  history.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  return history.slice(0, Math.max(1, Math.min(200, limit | 0)));
}
