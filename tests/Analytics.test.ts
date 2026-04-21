import {
  filterCandidates,
  computeKpis,
  computePipelineSnapshot,
  computeFunnelConversion,
  computeRecruiterPerformance,
  computeSourceEffectiveness,
  computeTimeToHireTrend,
  computeStageVelocity,
  computeSlaBreaches,
} from "../src/Analytics";
import type {
  CandidateRow,
  JobRow,
  StageRow,
  SourceRow,
  RecruiterRow,
  HistoryRow,
  DashboardFilters,
} from "../src/types";
import { DEFAULT_STAGES, DEFAULT_SOURCES } from "../src/SheetDB";

// ---------- Test data factories ----------

function makeCandidate(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: 1,
    first_name: "Jane",
    last_name: "Doe",
    email: "jane@test.com",
    phone: "",
    job_id: 1,
    stage_id: 1,
    recruiter_id: null,
    source_id: null,
    region_id: null,
    motion: "Inbound",
    status: "Active",
    rating: 0,
    linkedin_url: "",
    resume_url: "",
    notes: "",
    refuse_reason_id: null,
    kanban_state: "Normal",
    post_hire_status: "",
    date_applied: "2026-01-01",
    date_last_stage_update: "2026-01-01",
    created_by: "test@test.com",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 1,
    title: "Sales Rep",
    department: "Sales",
    location: "Remote",
    region_id: null,
    status: "Open",
    head_count: 1,
    recruiter_id: null,
    salary_range: "",
    posted_date: "2026-01-01",
    closes_date: "",
    posting_expires: "",
    notes: "",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRecruiter(id: number, name: string): RecruiterRow {
  return { id, name, email: `${name.toLowerCase()}@test.com`, is_active: true };
}

const wideFilters: DashboardFilters = {
  startDate: "2020-01-01",
  endDate: "2030-12-31",
};

// ============================================================
// filterCandidates
// ============================================================

describe("filterCandidates", () => {
  it("returns all when filters are empty", () => {
    const candidates = [makeCandidate({ id: 1 }), makeCandidate({ id: 2 })];
    expect(filterCandidates(candidates, wideFilters)).toHaveLength(2);
  });

  it("filters by jobId", () => {
    const candidates = [makeCandidate({ id: 1, job_id: 1 }), makeCandidate({ id: 2, job_id: 2 })];
    const result = filterCandidates(candidates, { ...wideFilters, jobId: 1 });
    expect(result).toHaveLength(1);
    expect(result[0].job_id).toBe(1);
  });

  it("filters by recruiterId", () => {
    const candidates = [
      makeCandidate({ id: 1, recruiter_id: 10 }),
      makeCandidate({ id: 2, recruiter_id: 20 }),
    ];
    const result = filterCandidates(candidates, { ...wideFilters, recruiterId: 10 });
    expect(result).toHaveLength(1);
    expect(result[0].recruiter_id).toBe(10);
  });

  it("filters by motion", () => {
    const candidates = [
      makeCandidate({ id: 1, motion: "Inbound" }),
      makeCandidate({ id: 2, motion: "Outbound" }),
    ];
    expect(filterCandidates(candidates, { ...wideFilters, motion: "Outbound" })).toHaveLength(1);
  });

  it("filters by date range", () => {
    const candidates = [
      makeCandidate({ id: 1, date_applied: "2026-01-15" }),
      makeCandidate({ id: 2, date_applied: "2026-03-01" }),
    ];
    const result = filterCandidates(candidates, {
      startDate: "2026-01-01",
      endDate: "2026-02-01",
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it("filters by sourceId", () => {
    const candidates = [
      makeCandidate({ id: 1, source_id: 1 }),
      makeCandidate({ id: 2, source_id: 2 }),
    ];
    expect(filterCandidates(candidates, { ...wideFilters, sourceId: 1 })).toHaveLength(1);
  });

  it("filters by regionId", () => {
    const candidates = [
      makeCandidate({ id: 1, region_id: 1 }),
      makeCandidate({ id: 2, region_id: 2 }),
    ];
    expect(filterCandidates(candidates, { ...wideFilters, regionId: 2 })).toHaveLength(1);
  });

  it("composes multiple filters (AND logic)", () => {
    const candidates = [
      makeCandidate({ id: 1, job_id: 1, motion: "Inbound" }),
      makeCandidate({ id: 2, job_id: 1, motion: "Outbound" }),
      makeCandidate({ id: 3, job_id: 2, motion: "Inbound" }),
    ];
    const result = filterCandidates(candidates, { ...wideFilters, jobId: 1, motion: "Inbound" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });
});

// ============================================================
// computeKpis
// ============================================================

describe("computeKpis", () => {
  it("counts active candidates correctly", () => {
    const candidates = [
      makeCandidate({ id: 1, status: "Active" }),
      makeCandidate({ id: 2, status: "Active" }),
      makeCandidate({ id: 3, status: "Hired" }),
      makeCandidate({ id: 4, status: "Rejected" }),
    ];
    const kpis = computeKpis(candidates, [], DEFAULT_STAGES, wideFilters);
    expect(kpis.activeCandidates).toBe(2);
  });

  it("counts hires in period", () => {
    const candidates = [
      makeCandidate({ id: 1, status: "Hired" }),
      makeCandidate({ id: 2, status: "Active" }),
    ];
    const kpis = computeKpis(candidates, [], DEFAULT_STAGES, wideFilters);
    expect(kpis.hiresThisPeriod).toBe(1);
  });

  it("counts open positions from jobs", () => {
    const jobs = [
      makeJob({ id: 1, status: "Open" }),
      makeJob({ id: 2, status: "Open" }),
      makeJob({ id: 3, status: "Closed" }),
    ];
    const kpis = computeKpis([], jobs, DEFAULT_STAGES, wideFilters);
    expect(kpis.openPositions).toBe(2);
  });

  it("counts SLA breaches for active candidates over target", () => {
    const stages: StageRow[] = [
      { id: 1, name: "Applied",  sequence: 100, color: "#000", is_hired: false, is_rejected: false, is_offer: false, target_hours: 1,    is_enabled: true },
      { id: 2, name: "Reviewed", sequence: 200, color: "#000", is_hired: false, is_rejected: false, is_offer: false, target_hours: null, is_enabled: true },
    ];
    // Candidate 1: 3 days in the SLA stage (72h > 1h target) → breach
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString().split("T")[0];
    // Candidate 2: in a stage with no SLA target → never a breach regardless of time
    const candidates = [
      makeCandidate({ id: 1, status: "Active", stage_id: 1, date_last_stage_update: threeDaysAgo }),
      makeCandidate({ id: 2, status: "Active", stage_id: 2, date_last_stage_update: threeDaysAgo }),
    ];
    const kpis = computeKpis(candidates, [], stages, wideFilters);
    expect(kpis.slaBreaches).toBe(1);
  });

  it("detects expired job postings", () => {
    const jobs = [
      makeJob({ id: 1, status: "Open", posting_expires: "2020-01-01" }), // expired
      makeJob({ id: 2, status: "Open", posting_expires: "2099-01-01" }), // not expired
      makeJob({ id: 3, status: "Open", posting_expires: "" }),           // no expiry
    ];
    const kpis = computeKpis([], jobs, DEFAULT_STAGES, wideFilters);
    expect(kpis.expiredPostings).toBe(1);
  });
});

// ============================================================
// computePipelineSnapshot
// ============================================================

describe("computePipelineSnapshot", () => {
  it("returns counts per active stage", () => {
    const stages: StageRow[] = [
      { id: 1, name: "Applied", sequence: 100, color: "#000", is_hired: false, is_rejected: false, is_offer: false, target_hours: null, is_enabled: true },
      { id: 2, name: "Reviewed", sequence: 200, color: "#111", is_hired: false, is_rejected: false, is_offer: false, target_hours: null, is_enabled: true },
    ];
    const candidates = [
      makeCandidate({ id: 1, stage_id: 1, status: "Active" }),
      makeCandidate({ id: 2, stage_id: 1, status: "Active" }),
      makeCandidate({ id: 3, stage_id: 2, status: "Active" }),
      makeCandidate({ id: 4, stage_id: 1, status: "Hired" }), // excluded (not Active)
    ];
    const snapshot = computePipelineSnapshot(candidates, stages, wideFilters);
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0].stage_name).toBe("Applied");
    expect(snapshot[0].candidate_count).toBe(2);
    expect(snapshot[1].candidate_count).toBe(1);
  });

  it("excludes disabled stages", () => {
    const stages: StageRow[] = [
      { id: 1, name: "Applied", sequence: 100, color: "#000", is_hired: false, is_rejected: false, is_offer: false, target_hours: null, is_enabled: true },
      { id: 2, name: "Old Stage", sequence: 200, color: "#111", is_hired: false, is_rejected: false, is_offer: false, target_hours: null, is_enabled: false },
    ];
    const snapshot = computePipelineSnapshot([], stages, wideFilters);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].stage_name).toBe("Applied");
  });

  it("excludes rejected stage from snapshot", () => {
    const stages: StageRow[] = [
      { id: 1, name: "Applied", sequence: 100, color: "#000", is_hired: false, is_rejected: false, is_offer: false, target_hours: null, is_enabled: true },
      { id: 9, name: "Rejected", sequence: 900, color: "#f00", is_hired: false, is_rejected: true, is_offer: false, target_hours: null, is_enabled: true },
    ];
    const snapshot = computePipelineSnapshot([], stages, wideFilters);
    expect(snapshot.every(s => !s.stage_name.includes("Rejected"))).toBe(true);
  });
});

// ============================================================
// computeRecruiterPerformance
// ============================================================

describe("computeRecruiterPerformance", () => {
  it("computes per-recruiter totals correctly", () => {
    const recruiters = [makeRecruiter(1, "Alice"), makeRecruiter(2, "Bob")];
    const candidates = [
      makeCandidate({ id: 1, recruiter_id: 1, status: "Active" }),
      makeCandidate({ id: 2, recruiter_id: 1, status: "Hired",  date_applied: "2026-01-01", date_last_stage_update: "2026-01-31" }),
      makeCandidate({ id: 3, recruiter_id: 2, status: "Rejected" }),
      makeCandidate({ id: 4, recruiter_id: 1, status: "Rejected" }),
    ];
    const result = computeRecruiterPerformance(candidates, recruiters, wideFilters);
    const alice = result.find(r => r.recruiter_name === "Alice")!;
    expect(alice.total_candidates).toBe(3);
    expect(alice.hires).toBe(1);
    expect(alice.rejections).toBe(1);
    expect(alice.active_candidates).toBe(1);
    expect(alice.avg_days_to_hire).toBeGreaterThan(0);
  });

  it("excludes recruiters with no candidates", () => {
    const recruiters = [makeRecruiter(1, "Alice"), makeRecruiter(2, "Bob")];
    const candidates = [makeCandidate({ id: 1, recruiter_id: 1, status: "Active" })];
    const result = computeRecruiterPerformance(candidates, recruiters, wideFilters);
    expect(result.some(r => r.recruiter_name === "Bob")).toBe(false);
  });

  it("excludes inactive recruiters", () => {
    const recruiters: RecruiterRow[] = [
      { id: 1, name: "Active", email: "a@t.com", is_active: true },
      { id: 2, name: "Inactive", email: "b@t.com", is_active: false },
    ];
    const candidates = [
      makeCandidate({ id: 1, recruiter_id: 2, status: "Active" }),
    ];
    const result = computeRecruiterPerformance(candidates, recruiters, wideFilters);
    expect(result.every(r => r.recruiter_name !== "Inactive")).toBe(true);
  });
});

// ============================================================
// computeSourceEffectiveness
// ============================================================

describe("computeSourceEffectiveness", () => {
  it("computes hire rate correctly", () => {
    const sources = DEFAULT_SOURCES;
    const candidates = [
      makeCandidate({ id: 1, source_id: 1, status: "Hired" }),
      makeCandidate({ id: 2, source_id: 1, status: "Rejected" }),
      makeCandidate({ id: 3, source_id: 1, status: "Active" }),
      makeCandidate({ id: 4, source_id: 1, status: "Active" }),
    ];
    const result = computeSourceEffectiveness(candidates, sources, wideFilters);
    const linkedin = result.find(s => s.source_name === "LinkedIn")!;
    expect(linkedin.total_candidates).toBe(4);
    expect(linkedin.hired_candidates).toBe(1);
    expect(linkedin.hire_rate).toBe(25);
  });

  it("excludes sources with no candidates", () => {
    const sources = DEFAULT_SOURCES;
    const candidates = [makeCandidate({ id: 1, source_id: 1, status: "Active" })];
    const result = computeSourceEffectiveness(candidates, sources, wideFilters);
    expect(result.every(s => s.total_candidates > 0)).toBe(true);
  });
});

// ============================================================
// computeTimeToHireTrend
// ============================================================

describe("computeTimeToHireTrend", () => {
  it("returns 6 months by default", () => {
    const result = computeTimeToHireTrend([], 6);
    expect(result).toHaveLength(6);
  });

  it("returns 3 months when monthsBack=3", () => {
    expect(computeTimeToHireTrend([], 3)).toHaveLength(3);
  });

  it("computes average days to hire for the correct month", () => {
    // Hire completed exactly 10 days after applying, this month
    const today = new Date();
    const hireDate = new Date(today.getFullYear(), today.getMonth(), 15).toISOString().split("T")[0];
    const applyDate = new Date(today.getFullYear(), today.getMonth(), 5).toISOString().split("T")[0];
    const candidates = [
      makeCandidate({ id: 1, status: "Hired", date_applied: applyDate, date_last_stage_update: hireDate }),
    ];
    const result = computeTimeToHireTrend(candidates, 1);
    expect(result[0].avg_days_to_hire).toBe(10);
  });
});

// ============================================================
// computeStageVelocity
// ============================================================

describe("computeStageVelocity", () => {
  it("averages days per stage from history", () => {
    const stages: StageRow[] = [
      { id: 1, name: "Applied", sequence: 100, color: "#000", is_hired: false, is_rejected: false, is_offer: false, target_hours: null, is_enabled: true },
    ];
    const history: HistoryRow[] = [
      { id: 1, timestamp: "2026-03-10T00:00:00Z", candidate_id: 1, candidate_name: "A", job_id: 1, job_title: "J", stage_from_id: 1, stage_from_name: "Applied", stage_to_id: 2, stage_to_name: "Reviewed", changed_by: "x", days_in_previous_stage: 5 },
      { id: 2, timestamp: "2026-03-11T00:00:00Z", candidate_id: 2, candidate_name: "B", job_id: 1, job_title: "J", stage_from_id: 1, stage_from_name: "Applied", stage_to_id: 2, stage_to_name: "Reviewed", changed_by: "x", days_in_previous_stage: 3 },
    ];
    const result = computeStageVelocity(history, stages, wideFilters);
    expect(result[0].stage_name).toBe("Applied");
    expect(result[0].avg_days_in_stage).toBe(4); // (5+3)/2
    expect(result[0].candidate_count).toBe(2);
  });
});

// ============================================================
// computeSlaBreaches
// ============================================================

describe("computeSlaBreaches", () => {
  it("returns empty when no candidates exceed target", () => {
    const stages: StageRow[] = [
      { id: 1, name: "Applied", sequence: 100, color: "#000", is_hired: false, is_rejected: false, is_offer: false, target_hours: 9999, is_enabled: true },
    ];
    const candidates = [makeCandidate({ status: "Active", stage_id: 1 })];
    const result = computeSlaBreaches(candidates, stages, [], [], wideFilters);
    expect(result).toHaveLength(0);
  });

  it("flags candidates past target hours", () => {
    const stages: StageRow[] = [
      { id: 1, name: "Applied", sequence: 100, color: "#000", is_hired: false, is_rejected: false, is_offer: false, target_hours: 1, is_enabled: true },
    ];
    // 3 days ago → 72h > 1h target
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString().split("T")[0];
    const candidates = [
      makeCandidate({ id: 1, status: "Active", stage_id: 1, date_last_stage_update: threeDaysAgo }),
    ];
    const result = computeSlaBreaches(candidates, stages, [], [makeJob()], wideFilters);
    expect(result).toHaveLength(1);
    expect(result[0].candidate_name).toBe("Jane Doe");
    expect(result[0].hours_overdue).toBeGreaterThan(0);
  });

  it("ignores non-active candidates", () => {
    const stages: StageRow[] = [
      { id: 1, name: "Applied", sequence: 100, color: "#000", is_hired: false, is_rejected: false, is_offer: false, target_hours: 1, is_enabled: true },
    ];
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString().split("T")[0];
    const candidates = [
      makeCandidate({ id: 1, status: "Hired", stage_id: 1, date_last_stage_update: threeDaysAgo }),
      makeCandidate({ id: 2, status: "Rejected", stage_id: 1, date_last_stage_update: threeDaysAgo }),
    ];
    const result = computeSlaBreaches(candidates, stages, [], [], wideFilters);
    expect(result).toHaveLength(0);
  });

  it("sorts by hours_overdue descending", () => {
    const stages: StageRow[] = [
      { id: 1, name: "Applied", sequence: 100, color: "#000", is_hired: false, is_rejected: false, is_offer: false, target_hours: 1, is_enabled: true },
    ];
    const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000).toISOString().split("T")[0];
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString().split("T")[0];
    const candidates = [
      makeCandidate({ id: 1, status: "Active", stage_id: 1, date_last_stage_update: threeDaysAgo }),
      makeCandidate({ id: 2, status: "Active", stage_id: 1, date_last_stage_update: twoWeeksAgo }),
    ];
    const result = computeSlaBreaches(candidates, stages, [], [makeJob()], wideFilters);
    expect(result[0].candidate_id).toBe(2); // more overdue first
  });
});
