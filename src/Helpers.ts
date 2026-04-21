/**
 * Helpers.ts — Cross-cutting utilities used by Code.ts.
 *
 * logHistory and joinCandidates are testable by injecting ISheetDB mocks.
 * getCurrentUserEmail() calls Session (GAS-only, tested via integration).
 */

import type { ISheetDB, CandidateRow, StageRow, JobRow, RecruiterRow, SourceRow, RegionRow, RefuseReasonRow } from "./types";

export function getCurrentUserEmail(): string {
  try {
    return Session.getActiveUser().getEmail() || "unknown@tpg.com";
  } catch {
    return "unknown@tpg.com";
  }
}

export function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

export function nowStr(): string {
  return new Date().toISOString();
}

/**
 * Computes days between two ISO date strings (or 0 if either is missing).
 */
export function daysBetween(dateA: string, dateB: string): number {
  if (!dateA || !dateB) return 0;
  return Math.round(
    Math.abs(new Date(dateB).getTime() - new Date(dateA).getTime()) / 86_400_000
  );
}

/**
 * Appends a stage transition to the history sheet.
 * Called whenever a candidate's stage changes.
 */
export function logHistory(
  db: ISheetDB,
  candidateId: number,
  candidateName: string,
  jobId: number,
  jobTitle: string,
  stageFromId: number | null,
  stageFromName: string,
  stageToId: number,
  stageToName: string,
  changedBy: string,
  dateLastStageUpdate: string
): void {
  const daysInPreviousStage = stageFromId
    ? daysBetween(dateLastStageUpdate, todayStr())
    : 0;

  db.appendHistory({
    timestamp: nowStr(),
    candidate_id: candidateId,
    candidate_name: candidateName,
    job_id: jobId,
    job_title: jobTitle,
    stage_from_id: stageFromId,
    stage_from_name: stageFromName,
    stage_to_id: stageToId,
    stage_to_name: stageToName,
    changed_by: changedBy,
    days_in_previous_stage: daysInPreviousStage,
  });
}

/**
 * Enriches a raw CandidateRow with joined display fields from lookup tables.
 */
export function joinCandidate(
  c: CandidateRow,
  stages: StageRow[],
  jobs: JobRow[],
  recruiters: RecruiterRow[],
  sources: SourceRow[],
  regions: RegionRow[],
  refuseReasons: RefuseReasonRow[]
): CandidateRow {
  const stage = stages.find(s => s.id === c.stage_id);
  const job = jobs.find(j => j.id === c.job_id);
  const recruiter = recruiters.find(r => r.id === c.recruiter_id);
  const source = sources.find(s => s.id === c.source_id);
  const region = regions.find(r => r.id === c.region_id);
  const reason = refuseReasons.find(r => r.id === c.refuse_reason_id);

  const today = new Date();
  const daysInStage = c.date_last_stage_update
    ? Math.round((today.getTime() - new Date(c.date_last_stage_update).getTime()) / 86_400_000)
    : 0;
  const daysSinceApplied = c.date_applied
    ? Math.round((today.getTime() - new Date(c.date_applied).getTime()) / 86_400_000)
    : 0;

  return {
    ...c,
    full_name: `${c.first_name} ${c.last_name}`,
    stage_name: stage?.name ?? "",
    stage_color: stage?.color ?? "#6c757d",
    job_title: job?.title ?? "",
    recruiter_name: recruiter?.name ?? "",
    source_name: source?.name ?? "",
    region_name: region?.name ?? "",
    refuse_reason_name: reason?.name ?? "",
    days_in_stage: daysInStage,
    days_since_applied: daysSinceApplied,
  };
}

/**
 * Bulk-join array of candidates.
 */
export function joinCandidates(
  candidates: CandidateRow[],
  db: ISheetDB
): CandidateRow[] {
  const stages = db.getAllStages();
  const jobs = db.getAllJobs();
  const recruiters = db.getAllRecruiters();
  const sources = db.getAllSources();
  const regions = db.getAllRegions();
  const refuseReasons = db.getAllRefuseReasons();

  return candidates.map(c =>
    joinCandidate(c, stages, jobs, recruiters, sources, regions, refuseReasons)
  );
}
