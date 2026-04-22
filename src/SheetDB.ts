/**
 * SheetDB — all Google Sheets I/O for the TPG ATS.
 *
 * This class is the ONLY place in the codebase that calls SpreadsheetApp.
 * Every other module accepts an ISheetDB parameter, making the logic
 * fully unit-testable without touching Google's servers.
 */

import type {
  ISheetDB,
  CandidateRow,
  JobRow,
  HistoryRow,
  StageRow,
  SourceRow,
  RegionRow,
  RecruiterRow,
  RefuseReasonRow,
} from "./types";

// ---------- Column index maps (1-based for GAS, 0-based here for arrays) ----------

const CANDIDATE_COLS = {
  id: 0, first_name: 1, last_name: 2, email: 3, phone: 4,
  job_id: 5, stage_id: 6, recruiter_id: 7, source_id: 8, region_id: 9,
  motion: 10, status: 11, rating: 12, linkedin_url: 13, resume_url: 14,
  notes: 15, refuse_reason_id: 16, kanban_state: 17, post_hire_status: 18,
  date_applied: 19, date_last_stage_update: 20, created_by: 21, created_at: 22,
};

const JOB_COLS = {
  id: 0, title: 1, department: 2, location: 3, region_id: 4,
  status: 5, head_count: 6, recruiter_id: 7, salary_range: 8,
  posted_date: 9, closes_date: 10, posting_expires: 11, notes: 12, created_at: 13,
};

const HISTORY_COLS = {
  id: 0, timestamp: 1, candidate_id: 2, candidate_name: 3, job_id: 4,
  job_title: 5, stage_from_id: 6, stage_from_name: 7, stage_to_id: 8,
  stage_to_name: 9, changed_by: 10, days_in_previous_stage: 11,
};

const STAGE_COLS = { id: 0, name: 1, sequence: 2, color: 3, is_hired: 4, is_rejected: 5, is_offer: 6, target_hours: 7, is_enabled: 8 };
const SOURCE_COLS = { id: 0, name: 1, medium: 2, default_motion: 3, is_enabled: 4 };
const REGION_COLS = { id: 0, name: 1, is_enabled: 2 };
const RECRUITER_COLS = { id: 0, name: 1, email: 2, is_active: 3 };
const REFUSE_COLS = { id: 0, name: 1, is_enabled: 2 };

const SHEET_NAMES = {
  candidates: "candidates",
  jobs: "jobs",
  history: "history",
  stages: "stages",
  sources: "sources",
  regions: "regions",
  recruiters: "recruiters",
  refuseReasons: "refuse_reasons",
};

// ---------- Helpers ----------

function parseNum(val: unknown): number {
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

function parseNumOrNull(val: unknown): number | null {
  if (val === "" || val === null || val === undefined) return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

function parseBool(val: unknown): boolean {
  return val === true || val === "TRUE" || val === "true" || val === 1 || val === "1";
}

/**
 * Parse any sheet cell value into a string for the typed row mapper.
 *
 * IMPORTANT: Sheets auto-detects ISO date strings on write and stores
 * them as native Date values. When read back via `getRange().getValues()`
 * those cells return JS `Date` objects, not strings. The naive
 * `String(date)` produces the locale-aware toString format
 * (`"Wed Apr 22 2026 00:00:00 GMT-0400 (EDT)"`), which:
 *   - breaks lexicographic compares against `"YYYY-MM-DD"` filters on
 *     the client (capital "W" sorts before any digit),
 *   - looks awful in CSV exports and the activity feed,
 *   - is non-deterministic across server timezones.
 *
 * Detect Date instances and emit a stable ISO string so every consumer
 * sees the same shape regardless of how Sheets chose to coerce the cell.
 * Date-only fields end up as `"YYYY-MM-DD"`; datetime fields keep the
 * full `"YYYY-MM-DDTHH:mm:ss.sssZ"`. Both formats sort correctly via
 * string comparison.
 */
// Matches "Wed Apr 22 2026 00:00:00 GMT-0400 (Eastern Daylight Time)" — the
// JS Date.prototype.toString() format. Used by parseStr's defensive backstop
// to re-emit such values as ISO. Intentionally narrow so we don't mangle
// arbitrary text fields that happen to start with day-name abbreviations.
//
// Declared ABOVE parseStr (not below) so the bundled order keeps the regex
// definitionally available before parseStr can possibly be called.
const DATE_TOSTRING_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \w{3} \d{1,2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}/;

export function parseStr(val: unknown): string {
  if (val == null) return "";
  // Duck-type Date detection. The naive `val instanceof Date` check is
  // unreliable in the Apps Script V8 runtime: cells returned by
  // SpreadsheetApp.getRange().getValues() carry a Date-like object that
  // DOES NOT match the local `Date` constructor's prototype (different
  // realm or subclassed type), so `instanceof Date` returns false even
  // though the value has all the Date methods.
  //
  // The diagnostic (v25-v27) caught this in production: parseStr was
  // falling through to String(val) for date cells, producing the JS
  // toString format ("Wed Apr 22 2026 00:00:00 GMT-0400 ..."), which
  // then broke calendar-date filters because slice(0,10) on that string
  // gives "Wed Apr 22" — not anything that compares correctly against
  // a "2026-04-22" filter input.
  //
  // Fix: also accept any object that exposes both .toISOString() and
  // .getTime(). Together those uniquely identify the Date interface
  // among built-ins; nothing else in our pipeline would pass.
  const isDateLike =
    val instanceof Date ||
    (
      typeof val === "object" &&
      val !== null &&
      typeof (val as { toISOString?: unknown }).toISOString === "function" &&
      typeof (val as { getTime?: unknown }).getTime === "function"
    );
  if (isDateLike) {
    try {
      const iso = (val as Date).toISOString();
      // Date-only when stored at exact midnight UTC (cells typed as
      // "YYYY-MM-DD" with no time component in a UTC-locale spreadsheet).
      // Otherwise emit the full ISO; downstream calendar-date filters
      // slice(0,10) so any "YYYY-MM-DDT...Z" still compares correctly.
      return iso.endsWith("T00:00:00.000Z") ? iso.split("T")[0] : iso;
    } catch (_e) {
      // Pathological Date (timestamp out of range, etc.) — fall through.
    }
  }
  // Defensive backstop: live diag (v29) showed that even with duck-typing,
  // some date cells arrive at parseStr already coerced to a String in JS
  // Date.toString() format ("Wed Apr 22 2026 00:00:00 GMT-0400 (Eastern
  // Daylight Time)") — most likely Apps Script V8 stringifying Date cells
  // before they reach the row mapper, or google.script.run serialization
  // doing it across the iframe boundary. Either way the value never had
  // a chance to hit our duck-type branch above. If a string both LOOKS
  // like a Date.toString and parses cleanly to a real timestamp, re-emit
  // it as ISO so downstream filters can slice(0,10) and compare correctly.
  const s = String(val);
  if (DATE_TOSTRING_RE.test(s)) {
    const ts = Date.parse(s);
    if (!isNaN(ts)) return new Date(ts).toISOString();
  }
  return s;
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function now(): string {
  return new Date().toISOString();
}

// ---------- SheetDB Implementation ----------

export class SheetDB implements ISheetDB {
  private _ss: GoogleAppsScript.Spreadsheet.Spreadsheet;

  // Per-execution row cache. Keyed by sheet name, holds the raw 2D array
  // returned by getRange().getValues(). Each GAS request gets a fresh
  // SheetDB instance (see Code.ts:getDB), so this never leaks across users
  // or executions. Eliminates the N-reads-per-request explosion in
  // getDashboardData (~8 sheet reads → 1 per sheet) and getSyncFingerprint
  // (~7 reads → 2). Invalidated automatically on any write to the same sheet.
  private _rowCache: Map<string, unknown[][]> = new Map();

  // Cross-execution cache for settings tables (stages, sources, regions,
  // recruiters, refuse_reasons). They change rarely but are read on every
  // single request, so a 60s TTL on CacheService eliminates almost all
  // settings I/O. Invalidated immediately on any replace*() write so a
  // settings change is visible to other users on the next poll.
  private static readonly SETTINGS_CACHE_TTL_SEC = 60;
  private static readonly SETTINGS_CACHE_PREFIX  = "tpg.ats.settings.v1.";

  constructor(spreadsheetId?: string) {
    this._ss = spreadsheetId
      ? SpreadsheetApp.openById(spreadsheetId)
      : SpreadsheetApp.getActiveSpreadsheet();
  }

  private _sheet(name: string): GoogleAppsScript.Spreadsheet.Sheet {
    const sheet = this._ss.getSheetByName(name);
    if (!sheet) throw new Error(`Sheet '${name}' not found`);
    return sheet;
  }

  /**
   * Schema sanity check — verifies that every sheet the app reads from
   * exists and that the header row is wide enough to contain every column
   * we index by position. Designed to run on doGet so a misconfigured
   * spreadsheet (sheet renamed in the UI, columns reordered, etc.) fails
   * at the door with a clear list of issues instead of crashing later
   * inside some random handler with an opaque "undefined is not an object".
   *
   * Header values are NOT compared by name — recruiters may rename a
   * column header to something more familiar without breaking us, as
   * long as the column count is intact and the data shape is preserved.
   * If we ever need name-based validation, the SHEET_SCHEMA constant
   * below already lists every expected name; switch to comparing
   * `firstRow[i]` against `expected[i]` to opt in.
   */
  validateSchema(): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    const SHEET_SCHEMA: Array<{ sheet: string; columns: string[] }> = [
      { sheet: SHEET_NAMES.candidates,    columns: Object.keys(CANDIDATE_COLS) },
      { sheet: SHEET_NAMES.jobs,          columns: Object.keys(JOB_COLS) },
      { sheet: SHEET_NAMES.history,       columns: Object.keys(HISTORY_COLS) },
      { sheet: SHEET_NAMES.stages,        columns: Object.keys(STAGE_COLS) },
      { sheet: SHEET_NAMES.sources,       columns: Object.keys(SOURCE_COLS) },
      { sheet: SHEET_NAMES.regions,       columns: Object.keys(REGION_COLS) },
      { sheet: SHEET_NAMES.recruiters,    columns: Object.keys(RECRUITER_COLS) },
      { sheet: SHEET_NAMES.refuseReasons, columns: Object.keys(REFUSE_COLS) },
    ];
    for (const { sheet: name, columns } of SHEET_SCHEMA) {
      let s: GoogleAppsScript.Spreadsheet.Sheet | null = null;
      try {
        s = this._ss.getSheetByName(name);
      } catch {
        errors.push(`Sheet '${name}' lookup threw — spreadsheet may be inaccessible`);
        continue;
      }
      if (!s) {
        errors.push(`Sheet '${name}' is missing (expected ${columns.length} columns: ${columns.join(", ")})`);
        continue;
      }
      const lastCol = s.getLastColumn();
      if (lastCol < columns.length) {
        errors.push(
          `Sheet '${name}' has only ${lastCol} columns, expected at least ${columns.length}. ` +
          `Required columns in order: ${columns.join(", ")}`
        );
      }
    }
    return { ok: errors.length === 0, errors };
  }

  // ---------- Cache plumbing ----------

  /** Drop the per-execution cache for a sheet. Call after any write. */
  private _invalidate(sheetName: string): void {
    this._rowCache.delete(sheetName);
  }

  /** CacheService key for a settings table. Versioned so a schema change can bump and orphan stale entries. */
  private _settingsCacheKey(sheetName: string): string {
    return SheetDB.SETTINGS_CACHE_PREFIX + sheetName;
  }

  /** Read a settings table from CacheService. Returns null on miss, parse error, or non-GAS env (jest). */
  private _settingsCacheGet<T>(sheetName: string): T[] | null {
    // CacheService is GAS-only; tests run in node and would crash on access.
    if (typeof CacheService === "undefined") return null;
    try {
      const raw = CacheService.getScriptCache().get(this._settingsCacheKey(sheetName));
      return raw ? (JSON.parse(raw) as T[]) : null;
    } catch {
      return null;
    }
  }

  /** Write a settings table to CacheService. Silent no-op if quota exceeded or non-GAS env. */
  private _settingsCacheSet<T>(sheetName: string, rows: T[]): void {
    if (typeof CacheService === "undefined") return;
    try {
      CacheService.getScriptCache().put(
        this._settingsCacheKey(sheetName),
        JSON.stringify(rows),
        SheetDB.SETTINGS_CACHE_TTL_SEC
      );
    } catch {
      // Cache full or value too big — non-fatal, next read will hit the sheet.
    }
  }

  /** Drop both caches (script-wide CacheService + per-execution rows) for a settings table. */
  private _settingsCacheInvalidate(sheetName: string): void {
    this._invalidate(sheetName);
    if (typeof CacheService === "undefined") return;
    try {
      CacheService.getScriptCache().remove(this._settingsCacheKey(sheetName));
    } catch {
      /* swallow */
    }
  }

  // ---------- Sheet reads (cached) ----------

  private _getRows(sheetName: string): unknown[][] {
    const cached = this._rowCache.get(sheetName);
    if (cached !== undefined) return cached;
    const sheet = this._sheet(sheetName);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      this._rowCache.set(sheetName, []);
      return [];
    }
    const rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    this._rowCache.set(sheetName, rows);
    return rows;
  }

  /**
   * Compute next id without paying for a full sheet read when possible.
   * Path 1: cache hit — scan cached rows, no I/O.
   * Path 2: cache miss — read only column A (id), 1 narrow range vs. 23-column scan.
   */
  private _nextId(sheetName: string): number {
    const cached = this._rowCache.get(sheetName);
    if (cached !== undefined) {
      let max = 0;
      for (const r of cached) {
        const id = parseNum(r[0]);
        if (id > max) max = id;
      }
      return max + 1;
    }
    const sheet = this._sheet(sheetName);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return 1;
    const idCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    let max = 0;
    for (const r of idCol) {
      const id = parseNum(r[0]);
      if (id > max) max = id;
    }
    return max + 1;
  }

  private _findRowIndex(sheetName: string, id: number): number {
    const rows = this._getRows(sheetName);
    const idx = rows.findIndex(r => parseNum(r[0]) === id);
    return idx >= 0 ? idx + 2 : -1; // +2 because header row + 1-based
  }

  // -------- Candidates --------

  getAllCandidates(): CandidateRow[] {
    return this._getRows(SHEET_NAMES.candidates).map(r => this._rowToCandidate(r));
  }

  getCandidateById(id: number): CandidateRow | null {
    const rows = this._getRows(SHEET_NAMES.candidates);
    const row = rows.find(r => parseNum(r[CANDIDATE_COLS.id]) === id);
    return row ? this._rowToCandidate(row) : null;
  }

  appendCandidate(row: Omit<CandidateRow, "id">): CandidateRow {
    const sheet = this._sheet(SHEET_NAMES.candidates);
    const id = this._nextId(SHEET_NAMES.candidates);
    const values = this._candidateToRow({ ...row, id });
    sheet.appendRow(values);
    this._invalidate(SHEET_NAMES.candidates);
    return { ...row, id };
  }

  /**
   * Single-read update: previously did one read in _findRowIndex AND another
   * getRange().getValues() to fetch the existing row, then a setValues write.
   * Now reuses the row data from the cached _getRows scan — saves one
   * sheet roundtrip per update (~100-300ms on writes that hit a populated sheet).
   */
  updateCandidate(id: number, updates: Partial<CandidateRow>): void {
    const rows = this._getRows(SHEET_NAMES.candidates);
    const idx = rows.findIndex(r => parseNum(r[0]) === id);
    if (idx < 0) throw new Error(`Candidate ${id} not found`);
    const existing = this._rowToCandidate(rows[idx]);
    const merged = { ...existing, ...updates, id };
    const sheet = this._sheet(SHEET_NAMES.candidates);
    sheet.getRange(idx + 2, 1, 1, 23).setValues([this._candidateToRow(merged)]);
    this._invalidate(SHEET_NAMES.candidates);
  }

  deleteCandidate(id: number): void {
    const rowIndex = this._findRowIndex(SHEET_NAMES.candidates, id);
    if (rowIndex < 0) throw new Error(`Candidate ${id} not found`);
    this._sheet(SHEET_NAMES.candidates).deleteRow(rowIndex);
    this._invalidate(SHEET_NAMES.candidates);
  }

  // -------- Jobs --------

  getAllJobs(): JobRow[] {
    return this._getRows(SHEET_NAMES.jobs).map(r => this._rowToJob(r));
  }

  getJobById(id: number): JobRow | null {
    const rows = this._getRows(SHEET_NAMES.jobs);
    const row = rows.find(r => parseNum(r[JOB_COLS.id]) === id);
    return row ? this._rowToJob(row) : null;
  }

  appendJob(row: Omit<JobRow, "id">): JobRow {
    const sheet = this._sheet(SHEET_NAMES.jobs);
    const id = this._nextId(SHEET_NAMES.jobs);
    const values = this._jobToRow({ ...row, id });
    sheet.appendRow(values);
    this._invalidate(SHEET_NAMES.jobs);
    return { ...row, id };
  }

  updateJob(id: number, updates: Partial<JobRow>): void {
    const rows = this._getRows(SHEET_NAMES.jobs);
    const idx = rows.findIndex(r => parseNum(r[0]) === id);
    if (idx < 0) throw new Error(`Job ${id} not found`);
    const existing = this._rowToJob(rows[idx]);
    const merged = { ...existing, ...updates, id };
    const sheet = this._sheet(SHEET_NAMES.jobs);
    sheet.getRange(idx + 2, 1, 1, 14).setValues([this._jobToRow(merged)]);
    this._invalidate(SHEET_NAMES.jobs);
  }

  deleteJob(id: number): void {
    const rowIndex = this._findRowIndex(SHEET_NAMES.jobs, id);
    if (rowIndex < 0) throw new Error(`Job ${id} not found`);
    this._sheet(SHEET_NAMES.jobs).deleteRow(rowIndex);
    this._invalidate(SHEET_NAMES.jobs);
  }

  // -------- History --------

  appendHistory(row: Omit<HistoryRow, "id">): void {
    const sheet = this._sheet(SHEET_NAMES.history);
    const id = this._nextId(SHEET_NAMES.history);
    sheet.appendRow([
      id, row.timestamp, row.candidate_id, row.candidate_name, row.job_id,
      row.job_title, row.stage_from_id ?? "", row.stage_from_name, row.stage_to_id,
      row.stage_to_name, row.changed_by, row.days_in_previous_stage,
    ]);
    this._invalidate(SHEET_NAMES.history);
  }

  private _rowToHistory(r: unknown[]): HistoryRow {
    return {
      id: parseNum(r[HISTORY_COLS.id]),
      timestamp: parseStr(r[HISTORY_COLS.timestamp]),
      candidate_id: parseNum(r[HISTORY_COLS.candidate_id]),
      candidate_name: parseStr(r[HISTORY_COLS.candidate_name]),
      job_id: parseNum(r[HISTORY_COLS.job_id]),
      job_title: parseStr(r[HISTORY_COLS.job_title]),
      stage_from_id: parseNumOrNull(r[HISTORY_COLS.stage_from_id]),
      stage_from_name: parseStr(r[HISTORY_COLS.stage_from_name]),
      stage_to_id: parseNum(r[HISTORY_COLS.stage_to_id]),
      stage_to_name: parseStr(r[HISTORY_COLS.stage_to_name]),
      changed_by: parseStr(r[HISTORY_COLS.changed_by]),
      days_in_previous_stage: parseNum(r[HISTORY_COLS.days_in_previous_stage]),
    };
  }

  getHistoryForCandidate(candidateId: number): HistoryRow[] {
    return this._getRows(SHEET_NAMES.history)
      .filter(r => parseNum(r[HISTORY_COLS.candidate_id]) === candidateId)
      .map(r => this._rowToHistory(r))
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  /** Single-scan fetch of all history — use this for dashboards to avoid O(n²). */
  getAllHistory(): HistoryRow[] {
    return this._getRows(SHEET_NAMES.history).map(r => this._rowToHistory(r));
  }

  // -------- Settings --------

  // ---------- Settings reads (CacheService-backed) ----------
  // Each getAll* below tries CacheService first (60s TTL, shared across all
  // users of this script). On miss, reads the sheet and populates the cache.
  // Settings change rarely but are read on every dashboard load and every
  // 15s sync poll, so this turns ~5 sheet reads per request into ~5 cache
  // lookups (~1ms each vs ~100-300ms each). All replace*() writes call
  // _settingsCacheInvalidate so changes propagate immediately.

  getAllStages(): StageRow[] {
    const cached = this._settingsCacheGet<StageRow>(SHEET_NAMES.stages);
    if (cached) return cached;
    const rows = this._getRows(SHEET_NAMES.stages).map(r => ({
      id: parseNum(r[STAGE_COLS.id]),
      name: parseStr(r[STAGE_COLS.name]),
      sequence: parseNum(r[STAGE_COLS.sequence]),
      color: parseStr(r[STAGE_COLS.color]),
      is_hired: parseBool(r[STAGE_COLS.is_hired]),
      is_rejected: parseBool(r[STAGE_COLS.is_rejected]),
      is_offer: parseBool(r[STAGE_COLS.is_offer]),
      target_hours: parseNumOrNull(r[STAGE_COLS.target_hours]),
      is_enabled: parseBool(r[STAGE_COLS.is_enabled]),
    }));
    this._settingsCacheSet(SHEET_NAMES.stages, rows);
    return rows;
  }

  getAllSources(): SourceRow[] {
    const cached = this._settingsCacheGet<SourceRow>(SHEET_NAMES.sources);
    if (cached) return cached;
    const rows = this._getRows(SHEET_NAMES.sources).map(r => ({
      id: parseNum(r[SOURCE_COLS.id]),
      name: parseStr(r[SOURCE_COLS.name]),
      medium: parseStr(r[SOURCE_COLS.medium]),
      default_motion: (parseStr(r[SOURCE_COLS.default_motion]) || "Inbound") as "Inbound" | "Outbound",
      is_enabled: parseBool(r[SOURCE_COLS.is_enabled]),
    }));
    this._settingsCacheSet(SHEET_NAMES.sources, rows);
    return rows;
  }

  getAllRegions(): RegionRow[] {
    const cached = this._settingsCacheGet<RegionRow>(SHEET_NAMES.regions);
    if (cached) return cached;
    const rows = this._getRows(SHEET_NAMES.regions).map(r => ({
      id: parseNum(r[REGION_COLS.id]),
      name: parseStr(r[REGION_COLS.name]),
      is_enabled: parseBool(r[REGION_COLS.is_enabled]),
    }));
    this._settingsCacheSet(SHEET_NAMES.regions, rows);
    return rows;
  }

  getAllRecruiters(): RecruiterRow[] {
    const cached = this._settingsCacheGet<RecruiterRow>(SHEET_NAMES.recruiters);
    if (cached) return cached;
    const rows = this._getRows(SHEET_NAMES.recruiters).map(r => ({
      id: parseNum(r[RECRUITER_COLS.id]),
      name: parseStr(r[RECRUITER_COLS.name]),
      email: parseStr(r[RECRUITER_COLS.email]),
      is_active: parseBool(r[RECRUITER_COLS.is_active]),
    }));
    this._settingsCacheSet(SHEET_NAMES.recruiters, rows);
    return rows;
  }

  getAllRefuseReasons(): RefuseReasonRow[] {
    const cached = this._settingsCacheGet<RefuseReasonRow>(SHEET_NAMES.refuseReasons);
    if (cached) return cached;
    const rows = this._getRows(SHEET_NAMES.refuseReasons).map(r => ({
      id: parseNum(r[REFUSE_COLS.id]),
      name: parseStr(r[REFUSE_COLS.name]),
      is_enabled: parseBool(r[REFUSE_COLS.is_enabled]),
    }));
    this._settingsCacheSet(SHEET_NAMES.refuseReasons, rows);
    return rows;
  }

  private _replaceSheet(sheetName: string, header: string[], rows: unknown[][]): void {
    const sheet = this._sheet(sheetName);
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
    }
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
    }
  }

  replaceStages(rows: StageRow[]): void {
    this._replaceSheet(SHEET_NAMES.stages, [], rows.map(r => [
      r.id, r.name, r.sequence, r.color, r.is_hired, r.is_rejected, r.is_offer, r.target_hours ?? "", r.is_enabled,
    ]));
    this._settingsCacheInvalidate(SHEET_NAMES.stages);
  }

  replaceSources(rows: SourceRow[]): void {
    this._replaceSheet(SHEET_NAMES.sources, [], rows.map(r => [
      r.id, r.name, r.medium, r.default_motion, r.is_enabled,
    ]));
    this._settingsCacheInvalidate(SHEET_NAMES.sources);
  }

  replaceRegions(rows: RegionRow[]): void {
    this._replaceSheet(SHEET_NAMES.regions, [], rows.map(r => [r.id, r.name, r.is_enabled]));
    this._settingsCacheInvalidate(SHEET_NAMES.regions);
  }

  replaceRecruiters(rows: RecruiterRow[]): void {
    this._replaceSheet(SHEET_NAMES.recruiters, [], rows.map(r => [r.id, r.name, r.email, r.is_active]));
    this._settingsCacheInvalidate(SHEET_NAMES.recruiters);
  }

  replaceRefuseReasons(rows: RefuseReasonRow[]): void {
    this._replaceSheet(SHEET_NAMES.refuseReasons, [], rows.map(r => [r.id, r.name, r.is_enabled]));
    this._settingsCacheInvalidate(SHEET_NAMES.refuseReasons);
  }

  seedDefaultData(): void {
    if (this.getAllStages().length === 0) {
      this.replaceStages(DEFAULT_STAGES);
    }
    if (this.getAllSources().length === 0) {
      this.replaceSources(DEFAULT_SOURCES);
    }
    if (this.getAllRegions().length === 0) {
      this.replaceRegions(DEFAULT_REGIONS);
    }
    if (this.getAllRefuseReasons().length === 0) {
      this.replaceRefuseReasons(DEFAULT_REFUSE_REASONS);
    }
  }

  // -------- Row mappers --------

  private _rowToCandidate(r: unknown[]): CandidateRow {
    return {
      id: parseNum(r[CANDIDATE_COLS.id]),
      first_name: parseStr(r[CANDIDATE_COLS.first_name]),
      last_name: parseStr(r[CANDIDATE_COLS.last_name]),
      email: parseStr(r[CANDIDATE_COLS.email]),
      phone: parseStr(r[CANDIDATE_COLS.phone]),
      job_id: parseNum(r[CANDIDATE_COLS.job_id]),
      stage_id: parseNum(r[CANDIDATE_COLS.stage_id]),
      recruiter_id: parseNumOrNull(r[CANDIDATE_COLS.recruiter_id]),
      source_id: parseNumOrNull(r[CANDIDATE_COLS.source_id]),
      region_id: parseNumOrNull(r[CANDIDATE_COLS.region_id]),
      motion: (parseStr(r[CANDIDATE_COLS.motion]) || "Inbound") as "Inbound" | "Outbound",
      status: (parseStr(r[CANDIDATE_COLS.status]) || "Active") as "Active" | "Hired" | "Rejected",
      rating: parseNum(r[CANDIDATE_COLS.rating]),
      linkedin_url: parseStr(r[CANDIDATE_COLS.linkedin_url]),
      resume_url: parseStr(r[CANDIDATE_COLS.resume_url]),
      notes: parseStr(r[CANDIDATE_COLS.notes]),
      refuse_reason_id: parseNumOrNull(r[CANDIDATE_COLS.refuse_reason_id]),
      kanban_state: (parseStr(r[CANDIDATE_COLS.kanban_state]) || "Normal") as "Normal" | "Blocked" | "Ready",
      post_hire_status: parseStr(r[CANDIDATE_COLS.post_hire_status]) as CandidateRow["post_hire_status"],
      date_applied: parseStr(r[CANDIDATE_COLS.date_applied]),
      date_last_stage_update: parseStr(r[CANDIDATE_COLS.date_last_stage_update]),
      created_by: parseStr(r[CANDIDATE_COLS.created_by]),
      created_at: parseStr(r[CANDIDATE_COLS.created_at]),
    };
  }

  private _candidateToRow(c: CandidateRow): unknown[] {
    return [
      c.id, c.first_name, c.last_name, c.email, c.phone,
      c.job_id, c.stage_id, c.recruiter_id ?? "", c.source_id ?? "", c.region_id ?? "",
      c.motion, c.status, c.rating, c.linkedin_url, c.resume_url,
      c.notes, c.refuse_reason_id ?? "", c.kanban_state, c.post_hire_status,
      c.date_applied, c.date_last_stage_update, c.created_by, c.created_at,
    ];
  }

  private _rowToJob(r: unknown[]): JobRow {
    return {
      id: parseNum(r[JOB_COLS.id]),
      title: parseStr(r[JOB_COLS.title]),
      department: parseStr(r[JOB_COLS.department]),
      location: parseStr(r[JOB_COLS.location]),
      region_id: parseNumOrNull(r[JOB_COLS.region_id]),
      status: (parseStr(r[JOB_COLS.status]) || "Open") as JobRow["status"],
      head_count: parseNum(r[JOB_COLS.head_count]),
      recruiter_id: parseNumOrNull(r[JOB_COLS.recruiter_id]),
      salary_range: parseStr(r[JOB_COLS.salary_range]),
      posted_date: parseStr(r[JOB_COLS.posted_date]),
      closes_date: parseStr(r[JOB_COLS.closes_date]),
      posting_expires: parseStr(r[JOB_COLS.posting_expires]),
      notes: parseStr(r[JOB_COLS.notes]),
      created_at: parseStr(r[JOB_COLS.created_at]),
    };
  }

  private _jobToRow(j: JobRow): unknown[] {
    return [
      j.id, j.title, j.department, j.location, j.region_id ?? "",
      j.status, j.head_count, j.recruiter_id ?? "", j.salary_range,
      j.posted_date, j.closes_date, j.posting_expires, j.notes, j.created_at,
    ];
  }
}

// -------- Default seed data --------

export const DEFAULT_STAGES: StageRow[] = [
  { id: 1, name: "Applied",         sequence: 100, color: "#1976d2", is_hired: false, is_rejected: false, is_offer: false, target_hours: 48,  is_enabled: true },
  { id: 2, name: "Reviewed",        sequence: 200, color: "#0288d1", is_hired: false, is_rejected: false, is_offer: false, target_hours: 72,  is_enabled: true },
  { id: 3, name: "Contacted",       sequence: 300, color: "#0097a7", is_hired: false, is_rejected: false, is_offer: false, target_hours: 48,  is_enabled: true },
  { id: 4, name: "Pre-screen",      sequence: 400, color: "#00897b", is_hired: false, is_rejected: false, is_offer: false, target_hours: 96,  is_enabled: true },
  { id: 5, name: "Roleplay/CG",     sequence: 500, color: "#43a047", is_hired: false, is_rejected: false, is_offer: false, target_hours: 120, is_enabled: true },
  { id: 6, name: "Final Interview", sequence: 600, color: "#fdd835", is_hired: false, is_rejected: false, is_offer: false, target_hours: 96,  is_enabled: true },
  { id: 7, name: "Offer",           sequence: 700, color: "#fb8c00", is_hired: false, is_rejected: false, is_offer: true,  target_hours: 48,  is_enabled: true },
  { id: 8, name: "Hired",           sequence: 800, color: "#4caf50", is_hired: true,  is_rejected: false, is_offer: false, target_hours: null, is_enabled: true },
  { id: 9, name: "Rejected",        sequence: 900, color: "#e53935", is_hired: false, is_rejected: true,  is_offer: false, target_hours: null, is_enabled: true },
];

export const DEFAULT_SOURCES: SourceRow[] = [
  { id: 1, name: "LinkedIn",  medium: "Direct",   default_motion: "Inbound",  is_enabled: true },
  { id: 2, name: "Indeed",    medium: "Website",  default_motion: "Inbound",  is_enabled: true },
  { id: 3, name: "Referral",  medium: "Direct",   default_motion: "Inbound",  is_enabled: true },
  { id: 4, name: "Outbound",  medium: "Direct",   default_motion: "Outbound", is_enabled: true },
  { id: 5, name: "Other",     medium: "Website",  default_motion: "Inbound",  is_enabled: true },
];

export const DEFAULT_REGIONS: RegionRow[] = [
  { id: 1, name: "US - East",      is_enabled: true },
  { id: 2, name: "US - West",      is_enabled: true },
  { id: 3, name: "US - Central",   is_enabled: true },
  { id: 4, name: "International",  is_enabled: true },
  { id: 5, name: "Remote",         is_enabled: true },
];

export const DEFAULT_REFUSE_REASONS: RefuseReasonRow[] = [
  { id: 1, name: "Failed Assessment",  is_enabled: true },
  { id: 2, name: "No-Show",            is_enabled: true },
  { id: 3, name: "Withdrew",           is_enabled: true },
  { id: 4, name: "Overqualified",      is_enabled: true },
  { id: 5, name: "Underqualified",     is_enabled: true },
  { id: 6, name: "Role Filled",        is_enabled: true },
  { id: 7, name: "Other",              is_enabled: true },
];
