/**
 * Analytics.ts — All dashboard calculations as pure functions.
 *
 * No Google API calls. Input: raw arrays from SheetDB.
 * Output: typed result objects for the frontend.
 * 100% unit-testable with Jest.
 */

import type {
  CandidateRow,
  JobRow,
  HistoryRow,
  StageRow,
  SourceRow,
  RecruiterRow,
  RefuseReasonRow,
  DashboardFilters,
  KpiData,
  PipelineSnapshotItem,
  FunnelItem,
  RecruiterPerformanceItem,
  SourceEffectivenessItem,
  MonthlyTrendItem,
  StageVelocityItem,
  RejectionReasonItem,
  SlaBreachItem,
  StaleCandidateItem,
  WaterfallItem,
  WaterfallResult,
  WaterfallFilters,
  WaterfallBenchmarkRow,
} from "./types";

// ---------- Filters ----------

/**
 * Calendar-date comparator. Both filter inputs ("YYYY-MM-DD" strings) and
 * candidate values (which may arrive as full ISO timestamps when Sheets
 * auto-coerces a date cell to a JS Date in a non-UTC locale) are reduced
 * to their `YYYY-MM-DD` prefix before comparison. Avoids the "candidate
 * applied today at midnight Eastern (= 4am UTC) is excluded from a
 * Last-90-Days filter whose endDate parses as midnight UTC" bug.
 *
 * Trade-off: assumes candidates and recruiters share the spreadsheet's
 * timezone (US-based for TPG). A candidate whose date_applied falls on
 * a different calendar date in another timezone would still slot into
 * the wrong bucket, but that's not a current concern for this team.
 */
function dateOnly(s: string | undefined | null): string {
  return String(s || "").slice(0, 10);
}

/**
 * Normalize a scope axis from the dual single/plural filter shape into a
 * flat array of values. Plural wins when set & non-empty; otherwise the
 * single value is promoted. Returns [] when neither is set — meaning
 * "no filter on this axis".
 *
 * Strings are coerced to numbers at this boundary (Alpine dropdowns send
 * `"1"`, row data stores `1`), while known sentinels pass through verbatim.
 * This makes every downstream comparison an apples-to-apples equality check.
 */
function normalizeAxis<T extends string>(
  plural: ReadonlyArray<number | T> | null | undefined,
  single: number | T | null | undefined | string,
  sentinels: readonly T[] = [] as any,
): Array<number | T> {
  const raw: Array<number | T | string> = [];
  if (Array.isArray(plural) && plural.length > 0) {
    for (const v of plural) raw.push(v as any);
  } else if (single !== null && single !== undefined && single !== "") {
    raw.push(single as any);
  }
  const out: Array<number | T> = [];
  for (const v of raw) {
    if (typeof v === "string" && (sentinels as readonly string[]).indexOf(v) !== -1) {
      out.push(v as T);
      continue;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      out.push(v);
      continue;
    }
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}

/** Empty `allowed` = no filter → always true.
 *  `__unassigned__` matches null/0 candidate ids. */
function matchIdAxis(
  allowed: Array<number | string>,
  candidateId: number | null | undefined,
): boolean {
  if (allowed.length === 0) return true;
  const unassigned = candidateId == null || candidateId === 0;
  for (const v of allowed) {
    if (v === "__unassigned__") {
      if (unassigned) return true;
      continue;
    }
    if (!unassigned && v === candidateId) return true;
  }
  return false;
}

/** Recruiter axis adds the `__assigned__` sentinel (inverse of unassigned). */
function matchRecruiterAxis(
  allowed: Array<number | string>,
  recruiterId: number | null | undefined,
): boolean {
  if (allowed.length === 0) return true;
  const unassigned = recruiterId == null || recruiterId === 0;
  for (const v of allowed) {
    if (v === "__unassigned__") {
      if (unassigned) return true;
      continue;
    }
    if (v === "__assigned__") {
      if (!unassigned) return true;
      continue;
    }
    if (!unassigned && v === recruiterId) return true;
  }
  return false;
}

/** Motion axis values are "Inbound" | "Outbound" | "__unassigned__".
 *  Accepts a looser `Array<number | string>` input for call-site ergonomics
 *  (normalizeAxis returns a union type); numeric entries simply never match. */
function matchMotionAxis(
  allowed: Array<number | string>,
  motion: string | null | undefined,
): boolean {
  if (allowed.length === 0) return true;
  const isSet = motion === "Inbound" || motion === "Outbound";
  for (const v of allowed) {
    if (typeof v !== "string") continue;
    if (v === "__unassigned__") {
      if (!isSet) return true;
      continue;
    }
    if (v === motion) return true;
  }
  return false;
}

export function filterCandidates(
  candidates: CandidateRow[],
  filters: DashboardFilters
): CandidateRow[] {
  const start = dateOnly(filters.startDate);
  const end = dateOnly(filters.endDate);

  const jobs = normalizeAxis(filters.jobIds,       filters.jobId,       ["__unassigned__"] as const);
  const recs = normalizeAxis(filters.recruiterIds, filters.recruiterId, ["__unassigned__", "__assigned__"] as const);
  const srcs = normalizeAxis(filters.sourceIds,    filters.sourceId,    ["__unassigned__"] as const);
  const regs = normalizeAxis(filters.regionIds,    filters.regionId,    ["__unassigned__"] as const);
  const mots = normalizeAxis(filters.motions,      filters.motion,      ["__unassigned__", "Inbound", "Outbound"] as const);

  return candidates.filter(c => {
    if (!matchIdAxis(jobs, c.job_id)) return false;
    if (!matchRecruiterAxis(recs, c.recruiter_id)) return false;
    if (!matchIdAxis(srcs, c.source_id)) return false;
    if (!matchIdAxis(regs, c.region_id)) return false;
    if (!matchMotionAxis(mots, c.motion)) return false;
    if (filters.status && c.status !== filters.status) return false;
    const applied = dateOnly(c.date_applied);
    if (start && applied && applied < start) return false;
    if (end   && applied && applied > end)   return false;
    return true;
  });
}

// ---------- KPI ----------

export function computeKpis(
  candidates: CandidateRow[],
  jobs: JobRow[],
  stages: StageRow[],
  filters: DashboardFilters
): KpiData {
  // Apply all non-status filters (job/source/motion/region/recruiter + date range)
  // so status-specific KPIs (hires, active, SLA) each compute from their own subset.
  // See bug: previously `filtered` baked in the status filter, making
  // "Hires This Period" always 0 when the topbar was set to Active (the default).
  const filtersNoStatus: DashboardFilters = { ...filters, status: null };
  const inScope = filterCandidates(candidates, filtersNoStatus);
  const today = new Date();

  const activeCandidates  = inScope.filter(c => c.status === "Active").length;
  const hiresThisPeriod   = inScope.filter(c => c.status === "Hired").length;
  const openPositions     = jobs.filter(j => j.status === "Open").length;

  // SLA breaches: active candidates past their stage's target_hours
  const stageMap = new Map(stages.map(s => [s.id, s]));
  let slaBreaches = 0;
  for (const c of inScope) {
    if (c.status !== "Active") continue;
    const stage = stageMap.get(c.stage_id);
    if (!stage?.target_hours) continue;
    const lastUpdate = c.date_last_stage_update
      ? new Date(c.date_last_stage_update)
      : new Date(c.date_applied);
    const hoursInStage = (today.getTime() - lastUpdate.getTime()) / 3_600_000;
    if (hoursInStage > stage.target_hours) slaBreaches++;
  }

  // Avg days to hire — only meaningful across hires in the period
  const hires = inScope.filter(c => c.status === "Hired" && c.date_applied && c.date_last_stage_update);
  const avgDaysToHire = hires.length > 0
    ? hires.reduce((sum, c) => {
        const days = (new Date(c.date_last_stage_update).getTime() - new Date(c.date_applied).getTime()) / 86_400_000;
        return sum + days;
      }, 0) / hires.length
    : 0;

  // Offer acceptance rate: hires / (hires + rejected from offer stage).
  // Also ignores the status filter — otherwise it's divide-by-zero when
  // the user filters to only Active candidates.
  const offerStage = stages.find(s => s.is_offer);
  let offerAcceptanceRate = 0;
  if (offerStage) {
    const offersExtended = inScope.filter(c =>
      c.status === "Hired" || c.status === "Rejected"
    ).length;
    const accepted = inScope.filter(c => c.status === "Hired").length;
    offerAcceptanceRate = offersExtended > 0 ? (accepted / offersExtended) * 100 : 0;
  }

  const expiredPostings = jobs.filter(j =>
    j.status === "Open" && j.posting_expires &&
    new Date(j.posting_expires).getTime() < today.getTime()
  ).length;

  const expiringPostings = jobs.filter(j => {
    if (j.status !== "Open" || !j.posting_expires) return false;
    const exp = new Date(j.posting_expires).getTime();
    const sevenDays = today.getTime() + 7 * 86_400_000;
    return exp >= today.getTime() && exp <= sevenDays;
  }).length;

  return {
    activeCandidates,
    openPositions,
    hiresThisPeriod,
    slaBreaches,
    avgDaysToHire: Math.round(avgDaysToHire * 10) / 10,
    offerAcceptanceRate: Math.round(offerAcceptanceRate * 10) / 10,
    expiredPostings,
    expiringPostings,
  };
}

// ---------- Pipeline Snapshot ----------

export function computePipelineSnapshot(
  candidates: CandidateRow[],
  stages: StageRow[],
  filters: DashboardFilters
): PipelineSnapshotItem[] {
  const filtered = filterCandidates(candidates, filters).filter(c => c.status === "Active");
  const countMap = new Map<number, number>();
  for (const c of filtered) {
    countMap.set(c.stage_id, (countMap.get(c.stage_id) ?? 0) + 1);
  }

  return stages
    .filter(s => s.is_enabled && !s.is_rejected)
    .sort((a, b) => a.sequence - b.sequence)
    .map(s => ({
      stage_id: s.id,
      stage_name: s.name,
      stage_color: s.color,
      sequence: s.sequence,
      candidate_count: countMap.get(s.id) ?? 0,
    }));
}

// ---------- Funnel Conversion ----------

export function computeFunnelConversion(
  history: HistoryRow[],
  stages: StageRow[],
  filters: DashboardFilters
): FunnelItem[] {
  // Calendar-date comparison via dateOnly() — was previously
  // `new Date(filters.endDate).getTime()` which parses an end date like
  // "2026-04-23" as midnight UTC, then EXCLUDES every history row whose
  // timestamp is later that same day. Net effect: today's transitions
  // never showed up in the funnel. Same fix applied to computeStageVelocity
  // below; matches the pattern filterCandidates and computeWaterfall already
  // use (see dateOnly's docstring).
  const start = filters.startDate ? dateOnly(filters.startDate) : "";
  const end   = filters.endDate   ? dateOnly(filters.endDate)   : "";

  // Count transitions INTO each stage (from a different stage).
  // Job-scope check runs against the normalized axis so multi-select works.
  const histJobAxis = normalizeAxis(filters.jobIds, filters.jobId, ["__unassigned__"] as const);
  const entryCounts = new Map<number, Set<number>>(); // stageId → Set<candidateId>
  for (const h of history) {
    const tsDate = dateOnly(h.timestamp);
    if (start && tsDate && tsDate < start) continue;
    if (end   && tsDate && tsDate > end)   continue;
    if (!matchIdAxis(histJobAxis, h.job_id)) continue;
    if (h.stage_from_id === h.stage_to_id) continue; // initial placement, not a transition

    if (!entryCounts.has(h.stage_to_id)) entryCounts.set(h.stage_to_id, new Set());
    entryCounts.get(h.stage_to_id)!.add(h.candidate_id);
  }

  const orderedStages = stages
    .filter(s => s.is_enabled && !s.is_rejected)
    .sort((a, b) => a.sequence - b.sequence);

  let prevCount: number | null = null;
  return orderedStages.map(s => {
    const entered = entryCounts.get(s.id)?.size ?? 0;
    const conversionRate = prevCount !== null && prevCount > 0
      ? Math.round((entered / prevCount) * 1000) / 10
      : 100;
    prevCount = entered;
    return {
      stage_id: s.id,
      stage_name: s.name,
      sequence: s.sequence,
      entered_count: entered,
      conversion_rate: conversionRate,
    };
  });
}

// ---------- Recruiter Performance ----------

/**
 * Recruiter performance leaderboard.
 *
 * `filters`        — applies to the Candidates / Rejections / Avg Days /
 *                    Queue columns. The "what's their caseload right now"
 *                    metrics share the dashboard's primary scope.
 * `hiresFilters`   — OPTIONAL separate filter for the Hires column ONLY.
 *                    Lets the dashboard show e.g. "Last 30 days hires"
 *                    while the rest of the columns honor a wider period.
 *                    Defaults to the same scope as `filters` when omitted.
 *
 * Includes ALL active recruiters (not just those with > 0 candidates) so
 * the team roster is visible at a glance — a recruiter with an empty
 * queue is its own kind of signal worth surfacing on the dashboard.
 */
export function computeRecruiterPerformance(
  candidates: CandidateRow[],
  recruiters: RecruiterRow[],
  filters: DashboardFilters,
  hiresFilters?: DashboardFilters
): RecruiterPerformanceItem[] {
  const filtered = filterCandidates(candidates, filters);
  const hiresScope = hiresFilters
    ? filterCandidates(candidates, hiresFilters)
    : filtered;

  return recruiters
    .filter(r => r.is_active)
    .map(r => {
      const mine = filtered.filter(c => c.recruiter_id === r.id);
      const active = mine.filter(c => c.status === "Active").length;
      const hires = mine.filter(c => c.status === "Hired");
      const hiresInPeriod = hiresScope.filter(c => c.recruiter_id === r.id && c.status === "Hired").length;
      const rejections = mine.filter(c => c.status === "Rejected").length;

      const avgDaysToHire = hires.length > 0
        ? hires.reduce((sum, c) => {
            if (!c.date_applied || !c.date_last_stage_update) return sum;
            return sum + (new Date(c.date_last_stage_update).getTime() - new Date(c.date_applied).getTime()) / 86_400_000;
          }, 0) / hires.length
        : 0;

      return {
        recruiter_id: r.id,
        recruiter_name: r.name,
        total_candidates: mine.length,
        active_candidates: active,
        queue: active,
        hires: hires.length,
        hires_in_period: hiresInPeriod,
        rejections,
        avg_days_to_hire: Math.round(avgDaysToHire * 10) / 10,
      };
    })
    .sort((a, b) =>
      b.hires_in_period - a.hires_in_period ||
      b.queue - a.queue ||
      b.total_candidates - a.total_candidates
    );
}

// ---------- Source Effectiveness ----------

export function computeSourceEffectiveness(
  candidates: CandidateRow[],
  sources: SourceRow[],
  filters: DashboardFilters
): SourceEffectivenessItem[] {
  const filtered = filterCandidates(candidates, filters);

  return sources
    .filter(s => s.is_enabled)
    .map(s => {
      const mine = filtered.filter(c => c.source_id === s.id);
      const hired = mine.filter(c => c.status === "Hired").length;
      const hireRate = mine.length > 0 ? Math.round((hired / mine.length) * 1000) / 10 : 0;

      return {
        source_id: s.id,
        source_name: s.name,
        medium: s.medium,
        total_candidates: mine.length,
        hired_candidates: hired,
        hire_rate: hireRate,
      };
    })
    .filter(s => s.total_candidates > 0)
    .sort((a, b) => b.hired_candidates - a.hired_candidates || b.total_candidates - a.total_candidates);
}

// ---------- Time to Hire Trend (monthly) ----------

export function computeTimeToHireTrend(
  candidates: CandidateRow[],
  monthsBack = 6
): MonthlyTrendItem[] {
  // Bucket by calendar-month PREFIX ("YYYY-MM") rather than millis. The
  // previous code built bucket boundaries with `new Date(year, month, …)`
  // (local time) and compared them to `new Date(c.date_last_stage_update)`
  // (UTC midnight from the "YYYY-MM-DD" string). In US Eastern, this
  // attributed the first 4-5 hours of any month to the PREVIOUS month —
  // a candidate hired April 1 showed up in March.
  //
  // Prefix-based comparison is timezone-invariant for our purposes: the
  // stored date string IS the calendar date, regardless of how the
  // server's locale would render its midnight.
  const now = new Date();
  const result: MonthlyTrendItem[] = [];

  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleString("default", { month: "short", year: "2-digit" });
    const ymPrefix = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");

    const hires = candidates.filter(c => {
      if (c.status !== "Hired" || !c.date_last_stage_update) return false;
      return dateOnly(c.date_last_stage_update).slice(0, 7) === ymPrefix;
    });

    const avg = hires.length > 0
      ? hires.reduce((sum, c) => {
          if (!c.date_applied) return sum;
          return sum + (new Date(c.date_last_stage_update).getTime() - new Date(c.date_applied).getTime()) / 86_400_000;
        }, 0) / hires.length
      : 0;

    result.push({ month_label: label, avg_days_to_hire: Math.round(avg * 10) / 10 });
  }

  return result;
}

// ---------- Stage Velocity ----------

export function computeStageVelocity(
  history: HistoryRow[],
  stages: StageRow[],
  filters: DashboardFilters
): StageVelocityItem[] {
  // Calendar-date comparison via dateOnly() — see computeFunnelConversion
  // for the rationale on why `new Date(endDate).getTime()` was wrong.
  const start = filters.startDate ? dateOnly(filters.startDate) : "";
  const end   = filters.endDate   ? dateOnly(filters.endDate)   : "";

  // For each stage, compute average days spent based on history transitions.
  const stageDays = new Map<number, number[]>();
  // Per-stage rejection count: how many candidates were rejected FROM
  // this stage in the period. Surfaces "where do we lose people" as a
  // direct companion to dwell time. See StageVelocityItem.rejected_count.
  const rejectedFromStage = new Map<number, number>();
  const rejectedStageId = stages.find(s => s.is_rejected && s.is_enabled)?.id;

  const velJobAxis = normalizeAxis(filters.jobIds, filters.jobId, ["__unassigned__"] as const);
  for (const h of history) {
    const tsDate = dateOnly(h.timestamp);
    if (start && tsDate && tsDate < start) continue;
    if (end   && tsDate && tsDate > end)   continue;
    if (!matchIdAxis(velJobAxis, h.job_id)) continue;

    // Dwell-time sample. The previous `> 0` guard was overly aggressive:
    // it dropped legitimate same-day moves (which round to 0 days via
    // daysBetween's Math.round). Result: faster teams looked SLOWER on
    // the chart because their fast moves were silently filtered out.
    // The `stage_from_id` check alone correctly excludes initial
    // placements (those have stage_from_id = null).
    if (h.stage_from_id) {
      if (!stageDays.has(h.stage_from_id)) stageDays.set(h.stage_from_id, []);
      stageDays.get(h.stage_from_id)!.push(h.days_in_previous_stage);
    }

    // Rejection-from-stage tally: a transition to the rejected stage,
    // attributed to the stage the candidate was IN when it happened.
    if (rejectedStageId && h.stage_to_id === rejectedStageId && h.stage_from_id) {
      rejectedFromStage.set(
        h.stage_from_id,
        (rejectedFromStage.get(h.stage_from_id) ?? 0) + 1,
      );
    }
  }

  return stages
    .filter(s => s.is_enabled && !s.is_rejected)
    .sort((a, b) => a.sequence - b.sequence)
    .map(s => {
      const days = stageDays.get(s.id) ?? [];
      const avg = days.length > 0 ? days.reduce((a, b) => a + b, 0) / days.length : 0;
      return {
        stage_id: s.id,
        stage_name: s.name,
        stage_color: s.color,
        avg_days_in_stage: Math.round(avg * 10) / 10,
        candidate_count: days.length,
        rejected_count: rejectedFromStage.get(s.id) ?? 0,
      };
    });
}

// ---------- Rejection Reasons (period-bounded) ----------

/**
 * Top rejection reasons in the filter period. Period is interpreted as
 * "candidates rejected during this window," so the date filter is
 * applied to `date_last_stage_update` (when they moved to Rejected),
 * NOT `date_applied`. That's what filterCandidates would do, hence the
 * custom per-field filter logic below.
 *
 * Skips candidates whose `refuse_reason_id` is blank — those pre-date
 * the structured-reason workflow and would otherwise dominate the top
 * of the list as "(none)" without giving the team anything actionable.
 */
export function computeRejectionReasons(
  candidates: CandidateRow[],
  refuseReasons: RefuseReasonRow[],
  filters: DashboardFilters,
): RejectionReasonItem[] {
  const start = dateOnly(filters.startDate);
  const end   = dateOnly(filters.endDate);
  const reasonMap = new Map(refuseReasons.map(r => [r.id, r.name]));
  const counts = new Map<number, number>();

  // Per-field filter checks. We don't reuse filterCandidates() because
  // it filters by date_applied, but here the meaningful date is the
  // rejection date (date_last_stage_update for status=Rejected).
  const jobAxis = normalizeAxis(filters.jobIds,       filters.jobId,       ["__unassigned__"] as const);
  const recAxis = normalizeAxis(filters.recruiterIds, filters.recruiterId, ["__unassigned__", "__assigned__"] as const);
  const srcAxis = normalizeAxis(filters.sourceIds,    filters.sourceId,    ["__unassigned__"] as const);
  const regAxis = normalizeAxis(filters.regionIds,    filters.regionId,    ["__unassigned__"] as const);
  const motAxis = normalizeAxis(filters.motions,      filters.motion,      ["__unassigned__", "Inbound", "Outbound"] as const);

  for (const c of candidates) {
    if (c.status !== "Rejected") continue;
    if (!c.refuse_reason_id) continue;

    if (!matchIdAxis(jobAxis, c.job_id)) continue;
    if (!matchRecruiterAxis(recAxis, c.recruiter_id)) continue;
    if (!matchIdAxis(srcAxis, c.source_id)) continue;
    if (!matchIdAxis(regAxis, c.region_id)) continue;
    if (!matchMotionAxis(motAxis, c.motion)) continue;

    const rejectedOn = dateOnly(c.date_last_stage_update);
    if (start && rejectedOn && rejectedOn < start) continue;
    if (end   && rejectedOn && rejectedOn > end)   continue;

    counts.set(c.refuse_reason_id, (counts.get(c.refuse_reason_id) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([id, count]) => ({
      reason_id:   id,
      reason_name: reasonMap.get(id) ?? "(unknown)",
      count,
    }))
    .sort((a, b) => b.count - a.count || a.reason_name.localeCompare(b.reason_name));
}

// ---------- SLA Breaches ----------

export function computeSlaBreaches(
  candidates: CandidateRow[],
  stages: StageRow[],
  recruiters: RecruiterRow[],
  jobs: JobRow[],
  filters: DashboardFilters
): SlaBreachItem[] {
  const filtered = filterCandidates(candidates, filters).filter(c => c.status === "Active");
  const stageMap = new Map(stages.map(s => [s.id, s]));
  const recruiterMap = new Map(recruiters.map(r => [r.id, r.name]));
  const jobMap = new Map(jobs.map(j => [j.id, j.title]));
  const now = new Date();
  const breaches: SlaBreachItem[] = [];

  for (const c of filtered) {
    const stage = stageMap.get(c.stage_id);
    if (!stage?.target_hours) continue;
    const lastUpdate = c.date_last_stage_update
      ? new Date(c.date_last_stage_update)
      : new Date(c.date_applied);
    const hoursInStage = (now.getTime() - lastUpdate.getTime()) / 3_600_000;
    if (hoursInStage <= stage.target_hours) continue;

    breaches.push({
      candidate_id: c.id,
      candidate_name: `${c.first_name} ${c.last_name}`,
      stage_name: stage.name,
      stage_color: stage.color,
      job_title: jobMap.get(c.job_id) ?? "Unknown",
      recruiter_name: c.recruiter_id ? (recruiterMap.get(c.recruiter_id) ?? "Unassigned") : "Unassigned",
      hours_in_stage: Math.round(hoursInStage),
      target_hours: stage.target_hours,
      hours_overdue: Math.round(hoursInStage - stage.target_hours),
    });
  }

  return breaches.sort((a, b) => b.hours_overdue - a.hours_overdue);
}

// ---------- Stale Candidates (pipeline health alerts) ----------

/**
 * Candidates that are not just past SLA but *deeply* stalled — the kind
 * a recruiter should chase today. Complements computeSlaBreaches by filtering
 * to a more severe tier:
 *   stale      — 2× target_hours past (or >14 days if stage has no SLA)
 *   abandoned  — 4× target_hours past (or >30 days if stage has no SLA)
 */
export function computeStaleCandidates(
  candidates: CandidateRow[],
  stages: StageRow[],
  recruiters: RecruiterRow[],
  jobs: JobRow[],
  filters: DashboardFilters
): StaleCandidateItem[] {
  const filtered = filterCandidates(candidates, filters).filter(c => c.status === "Active");
  const stageMap = new Map(stages.map(s => [s.id, s]));
  const recruiterMap = new Map(recruiters.map(r => [r.id, r.name]));
  const jobMap = new Map(jobs.map(j => [j.id, j.title]));
  const now = new Date();
  const items: StaleCandidateItem[] = [];

  for (const c of filtered) {
    const stage = stageMap.get(c.stage_id);
    if (!stage || stage.is_hired || stage.is_rejected) continue;  // terminal stages don't count
    const lastUpdate = c.date_last_stage_update
      ? new Date(c.date_last_stage_update)
      : new Date(c.date_applied);
    const hoursInStage = (now.getTime() - lastUpdate.getTime()) / 3_600_000;
    const daysInStage  = Math.round(hoursInStage / 24);

    let severity: "stale" | "abandoned" | null = null;
    if (stage.target_hours) {
      if (hoursInStage > stage.target_hours * 4) severity = "abandoned";
      else if (hoursInStage > stage.target_hours * 2) severity = "stale";
    } else {
      // No SLA configured → use day-based heuristic
      if (daysInStage > 30) severity = "abandoned";
      else if (daysInStage > 14) severity = "stale";
    }
    if (!severity) continue;

    items.push({
      candidate_id: c.id,
      candidate_name: `${c.first_name} ${c.last_name}`,
      stage_name: stage.name,
      stage_color: stage.color,
      job_title: jobMap.get(c.job_id) ?? "Unknown",
      recruiter_name: c.recruiter_id ? (recruiterMap.get(c.recruiter_id) ?? "Unassigned") : "Unassigned",
      days_in_stage: daysInStage,
      severity,
    });
  }

  // Abandoned first, then stale; within each severity, longest-stalled first
  return items.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "abandoned" ? -1 : 1;
    return b.days_in_stage - a.days_in_stage;
  });
}

// ---------- Cohort Waterfall ----------

/**
 * xDR waterfall benchmarks (step-to-step conversion rates).
 *
 * Derived from TPG Recruiting Weekly Update, "February 2026" tab, row 23
 * ("US xDR AVERAGES", Inbound motion): per-recruiter-per-month volumes
 * 100 → 50 → 40 → 30 → 24 → 19 → 17 → 16. These are the canonical goals
 * Janice compares actuals against in executive briefings.
 *
 * Shape assumes 7 transitions between 8 non-rejected stages:
 *   Applied → Reviewed → Contacted → Pre-screen → Roleplay/CG
 *   → Final Interview → Offer → Hired
 *
 * If an admin customizes stages such that there are not exactly 8 enabled
 * non-rejected stages, the waterfall still renders counts but sets
 * `benchmarksValid: false` so the UI can hide/disclaim the bench column.
 */
export const XDR_BENCH: readonly number[] = [50, 80, 75, 80, 79, 89, 94];

/**
 * Compute the cohort waterfall.
 *
 * Cohort membership: candidates whose `date_applied` is within
 * [filters.startDate, filters.endDate] AND who pass all scope filters.
 *
 * Per-candidate "max stage reached" = max sequence across
 *   (every `stage_to_id` in that candidate's history + their current
 *    `stage_id`), excluding any rejected stage.
 * Floor at first-stage.sequence so a cohort member is always present in
 * the first bucket (they applied; logHistory always records the initial
 * placement).
 *
 * Invariants:
 *   - rows[0].count === cohortSize (first bucket = everyone)
 *   - rows are in ascending `sequence`
 *   - rejected stages are never rendered
 *   - step_pct is null on the first row, computed as count/prev*100 elsewhere
 */
/** Normalize an ID-filter value so the caller can pass strings (as Alpine
 *  x-model does) or numbers. Sentinels pass through. Empty / null → null. */
function normIdFilter<T extends string>(
  v: number | T | null | undefined | string,
  sentinels: readonly T[] = [] as any,
): number | T | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" && (sentinels as readonly string[]).indexOf(v) !== -1) {
    return v as T;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function computeWaterfall(
  candidates: CandidateRow[],
  history: HistoryRow[],
  stages: StageRow[],
  jobs: JobRow[],
  filters: WaterfallFilters,
  benchmarks: WaterfallBenchmarkRow[] = [],
): WaterfallResult {
  const start = dateOnly(filters.startDate);
  const end = dateOnly(filters.endDate);

  // Multi-axis filter normalization (see DashboardFilters.normalization).
  // Empty array on an axis = "no filter"; non-empty = "match any".
  const jobAxis = normalizeAxis(filters.jobIds,       filters.jobId,       ["__unassigned__"] as const);
  const recAxis = normalizeAxis(filters.recruiterIds, filters.recruiterId, ["__unassigned__", "__assigned__"] as const);
  const srcAxis = normalizeAxis(filters.sourceIds,    filters.sourceId,    ["__unassigned__"] as const);
  const regAxis = normalizeAxis(filters.regionIds,    filters.regionId,    ["__unassigned__"] as const);
  const motAxis = normalizeAxis(filters.motions,      filters.motion,      ["__unassigned__", "Inbound", "Outbound"] as const);

  // Per-job benchmark overrides require a single specific job selection —
  // override rows apply to ONE job and mixing jobs makes the cohort no longer
  // attributable to any single override row. So the override only kicks in
  // when exactly one concrete job id is selected.
  const selectedJobId: number | null =
    jobAxis.length === 1 && typeof jobAxis[0] === "number" ? (jobAxis[0] as number) : null;

  // Enabled, non-rejected stages in order (the ones we render).
  const orderedStages = stages
    .filter(s => s.is_enabled && !s.is_rejected)
    .sort((a, b) => a.sequence - b.sequence);

  // Every stage (including rejected/disabled) — needed to look up sequence
  // by id when walking a candidate's history.
  const stageSeqById = new Map<number, number>();
  const rejectedStageIds = new Set<number>();
  for (const s of stages) {
    stageSeqById.set(s.id, s.sequence);
    if (s.is_rejected) rejectedStageIds.add(s.id);
  }

  const firstStageSeq = orderedStages.length > 0 ? orderedStages[0].sequence : 0;

  // Legacy "xDR-only" clients (older deployments still sending xdrOnly:true
  // or roleTier:"xdr") translate to a tier-based allowlist.  New UI uses
  // the explicit jobId filter and never sets these.
  let legacyTierJobIds: Set<number> | null = null;
  const legacyTier: string | null = filters.roleTier || (filters.xdrOnly ? "xdr" : null);
  if (legacyTier) {
    legacyTierJobIds = new Set<number>();
    for (const j of jobs) {
      if (j.role_tier === legacyTier) { legacyTierJobIds.add(j.id); continue; }
      if (legacyTier === "xdr") {
        const titleNorm = (j.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        if (titleNorm.indexOf("xdr") !== -1) legacyTierJobIds.add(j.id);
      }
    }
  }

  // Build the cohort.
  //
  // Cohort semantics: "candidates who entered this funnel during [start, end]
  // and match the scope filters." The date_applied column is the canonical
  // entry-time signal.
  //
  // Edge case: some candidates (legacy imports, manual Sheet edits) have
  // an EMPTY date_applied. In All-Time mode (no start/end set) we include
  // them anyway — excluding them made the Waterfall totals mysteriously
  // smaller than the Pipeline Funnel's, because Pipeline doesn't require
  // date_applied. With an explicit window set we must exclude them
  // (can't place them in the window).
  const haveWindow = !!(start || end);
  let excludedNoDate = 0;
  const cohort: CandidateRow[] = [];
  for (const c of candidates) {
    const applied = dateOnly(c.date_applied);
    if (!applied) {
      if (haveWindow) { excludedNoDate++; continue; }
      // All-Time: let them through so totals match Pipeline Funnel.
    } else {
      if (start && applied < start) continue;
      if (end && applied > end) continue;
    }

    if (!matchIdAxis(jobAxis, c.job_id)) continue;
    if (!matchRecruiterAxis(recAxis, c.recruiter_id)) continue;
    if (!matchIdAxis(srcAxis, c.source_id)) continue;
    if (!matchIdAxis(regAxis, c.region_id)) continue;
    if (!matchMotionAxis(motAxis, c.motion)) continue;
    if (legacyTierJobIds !== null && !legacyTierJobIds.has(c.job_id)) continue;

    cohort.push(c);
  }

  const cohortIds = new Set<number>(cohort.map(c => c.id));

  // Index history by candidate_id — only for candidates in the cohort,
  // to keep the working set small.
  const historyByCand = new Map<number, number[]>();   // candidate_id → stage_to_ids
  for (const h of history) {
    if (!cohortIds.has(h.candidate_id)) continue;
    let arr = historyByCand.get(h.candidate_id);
    if (!arr) {
      arr = [];
      historyByCand.set(h.candidate_id, arr);
    }
    arr.push(h.stage_to_id);
  }

  // For each candidate, compute max non-rejected sequence reached.
  const maxSeqByCand = new Map<number, number>();
  for (const c of cohort) {
    let maxSeq = 0;
    const histStages = historyByCand.get(c.id) || [];
    for (const sid of histStages) {
      if (rejectedStageIds.has(sid)) continue;
      const seq = stageSeqById.get(sid);
      if (seq !== undefined && seq > maxSeq) maxSeq = seq;
    }
    // Include current stage if it's not a rejected one.
    if (!rejectedStageIds.has(c.stage_id)) {
      const curSeq = stageSeqById.get(c.stage_id);
      if (curSeq !== undefined && curSeq > maxSeq) maxSeq = curSeq;
    }
    // Defensive floor: every cohort member has, at minimum, entered the
    // first stage (createCandidate logs the initial placement). If history
    // is broken or they were reject-on-arrival, still count them at Applied
    // so the top bar reads "everyone who came in".
    if (maxSeq < firstStageSeq) maxSeq = firstStageSeq;
    maxSeqByCand.set(c.id, maxSeq);
  }

  // Index benchmarks by (stage_id, job_id). job_id === 0 is the default
  // row that applies to every job. A positive job_id is an override that
  // wins only when the waterfall is filtered to that single job.
  const benchByKey = new Map<string, number>();
  for (const b of benchmarks) {
    benchByKey.set(b.stage_id + ":" + b.job_id, b.benchmark_pct);
  }

  // Benchmarks render when we have at least one resolvable target from
  // any tier of fallback: a default row, a legacy stage.benchmark_pct,
  // or the 8-stage XDR_BENCH positional fallback.
  const hasAnyDefault  = benchmarks.some(b => b.job_id === 0);
  const hasLegacyStage = orderedStages.some(s => s.benchmark_pct != null);
  const benchmarksValid = hasAnyDefault || hasLegacyStage || orderedStages.length === 8;
  const rows: WaterfallItem[] = orderedStages.map((s, i) => {
    const ids: number[] = [];
    for (const c of cohort) {
      if ((maxSeqByCand.get(c.id) || 0) >= s.sequence) ids.push(c.id);
    }
    return {
      stage_id:    s.id,
      stage_name:  s.name,
      stage_color: s.color,
      sequence:    s.sequence,
      count:       ids.length,
      candidate_ids: ids,
      step_pct:    null,
      bench_pct:   null,
      bench_above: null,
    };
  });

  // Fill step_pct + benchmark lookup. Priority order:
  //   1. Per-job override (stage_id, selectedJobId) — only when the waterfall
  //      is filtered to a single specific job AND an override row exists
  //   2. Default row (stage_id, 0) from the benchmarks sheet
  //   3. Legacy stage.benchmark_pct (from the first schema pass)
  //   4. XDR_BENCH positional fallback (out-of-box defaults for 8-stage setup)
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].count;
    const curr = rows[i].count;
    rows[i].step_pct = prev > 0 ? Math.round((curr / prev) * 100) : null;

    const stage = orderedStages[i];
    let bench: number | null = null;

    if (selectedJobId != null) {
      const overrideKey = stage.id + ":" + selectedJobId;
      if (benchByKey.has(overrideKey)) bench = benchByKey.get(overrideKey) as number;
    }
    if (bench == null && benchByKey.has(stage.id + ":0")) {
      bench = benchByKey.get(stage.id + ":0") as number;
    }
    if (bench == null && stage.benchmark_pct != null) {
      bench = stage.benchmark_pct;
    }
    if (bench == null && orderedStages.length === 8 && (i - 1) < XDR_BENCH.length) {
      bench = XDR_BENCH[i - 1];
    }

    if (bench != null) {
      rows[i].bench_pct = bench;
      rows[i].bench_above =
        rows[i].step_pct !== null ? (rows[i].step_pct! >= bench) : null;
    }
  }

  return {
    cohortSize: cohort.length,
    rows,
    window: { startDate: start, endDate: end },
    excludedNoDate,
    benchmarksValid,
  };
}
