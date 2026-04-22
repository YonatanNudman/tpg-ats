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
} from "./types";

// ---------- Filters ----------

export function filterCandidates(
  candidates: CandidateRow[],
  filters: DashboardFilters
): CandidateRow[] {
  const start = filters.startDate ? new Date(filters.startDate).getTime() : 0;
  const end = filters.endDate ? new Date(filters.endDate).getTime() : Infinity;

  return candidates.filter(c => {
    if (filters.jobId && c.job_id !== filters.jobId) return false;
    if (filters.recruiterId && c.recruiter_id !== filters.recruiterId) return false;
    if (filters.sourceId && c.source_id !== filters.sourceId) return false;
    if (filters.regionId && c.region_id !== filters.regionId) return false;
    if (filters.motion && c.motion !== filters.motion) return false;
    if (filters.status && c.status !== filters.status) return false;
    const applied = c.date_applied ? new Date(c.date_applied).getTime() : 0;
    if (applied < start || applied > end) return false;
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

  // ── Previous-period comparison for trend arrows ─────────────────
  // If the user's period is N days long, run the same KPI calc over
  // the N days immediately before startDate. Skip if the window is
  // longer than 2 years or invalid (returns undefined → no arrows shown).
  let prev: KpiData["prev"] | undefined = undefined;
  try {
    const startMs = new Date(filtersNoStatus.startDate).getTime();
    const endMs   = new Date(filtersNoStatus.endDate).getTime();
    const spanMs  = endMs - startMs;
    if (spanMs > 0 && spanMs < 365 * 86_400_000 * 2) {
      const prevEndMs   = startMs - 86_400_000;
      const prevStartMs = prevEndMs - spanMs;
      const prevFilters: DashboardFilters = {
        ...filtersNoStatus,
        startDate: new Date(prevStartMs).toISOString().split("T")[0],
        endDate:   new Date(prevEndMs).toISOString().split("T")[0],
      };
      const prevInScope = filterCandidates(candidates, prevFilters);
      const prevHires = prevInScope.filter(c => c.status === "Hired" && c.date_applied && c.date_last_stage_update);
      const prevAvgDays = prevHires.length > 0
        ? prevHires.reduce((s, c) =>
            s + (new Date(c.date_last_stage_update).getTime() - new Date(c.date_applied).getTime()) / 86_400_000, 0
          ) / prevHires.length
        : 0;
      prev = {
        activeCandidates: prevInScope.filter(c => c.status === "Active").length,
        hiresThisPeriod:  prevHires.length,
        avgDaysToHire:    Math.round(prevAvgDays * 10) / 10,
      };
    }
  } catch { /* swallow — previous-period is nice-to-have */ }

  return {
    activeCandidates,
    openPositions,
    hiresThisPeriod,
    slaBreaches,
    avgDaysToHire: Math.round(avgDaysToHire * 10) / 10,
    offerAcceptanceRate: Math.round(offerAcceptanceRate * 10) / 10,
    expiredPostings,
    expiringPostings,
    prev,
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

export function computeRecruiterPerformance(
  candidates: CandidateRow[],
  recruiters: RecruiterRow[],
  filters: DashboardFilters
): RecruiterPerformanceItem[] {
  const filtered = filterCandidates(candidates, filters);

  return recruiters
    .filter(r => r.is_active)
    .map(r => {
      const mine = filtered.filter(c => c.recruiter_id === r.id);
      const active = mine.filter(c => c.status === "Active").length;
      const hires = mine.filter(c => c.status === "Hired");
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
        hires: hires.length,
        rejections,
        avg_days_to_hire: Math.round(avgDaysToHire * 10) / 10,
      };
    })
    .filter(r => r.total_candidates > 0)
    .sort((a, b) => b.hires - a.hires || b.total_candidates - a.total_candidates);
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
