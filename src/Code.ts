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
  computeKpis,
  computePipelineSnapshot,
  computeFunnelConversion,
  computeRecruiterPerformance,
  computeSourceEffectiveness,
  computeTimeToHireTrend,
  computeStageVelocity,
  computeSlaBreaches,
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
  ensureDefaultData();
  return HtmlService.createTemplateFromFile("frontend/index")
    .evaluate()
    .setTitle("TPG Recruiting ATS")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
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

  if (filters.startDate) {
    const start = new Date(filters.startDate).getTime();
    all = all.filter(c => c.date_applied && new Date(c.date_applied).getTime() >= start);
  }
  if (filters.endDate) {
    const end = new Date(filters.endDate).getTime();
    all = all.filter(c => c.date_applied && new Date(c.date_applied).getTime() <= end);
  }

  return joinCandidates(all, db);
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
      recruiter_id:           null,
      source_id:              data.source_id ?? null,
      region_id:              data.region_id ?? null,
      motion,
      status:                 "Active",
      rating:                 0,
      linkedin_url:           "",
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

function updateCandidate(id: number, data: UpdateCandidateInput): void {
  withLock(() => getDB().updateCandidate(id, data));
}

function updateCandidateStage(id: number, newStageId: number): void {
  withLock(() => {
    const db = getDB();
    const candidate = db.getCandidateById(id);
    if (!candidate) throw new Error(`Candidate ${id} not found`);
    if (candidate.stage_id === newStageId) return;

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

function rejectCandidate(id: number, refuseReasonId: number): void {
  withLock(() => {
    const db = getDB();
    const candidate = db.getCandidateById(id);
    if (!candidate) throw new Error(`Candidate ${id} not found`);

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

function getDashboardData(filters: DashboardFilters): DashboardResult {
  const db = getDB();
  const candidates  = db.getAllCandidates();
  const jobs        = db.getAllJobs();
  const stages      = db.getAllStages();
  const sources     = db.getAllSources();
  const regions     = db.getAllRegions();
  const recruiters  = db.getAllRecruiters();
  const refuseReasons = db.getAllRefuseReasons();

  // Single-scan history fetch (was O(n²) via per-candidate filter before)
  const allHistory = db.getAllHistory();

  const joinedCandidates = candidates.map(c =>
    joinCandidate(c, stages, jobs, recruiters, sources, regions, refuseReasons)
  );

  const recentHires = joinedCandidates
    .filter(c => c.status === "Hired")
    .sort((a, b) =>
      new Date(b.date_last_stage_update).getTime() -
      new Date(a.date_last_stage_update).getTime()
    )
    .slice(0, 20);

  return {
    kpis:                 computeKpis(candidates, jobs, stages, filters),
    pipelineSnapshot:     computePipelineSnapshot(candidates, stages, filters),
    funnelConversion:     computeFunnelConversion(allHistory, stages, filters),
    recruiterPerformance: computeRecruiterPerformance(candidates, recruiters, filters),
    sourceEffectiveness:  computeSourceEffectiveness(candidates, sources, filters),
    timeToHireTrend:      computeTimeToHireTrend(candidates),
    stageVelocity:        computeStageVelocity(allHistory, stages, filters),
    slaBreaches:          computeSlaBreaches(candidates, stages, recruiters, jobs, filters),
    recentHires,
  };
}

// ============================================================
// Multi-user sync fingerprint
// ============================================================

/**
 * Returns a lightweight fingerprint the frontend polls every ~15s.
 * If the fingerprint changes between polls, the client refetches the
 * current view's data. Much cheaper than refetching everything every tick.
 * Fingerprint = max(candidate.id), max(candidate.date_last_stage_update),
 * max(job.id), count(candidates), count(jobs).
 */
function getSyncFingerprint(): { sig: string; userEmail: string } {
  const db = getDB();
  const candidates = db.getAllCandidates();
  const jobs = db.getAllJobs();

  let maxCandidateId = 0;
  let latestStageUpdate = "";
  let activeCount = 0;
  for (const c of candidates) {
    if (c.id > maxCandidateId) maxCandidateId = c.id;
    if (c.date_last_stage_update > latestStageUpdate) latestStageUpdate = c.date_last_stage_update;
    if (c.status === "Active") activeCount++;
  }

  const maxJobId = jobs.reduce((m, j) => Math.max(m, j.id), 0);

  return {
    sig: [
      candidates.length,
      activeCount,
      maxCandidateId,
      latestStageUpdate,
      jobs.length,
      maxJobId,
    ].join("|"),
    userEmail: getSessionEmail(),
  };
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
