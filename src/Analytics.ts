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
  DashboardFilters,
  KpiData,
  PipelineSnapshotItem,
  FunnelItem,
  RecruiterPerformanceItem,
  SourceEffectivenessItem,
  MonthlyTrendItem,
  StageVelocityItem,
  SlaBreachItem,
  StaleCandidateItem,
  WaterfallItem,
  WaterfallResult,
  WaterfallFilters,
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

export function filterCandidates(
  candidates: CandidateRow[],
  filters: DashboardFilters
): CandidateRow[] {
  const start = dateOnly(filters.startDate);
  const end = dateOnly(filters.endDate);

  return candidates.filter(c => {
    if (filters.jobId === "__unassigned__") {
      if (c.job_id != null && c.job_id !== 0) return false;
    } else if (filters.jobId && c.job_id !== filters.jobId) {
      return false;
    }
    if (filters.recruiterId === "__unassigned__") {
      if (c.recruiter_id != null && c.recruiter_id !== 0) return false;
    } else if (filters.recruiterId === "__assigned__") {
      if (c.recruiter_id == null || c.recruiter_id === 0) return false;
    } else if (filters.recruiterId && c.recruiter_id !== filters.recruiterId) {
      return false;
    }
    if (filters.sourceId === "__unassigned__") {
      if (c.source_id != null && c.source_id !== 0) return false;
    } else if (filters.sourceId && c.source_id !== filters.sourceId) {
      return false;
    }
    if (filters.regionId === "__unassigned__") {
      if (c.region_id != null && c.region_id !== 0) return false;
    } else if (filters.regionId && c.region_id !== filters.regionId) {
      return false;
    }
    if (filters.motion === "__unassigned__") {
      if (c.motion === "Inbound" || c.motion === "Outbound") return false;
    } else if (filters.motion && c.motion !== filters.motion) {
      return false;
    }
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
  const start = filters.startDate ? new Date(filters.startDate).getTime() : 0;
  const end = filters.endDate ? new Date(filters.endDate).getTime() : Infinity;

  // Count transitions INTO each stage (from a different stage)
  const entryCounts = new Map<number, Set<number>>(); // stageId → Set<candidateId>
  for (const h of history) {
    const ts = new Date(h.timestamp).getTime();
    if (ts < start || ts > end) continue;
    if (filters.jobId && h.job_id !== filters.jobId) continue;
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
  const now = new Date();
  const result: MonthlyTrendItem[] = [];

  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleString("default", { month: "short", year: "2-digit" });
    const monthStart = d.getTime();
    const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59).getTime();

    const hires = candidates.filter(c => {
      if (c.status !== "Hired" || !c.date_last_stage_update) return false;
      const t = new Date(c.date_last_stage_update).getTime();
      return t >= monthStart && t <= monthEnd;
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
  const start = filters.startDate ? new Date(filters.startDate).getTime() : 0;
  const end = filters.endDate ? new Date(filters.endDate).getTime() : Infinity;

  // For each stage, compute average days spent based on history transitions
  const stageDays = new Map<number, number[]>();

  for (const h of history) {
    const ts = new Date(h.timestamp).getTime();
    if (ts < start || ts > end) continue;
    if (filters.jobId && h.job_id !== filters.jobId) continue;
    if (h.days_in_previous_stage > 0 && h.stage_from_id) {
      if (!stageDays.has(h.stage_from_id)) stageDays.set(h.stage_from_id, []);
      stageDays.get(h.stage_from_id)!.push(h.days_in_previous_stage);
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
      };
    });
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
export function computeWaterfall(
  candidates: CandidateRow[],
  history: HistoryRow[],
  stages: StageRow[],
  jobs: JobRow[],
  filters: WaterfallFilters,
): WaterfallResult {
  const start = dateOnly(filters.startDate);
  const end = dateOnly(filters.endDate);

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

  // xDR job allowlist (title contains "xdr" case-insensitive).
  let xdrJobIds: Set<number> | null = null;
  if (filters.xdrOnly) {
    xdrJobIds = new Set<number>();
    for (const j of jobs) {
      if ((j.title || "").toLowerCase().indexOf("xdr") !== -1) {
        xdrJobIds.add(j.id);
      }
    }
  }

  // Build the cohort.
  const cohort: CandidateRow[] = [];
  for (const c of candidates) {
    const applied = dateOnly(c.date_applied);
    if (!applied) continue;
    if (start && applied < start) continue;
    if (end && applied > end) continue;

    // Scope filters (mirror DashboardFilters semantics, including sentinels).
    // Truthy check on the filter value handles "" / null / 0 as "no filter".
    if (filters.jobId === "__unassigned__") {
      if (c.job_id != null && c.job_id !== 0) continue;
    } else if (filters.jobId && c.job_id !== filters.jobId) {
      continue;
    }
    if (filters.recruiterId === "__unassigned__") {
      if (c.recruiter_id != null && c.recruiter_id !== 0) continue;
    } else if (filters.recruiterId === "__assigned__") {
      if (c.recruiter_id == null || c.recruiter_id === 0) continue;
    } else if (filters.recruiterId && c.recruiter_id !== filters.recruiterId) {
      continue;
    }
    if (filters.sourceId === "__unassigned__") {
      if (c.source_id != null && c.source_id !== 0) continue;
    } else if (filters.sourceId && c.source_id !== filters.sourceId) {
      continue;
    }
    if (filters.regionId === "__unassigned__") {
      if (c.region_id != null && c.region_id !== 0) continue;
    } else if (filters.regionId && c.region_id !== filters.regionId) {
      continue;
    }
    if (filters.motion === "__unassigned__") {
      if (c.motion === "Inbound" || c.motion === "Outbound") continue;
    } else if (filters.motion && c.motion !== filters.motion) {
      continue;
    }
    if (xdrJobIds !== null && !xdrJobIds.has(c.job_id)) continue;

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

  // Bucket candidates into stages.
  const benchmarksValid = orderedStages.length === 8;
  const rows: WaterfallItem[] = orderedStages.map((s, i) => {
    let count = 0;
    for (const c of cohort) {
      if ((maxSeqByCand.get(c.id) || 0) >= s.sequence) count++;
    }
    return {
      stage_id:    s.id,
      stage_name:  s.name,
      stage_color: s.color,
      sequence:    s.sequence,
      count,
      step_pct:    null,
      bench_pct:   null,
      bench_above: null,
    };
  });

  // Fill step_pct + bench comparisons.
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].count;
    const curr = rows[i].count;
    rows[i].step_pct = prev > 0 ? Math.round((curr / prev) * 100) : null;

    if (benchmarksValid && (i - 1) < XDR_BENCH.length) {
      const bench = XDR_BENCH[i - 1];
      rows[i].bench_pct = bench;
      rows[i].bench_above =
        rows[i].step_pct !== null ? (rows[i].step_pct! >= bench) : null;
    }
  }

  return {
    cohortSize: cohort.length,
    rows,
    window: { startDate: start, endDate: end },
    benchmarksValid,
  };
}
