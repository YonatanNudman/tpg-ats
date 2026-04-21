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

function parseStr(val: unknown): string {
  return val == null ? "" : String(val);
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

  private _getRows(sheetName: string): unknown[][] {
    const sheet = this._sheet(sheetName);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    return sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  }

  private _nextId(sheetName: string): number {
    const rows = this._getRows(sheetName);
    if (rows.length === 0) return 1;
    const ids = rows.map(r => parseNum(r[0])).filter(n => n > 0);
    return ids.length > 0 ? Math.max(...ids) + 1 : 1;
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
    return { ...row, id };
  }

  updateCandidate(id: number, updates: Partial<CandidateRow>): void {
    const rowIndex = this._findRowIndex(SHEET_NAMES.candidates, id);
    if (rowIndex < 0) throw new Error(`Candidate ${id} not found`);
    const sheet = this._sheet(SHEET_NAMES.candidates);
    const existing = this._rowToCandidate(
      sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0]
    );
    const merged = { ...existing, ...updates, id };
    sheet.getRange(rowIndex, 1, 1, 23).setValues([this._candidateToRow(merged)]);
  }

  deleteCandidate(id: number): void {
    const rowIndex = this._findRowIndex(SHEET_NAMES.candidates, id);
    if (rowIndex < 0) throw new Error(`Candidate ${id} not found`);
    this._sheet(SHEET_NAMES.candidates).deleteRow(rowIndex);
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
    return { ...row, id };
  }

  updateJob(id: number, updates: Partial<JobRow>): void {
    const rowIndex = this._findRowIndex(SHEET_NAMES.jobs, id);
    if (rowIndex < 0) throw new Error(`Job ${id} not found`);
    const sheet = this._sheet(SHEET_NAMES.jobs);
    const existing = this._rowToJob(
      sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0]
    );
    const merged = { ...existing, ...updates, id };
    sheet.getRange(rowIndex, 1, 1, 14).setValues([this._jobToRow(merged)]);
  }

  deleteJob(id: number): void {
    const rowIndex = this._findRowIndex(SHEET_NAMES.jobs, id);
    if (rowIndex < 0) throw new Error(`Job ${id} not found`);
    this._sheet(SHEET_NAMES.jobs).deleteRow(rowIndex);
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

  getAllStages(): StageRow[] {
    return this._getRows(SHEET_NAMES.stages).map(r => ({
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
  }

  getAllSources(): SourceRow[] {
    return this._getRows(SHEET_NAMES.sources).map(r => ({
      id: parseNum(r[SOURCE_COLS.id]),
      name: parseStr(r[SOURCE_COLS.name]),
      medium: parseStr(r[SOURCE_COLS.medium]),
      default_motion: (parseStr(r[SOURCE_COLS.default_motion]) || "Inbound") as "Inbound" | "Outbound",
      is_enabled: parseBool(r[SOURCE_COLS.is_enabled]),
    }));
  }

  getAllRegions(): RegionRow[] {
    return this._getRows(SHEET_NAMES.regions).map(r => ({
      id: parseNum(r[REGION_COLS.id]),
      name: parseStr(r[REGION_COLS.name]),
      is_enabled: parseBool(r[REGION_COLS.is_enabled]),
    }));
  }

  getAllRecruiters(): RecruiterRow[] {
    return this._getRows(SHEET_NAMES.recruiters).map(r => ({
      id: parseNum(r[RECRUITER_COLS.id]),
      name: parseStr(r[RECRUITER_COLS.name]),
      email: parseStr(r[RECRUITER_COLS.email]),
      is_active: parseBool(r[RECRUITER_COLS.is_active]),
    }));
  }

  getAllRefuseReasons(): RefuseReasonRow[] {
    return this._getRows(SHEET_NAMES.refuseReasons).map(r => ({
      id: parseNum(r[REFUSE_COLS.id]),
      name: parseStr(r[REFUSE_COLS.name]),
      is_enabled: parseBool(r[REFUSE_COLS.is_enabled]),
    }));
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
  }

  replaceSources(rows: SourceRow[]): void {
    this._replaceSheet(SHEET_NAMES.sources, [], rows.map(r => [
      r.id, r.name, r.medium, r.default_motion, r.is_enabled,
    ]));
  }

  replaceRegions(rows: RegionRow[]): void {
    this._replaceSheet(SHEET_NAMES.regions, [], rows.map(r => [r.id, r.name, r.is_enabled]));
  }

  replaceRecruiters(rows: RecruiterRow[]): void {
    this._replaceSheet(SHEET_NAMES.recruiters, [], rows.map(r => [r.id, r.name, r.email, r.is_active]));
  }

  replaceRefuseReasons(rows: RefuseReasonRow[]): void {
    this._replaceSheet(SHEET_NAMES.refuseReasons, [], rows.map(r => [r.id, r.name, r.is_enabled]));
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
