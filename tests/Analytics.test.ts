import {
  filterCandidates,
  computeKpis,
  computePipelineSnapshot,
  computeFunnelConversion,
  computeRecruiterPerformance,
  computeSourceEffectiveness,
  computeTimeToHireTrend,
  computeStageVelocity,
  computeRejectionReasons,
  computeSlaBreaches,
  computeWaterfall,
  XDR_BENCH,
} from "../src/Analytics";
import type {
  CandidateRow,
  JobRow,
  StageRow,
  SourceRow,
  RecruiterRow,
  RefuseReasonRow,
  HistoryRow,
  DashboardFilters,
  WaterfallFilters,
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
    filled: 0,
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

  it("filters by unassigned job", () => {
    const candidates = [
      makeCandidate({ id: 1, job_id: 1 }),
      makeCandidate({ id: 2, job_id: null as any }),
    ];
    const result = filterCandidates(candidates, { ...wideFilters, jobId: "__unassigned__" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
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

  it("filters by unassigned source", () => {
    const candidates = [
      makeCandidate({ id: 1, source_id: 1 }),
      makeCandidate({ id: 2, source_id: null }),
    ];
    const result = filterCandidates(candidates, { ...wideFilters, sourceId: "__unassigned__" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
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

  // Regression: a candidate stored as midnight Eastern (parseStr emits
  // "2026-04-22T04:00:00.000Z" because Sheets coerces the cell to a JS
  // Date in the spreadsheet's locale) was being EXCLUDED from a Last-90d
  // filter because timestamp comparison treated 4am UTC as "after" the
  // endDate's midnight UTC. Calendar-date comparison fixes it.
  it("includes candidates whose date_applied has a non-midnight-UTC time component on the endDate boundary", () => {
    const candidates = [
      // Same calendar date as endDate, but stored at midnight Eastern
      // (= 04:00 UTC) which made the old timestamp compare reject it.
      makeCandidate({ id: 1, date_applied: "2026-04-22T04:00:00.000Z" }),
      // Same calendar date, midnight UTC — old code accepted this one.
      makeCandidate({ id: 2, date_applied: "2026-04-22" }),
    ];
    const result = filterCandidates(candidates, {
      ...wideFilters,
      startDate: "2026-01-22",
      endDate:   "2026-04-22",
    });
    expect(result.map(c => c.id).sort()).toEqual([1, 2]);
  });

  it("excludes candidates whose date_applied calendar date is outside the window", () => {
    const candidates = [
      makeCandidate({ id: 1, date_applied: "2026-01-21T23:00:00.000Z" }), // day before
      makeCandidate({ id: 2, date_applied: "2026-04-23T00:00:00.000Z" }), // day after
      makeCandidate({ id: 3, date_applied: "2026-02-15" }),               // in window
    ];
    const result = filterCandidates(candidates, {
      ...wideFilters,
      startDate: "2026-01-22",
      endDate:   "2026-04-22",
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(3);
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

  it("includes active recruiters with no candidates (so the team roster is always visible)", () => {
    // Behavior change: previously hid 0-candidate recruiters. The dashboard
    // now wants the full active-team list visible at all times so an empty
    // queue is its own surfaced signal ("Bob has nothing to work on").
    const recruiters = [makeRecruiter(1, "Alice"), makeRecruiter(2, "Bob")];
    const candidates = [makeCandidate({ id: 1, recruiter_id: 1, status: "Active" })];
    const result = computeRecruiterPerformance(candidates, recruiters, wideFilters);
    const bob = result.find(r => r.recruiter_name === "Bob");
    expect(bob).toBeDefined();
    expect(bob!.total_candidates).toBe(0);
    expect(bob!.queue).toBe(0);
    expect(bob!.hires).toBe(0);
    expect(bob!.hires_in_period).toBe(0);
  });

  it("hires_in_period uses hiresFilters override when provided", () => {
    const recruiters = [makeRecruiter(1, "Alice")];
    // Two hires by Alice: one applied 200d ago, one applied 10d ago
    const ancient = new Date(Date.now() - 200 * 86_400_000).toISOString().split("T")[0];
    const recent  = new Date(Date.now() - 10  * 86_400_000).toISOString().split("T")[0];
    const candidates = [
      makeCandidate({ id: 1, recruiter_id: 1, status: "Hired", date_applied: ancient, date_last_stage_update: ancient }),
      makeCandidate({ id: 2, recruiter_id: 1, status: "Hired", date_applied: recent,  date_last_stage_update: recent }),
    ];
    // Wide primary scope catches both hires
    // Narrow hires scope (last 30 days) catches only the recent one
    const last30: typeof wideFilters = {
      ...wideFilters,
      startDate: new Date(Date.now() - 30 * 86_400_000).toISOString().split("T")[0],
    };
    const result = computeRecruiterPerformance(candidates, recruiters, wideFilters, last30);
    const alice = result.find(r => r.recruiter_name === "Alice")!;
    expect(alice.hires).toBe(2);            // unchanged — uses wide filters
    expect(alice.hires_in_period).toBe(1);  // narrowed by hiresFilters
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

// ============================================================
// computeWaterfall (cohort waterfall for Janice's exec reporting)
// ============================================================

describe("computeWaterfall", () => {
  // Stages mirror the production default: 8 non-rejected + 1 rejected.
  const stages: StageRow[] = [
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

  const jobs: JobRow[] = [
    makeJob({ id: 1, title: "xDR - Bay Area" }),
    makeJob({ id: 2, title: "Account Executive" }),
  ];

  // Every `logHistory` call on candidate creation records a transition
  // from null into the first stage. Tests that rely on this invariant
  // emulate it with a to_stage_id=1 entry.
  function hist(overrides: Partial<HistoryRow>): HistoryRow {
    return {
      id: 0,
      timestamp: "2026-04-05T00:00:00Z",
      candidate_id: 1,
      candidate_name: "",
      job_id: 1,
      job_title: "",
      stage_from_id: null,
      stage_from_name: "",
      stage_to_id: 1,
      stage_to_name: "Applied",
      changed_by: "test",
      days_in_previous_stage: 0,
      ...overrides,
    };
  }

  const aprilWindow: WaterfallFilters = {
    startDate: "2026-04-01",
    endDate:   "2026-04-30",
  };

  it("counts a fresh applicant only at the first stage", () => {
    const candidates = [makeCandidate({ id: 1, stage_id: 1, date_applied: "2026-04-05" })];
    const history   = [hist({ candidate_id: 1, stage_to_id: 1 })];
    const result    = computeWaterfall(candidates, history, stages, jobs, aprilWindow);

    expect(result.cohortSize).toBe(1);
    expect(result.rows).toHaveLength(8);
    expect(result.rows[0].count).toBe(1); // Applied
    expect(result.rows.slice(1).every(r => r.count === 0)).toBe(true);
  });

  it("counts a candidate who progressed to Offer at every stage up to Offer", () => {
    const candidates = [makeCandidate({ id: 1, stage_id: 7, date_applied: "2026-04-05" })];
    // Full path: Applied → Reviewed → Contacted → Pre-screen → Roleplay → Final → Offer
    const history = [
      hist({ candidate_id: 1, stage_to_id: 1 }),
      hist({ candidate_id: 1, stage_to_id: 2 }),
      hist({ candidate_id: 1, stage_to_id: 3 }),
      hist({ candidate_id: 1, stage_to_id: 4 }),
      hist({ candidate_id: 1, stage_to_id: 5 }),
      hist({ candidate_id: 1, stage_to_id: 6 }),
      hist({ candidate_id: 1, stage_to_id: 7 }),
    ];
    const result = computeWaterfall(candidates, history, stages, jobs, aprilWindow);

    // Applied through Offer = 1 each; Hired = 0 (they haven't been hired yet)
    expect(result.rows.map(r => r.count)).toEqual([1, 1, 1, 1, 1, 1, 1, 0]);
  });

  it("counts a rejected-mid-funnel candidate at stages they passed through", () => {
    // Applied Apr 5, pre-screened, then rejected. Current stage = Rejected (id 9).
    const candidates = [makeCandidate({
      id: 1,
      stage_id: 9,
      status: "Rejected",
      date_applied: "2026-04-05",
    })];
    const history = [
      hist({ candidate_id: 1, stage_to_id: 1 }),
      hist({ candidate_id: 1, stage_to_id: 2 }),
      hist({ candidate_id: 1, stage_to_id: 3 }),
      hist({ candidate_id: 1, stage_to_id: 4 }),
      hist({ candidate_id: 1, stage_to_id: 9 }),  // rejected
    ];
    const result = computeWaterfall(candidates, history, stages, jobs, aprilWindow);

    // Applied, Reviewed, Contacted, Pre-screen = 1; Roleplay+ = 0
    expect(result.rows.map(r => r.count)).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  });

  it("excludes candidates whose date_applied is before the window", () => {
    const candidates = [makeCandidate({ id: 1, stage_id: 3, date_applied: "2026-03-20" })];
    const history   = [hist({ candidate_id: 1, stage_to_id: 3 })];
    const result    = computeWaterfall(candidates, history, stages, jobs, aprilWindow);
    expect(result.cohortSize).toBe(0);
  });

  it("excludes candidates whose date_applied is after the window", () => {
    const candidates = [makeCandidate({ id: 1, stage_id: 1, date_applied: "2026-05-03" })];
    const history   = [hist({ candidate_id: 1, stage_to_id: 1 })];
    const result    = computeWaterfall(candidates, history, stages, jobs, aprilWindow);
    expect(result.cohortSize).toBe(0);
  });

  it("roleTier='xdr' restricts cohort to jobs tagged xdr or with 'xdr' in title", () => {
    const candidates = [
      makeCandidate({ id: 1, stage_id: 1, job_id: 1, date_applied: "2026-04-05" }), // xDR
      makeCandidate({ id: 2, stage_id: 1, job_id: 2, date_applied: "2026-04-05" }), // AE
    ];
    const history = [
      hist({ candidate_id: 1, stage_to_id: 1 }),
      hist({ candidate_id: 2, stage_to_id: 1 }),
    ];
    const result = computeWaterfall(candidates, history, stages, jobs, { ...aprilWindow, roleTier: "xdr" });
    expect(result.cohortSize).toBe(1);
    expect(result.rows[0].count).toBe(1);
  });

  it("respects __unassigned__ jobId sentinel", () => {
    const candidates = [
      makeCandidate({ id: 1, stage_id: 1, job_id: 1, date_applied: "2026-04-05" }),
      makeCandidate({ id: 2, stage_id: 1, job_id: 0 as any, date_applied: "2026-04-05" }),
    ];
    const history = [
      hist({ candidate_id: 1, stage_to_id: 1 }),
      hist({ candidate_id: 2, stage_to_id: 1 }),
    ];
    const result = computeWaterfall(candidates, history, stages, jobs, {
      ...aprilWindow,
      jobId: "__unassigned__",
    });
    expect(result.cohortSize).toBe(1);
  });

  it("returns an empty waterfall with cohortSize 0 gracefully", () => {
    const result = computeWaterfall([], [], stages, jobs, aprilWindow);
    expect(result.cohortSize).toBe(0);
    expect(result.rows).toHaveLength(8);
    expect(result.rows.every(r => r.count === 0)).toBe(true);
    expect(result.rows[0].step_pct).toBeNull();
  });

  it("computes step_pct as round(count/prev*100) and null on the first row", () => {
    // 10 applied → 5 reviewed → 4 contacted → rest zero
    const candidates = [
      ...Array.from({ length: 10 }, (_, i) =>
        makeCandidate({ id: i + 1, stage_id: 1, date_applied: "2026-04-05" })),
    ];
    // First 5 reached Reviewed, of which 4 reached Contacted
    const history: HistoryRow[] = [];
    for (let i = 1; i <= 10; i++) history.push(hist({ candidate_id: i, stage_to_id: 1 }));
    for (let i = 1; i <= 5; i++)  history.push(hist({ candidate_id: i, stage_to_id: 2 }));
    for (let i = 1; i <= 4; i++)  history.push(hist({ candidate_id: i, stage_to_id: 3 }));
    // Move the ones that reached Reviewed/Contacted to reflect their current stage
    for (let i = 1; i <= 5; i++) candidates[i - 1].stage_id = i <= 4 ? 3 : 2;

    const result = computeWaterfall(candidates, history, stages, jobs, aprilWindow);

    expect(result.cohortSize).toBe(10);
    expect(result.rows[0].count).toBe(10);
    expect(result.rows[0].step_pct).toBeNull();
    expect(result.rows[1].count).toBe(5);
    expect(result.rows[1].step_pct).toBe(50);   // 5/10
    expect(result.rows[2].count).toBe(4);
    expect(result.rows[2].step_pct).toBe(80);   // 4/5
  });

  it("marks bench_above true when step_pct meets or beats XDR benchmark, false when it falls short", () => {
    // Contrive a cohort whose Reviewed step = 60% (> 50% bench = true)
    // and Contacted step = 50% (< 80% bench = false).
    //   Applied:  10 → Reviewed: 6 → Contacted: 3
    const candidates: CandidateRow[] = [];
    const history: HistoryRow[] = [];
    for (let i = 1; i <= 10; i++) {
      candidates.push(makeCandidate({ id: i, stage_id: 1, date_applied: "2026-04-05" }));
      history.push(hist({ candidate_id: i, stage_to_id: 1 }));
    }
    for (let i = 1; i <= 6; i++) {
      candidates[i - 1].stage_id = 2;
      history.push(hist({ candidate_id: i, stage_to_id: 2 }));
    }
    for (let i = 1; i <= 3; i++) {
      candidates[i - 1].stage_id = 3;
      history.push(hist({ candidate_id: i, stage_to_id: 3 }));
    }

    // Out-of-box: no stored benchmarks, no jobId filter. XDR_BENCH
    // positional fallback kicks in for the default 8-stage setup.
    const result = computeWaterfall(candidates, history, stages, jobs, aprilWindow);

    expect(result.benchmarksValid).toBe(true);
    expect(result.rows[1].bench_pct).toBe(50);     // XDR_BENCH[0]
    expect(result.rows[1].step_pct).toBe(60);
    expect(result.rows[1].bench_above).toBe(true);

    expect(result.rows[2].bench_pct).toBe(80);     // XDR_BENCH[1]
    expect(result.rows[2].step_pct).toBe(50);
    expect(result.rows[2].bench_above).toBe(false);
  });

  it("reads default benchmarks from the sheet (job_id = 0)", () => {
    // Default row wins over the XDR_BENCH fallback.
    const candidates = [
      makeCandidate({ id: 1, stage_id: 1, date_applied: "2026-04-05" }),
      makeCandidate({ id: 2, stage_id: 2, date_applied: "2026-04-05" }),
    ];
    const history = [
      hist({ candidate_id: 1, stage_to_id: 1 }),
      hist({ candidate_id: 2, stage_to_id: 1 }),
      hist({ candidate_id: 2, stage_to_id: 2 }),
    ];
    const benches = [
      { id: 1, stage_id: 2, job_id: 0, benchmark_pct: 40 },
    ];
    const result = computeWaterfall(
      candidates, history, stages, jobs, aprilWindow, benches,
    );
    expect(result.rows[1].bench_pct).toBe(40);     // default stored row wins
    expect(result.rows[1].step_pct).toBe(50);      // 1/2 = 50%
    expect(result.rows[1].bench_above).toBe(true); // 50 >= 40
  });

  it("prefers per-job override when the waterfall is filtered to a single job", () => {
    const candidates = [
      makeCandidate({ id: 1, stage_id: 2, job_id: 1, date_applied: "2026-04-05" }),
      makeCandidate({ id: 2, stage_id: 2, job_id: 1, date_applied: "2026-04-05" }),
      makeCandidate({ id: 3, stage_id: 1, job_id: 1, date_applied: "2026-04-05" }),
    ];
    const history = [
      hist({ candidate_id: 1, stage_to_id: 1 }),
      hist({ candidate_id: 1, stage_to_id: 2 }),
      hist({ candidate_id: 2, stage_to_id: 1 }),
      hist({ candidate_id: 2, stage_to_id: 2 }),
      hist({ candidate_id: 3, stage_to_id: 1 }),
    ];
    const benches = [
      { id: 1, stage_id: 2, job_id: 0, benchmark_pct: 50 }, // default
      { id: 2, stage_id: 2, job_id: 1, benchmark_pct: 75 }, // override for job 1
    ];
    const result = computeWaterfall(
      candidates, history, stages, jobs,
      { ...aprilWindow, jobId: 1 }, benches,
    );
    // 3 cohort, 2 reached stage 2 → 66.67% → 67%. 67 < 75 → bench_above=false
    expect(result.rows[1].bench_pct).toBe(75);       // override, not default 50
    expect(result.rows[1].bench_above).toBe(false);
  });

  it("ignores per-job overrides when no single job is selected (uses default)", () => {
    const candidates = [
      makeCandidate({ id: 1, stage_id: 2, job_id: 1, date_applied: "2026-04-05" }),
      makeCandidate({ id: 2, stage_id: 1, job_id: 2, date_applied: "2026-04-05" }),
    ];
    const history = [
      hist({ candidate_id: 1, stage_to_id: 1 }),
      hist({ candidate_id: 1, stage_to_id: 2 }),
      hist({ candidate_id: 2, stage_to_id: 1 }),
    ];
    const benches = [
      { id: 1, stage_id: 2, job_id: 0, benchmark_pct: 50 }, // default
      { id: 2, stage_id: 2, job_id: 1, benchmark_pct: 75 }, // override only for job 1
    ];
    const result = computeWaterfall(
      candidates, history, stages, jobs, aprilWindow, benches,
    );
    expect(result.rows[1].bench_pct).toBe(50);     // default, not the override
  });

  it("renders benchmarks when stored defaults exist (any stage count)", () => {
    // With stored defaults, we no longer require the 8-stage shape.
    const trimmedStages = stages.filter(s => s.id !== 2 && s.id !== 5);
    const candidates = [makeCandidate({ id: 1, stage_id: 1, date_applied: "2026-04-05" })];
    const history   = [hist({ candidate_id: 1, stage_to_id: 1 })];
    const benches   = [{ id: 1, stage_id: 3, job_id: 0, benchmark_pct: 60 }];
    const result = computeWaterfall(
      candidates, history, trimmedStages, jobs, aprilWindow, benches,
    );
    expect(result.benchmarksValid).toBe(true);
  });

  it("sets benchmarksValid=false when no fallback chain resolves", () => {
    // Drop two stages AND pass no stored benchmarks AND strip legacy
    // stage.benchmark_pct. Nothing should resolve.
    const bareStages = stages
      .filter(s => s.id !== 2 && s.id !== 5)
      .map(s => ({ ...s, benchmark_pct: null }));
    const candidates = [makeCandidate({ id: 1, stage_id: 1, date_applied: "2026-04-05" })];
    const history   = [hist({ candidate_id: 1, stage_to_id: 1 })];
    const result    = computeWaterfall(candidates, history, bareStages, jobs, aprilWindow);

    expect(result.benchmarksValid).toBe(false);
    expect(result.rows.every(r => r.bench_pct === null)).toBe(true);
    expect(result.rows.every(r => r.bench_above === null)).toBe(true);
    // Step % still computed — benchmarks just aren't compared
    expect(result.rows[0].count).toBe(1);
  });

  it("coerces string filter IDs (Alpine sends '1', row has 1)", () => {
    // Regression for the shipped filter-doesn't-work bug: the frontend
    // dropdown gives us filters.jobId = "1" but candidate.job_id is 1.
    // Strict `!==` would always fail. Loose / coerced comparison must pass.
    const candidates = [
      makeCandidate({ id: 1, stage_id: 1, job_id: 1, date_applied: "2026-04-05" }),
      makeCandidate({ id: 2, stage_id: 1, job_id: 2, date_applied: "2026-04-05" }),
    ];
    const history = [
      hist({ candidate_id: 1, stage_to_id: 1 }),
      hist({ candidate_id: 2, stage_to_id: 1 }),
    ];
    const result = computeWaterfall(candidates, history, stages, jobs, {
      ...aprilWindow,
      jobId: "1" as any,   // intentionally a string — Alpine payload
    });
    expect(result.cohortSize).toBe(1);
    expect(result.rows[0].count).toBe(1);
  });

  it("XDR_BENCH array matches sheet row 23 derivation", () => {
    // 100 → 50 → 40 → 30 → 24 → 19 → 17 → 16
    // step pcts = 50, 80, 75, 80, 79.1→79, 89.4→89, 94.1→94
    expect(Array.from(XDR_BENCH)).toEqual([50, 80, 75, 80, 79, 89, 94]);
    expect(XDR_BENCH.length).toBe(7); // 7 transitions for 8 stages
  });
});

// ============================================================
// Regression tests for the analytics-not-working bug
// ============================================================
//
// These exercise specifically the three bugs the v75 audit caught that
// were making the bottom-of-page Analytics section feel broken:
//   1. computeFunnelConversion / computeStageVelocity used `new Date(endDate)`
//      which parses as midnight UTC and excluded everything later that day.
//   2. computeStageVelocity also had a `> 0` guard that dropped same-day
//      moves entirely from dwell-time stats.
//   3. computeTimeToHireTrend bucketed via local-time JS Date constructor,
//      mis-attributing early-month hires to the previous month in EDT.
//
// All three bugs were silent under the existing `wideFilters` (endDate
// "2030-12-31") test setup. These tests use realistic dates to catch the
// real-world failure mode.

describe("computeFunnelConversion (regression: today's events on endDate)", () => {
  const stages: StageRow[] = [
    { id: 1, name: "Applied",   sequence: 100, color: "#000", is_hired: false, is_rejected: false, is_offer: false, target_hours: null, is_enabled: true },
    { id: 2, name: "Reviewed",  sequence: 200, color: "#000", is_hired: false, is_rejected: false, is_offer: false, target_hours: null, is_enabled: true },
    { id: 99, name: "Rejected", sequence: 999, color: "#000", is_hired: false, is_rejected: true,  is_offer: false, target_hours: null, is_enabled: true },
  ];

  function hist(overrides: Partial<HistoryRow>): HistoryRow {
    return {
      id: 1, timestamp: "2026-04-23T14:30:00.000Z",
      candidate_id: 1, candidate_name: "A",
      job_id: 1, job_title: "J",
      stage_from_id: 1, stage_from_name: "Applied",
      stage_to_id: 2, stage_to_name: "Reviewed",
      changed_by: "x", days_in_previous_stage: 0,
      ...overrides,
    };
  }

  it("INCLUDES transitions on the endDate that happen after midnight UTC", () => {
    // Reproduces the original bug: history row at 14:30 UTC on the
    // endDate. Old code: `ts > new Date('2026-04-23').getTime()` =>
    // ts > midnight UTC => SKIPPED. Fixed code: dateOnly comparison
    // => '2026-04-23' === '2026-04-23' => INCLUDED.
    const history = [hist({ candidate_id: 1, timestamp: "2026-04-23T14:30:00.000Z" })];
    const result = computeFunnelConversion(history, stages, {
      startDate: "2026-04-01",
      endDate:   "2026-04-23",
    });
    const reviewed = result.find(r => r.stage_id === 2);
    expect(reviewed?.entered_count).toBe(1);
  });

  it("excludes transitions outside the date range", () => {
    const history = [
      hist({ candidate_id: 1, timestamp: "2026-03-31T23:59:00.000Z" }), // before start
      hist({ candidate_id: 2, timestamp: "2026-04-15T10:00:00.000Z" }), // in range
      hist({ candidate_id: 3, timestamp: "2026-04-24T01:00:00.000Z" }), // after end
    ];
    const result = computeFunnelConversion(history, stages, {
      startDate: "2026-04-01",
      endDate:   "2026-04-23",
    });
    expect(result.find(r => r.stage_id === 2)?.entered_count).toBe(1);
  });

  it("returns 100% for the first stage and computes conversion downstream", () => {
    // A → B for 4 candidates, then B → A doesn't make sense; use B→Reviewed
    // for 2 of them. Stage list is just Applied + Reviewed.
    const history: HistoryRow[] = [
      hist({ candidate_id: 1, stage_from_id: null, stage_to_id: 1, stage_from_name: "" }),
      hist({ candidate_id: 2, stage_from_id: null, stage_to_id: 1, stage_from_name: "" }),
      hist({ candidate_id: 3, stage_from_id: null, stage_to_id: 1, stage_from_name: "" }),
      hist({ candidate_id: 4, stage_from_id: null, stage_to_id: 1, stage_from_name: "" }),
      hist({ candidate_id: 1, stage_from_id: 1,    stage_to_id: 2 }),
      hist({ candidate_id: 2, stage_from_id: 1,    stage_to_id: 2 }),
    ];
    const result = computeFunnelConversion(history, stages, wideFilters);
    expect(result[0].conversion_rate).toBe(100);
    expect(result[0].entered_count).toBe(4);
    expect(result[1].entered_count).toBe(2);
    expect(result[1].conversion_rate).toBe(50);
  });
});

describe("computeStageVelocity (regression: same-day moves + endDate)", () => {
  const stages: StageRow[] = [
    { id: 1, name: "Applied",   sequence: 100, color: "#000", is_hired: false, is_rejected: false, is_offer: false, target_hours: null, is_enabled: true },
    { id: 2, name: "Reviewed",  sequence: 200, color: "#000", is_hired: false, is_rejected: false, is_offer: false, target_hours: null, is_enabled: true },
    { id: 99, name: "Rejected", sequence: 999, color: "#000", is_hired: false, is_rejected: true,  is_offer: false, target_hours: null, is_enabled: true },
  ];

  function hist(overrides: Partial<HistoryRow>): HistoryRow {
    return {
      id: 1, timestamp: "2026-04-15T10:00:00.000Z",
      candidate_id: 1, candidate_name: "A",
      job_id: 1, job_title: "J",
      stage_from_id: 1, stage_from_name: "Applied",
      stage_to_id: 2, stage_to_name: "Reviewed",
      changed_by: "x", days_in_previous_stage: 3,
      ...overrides,
    };
  }

  it("INCLUDES same-day moves (days_in_previous_stage = 0) in the average", () => {
    // Two candidates: one took 3 days, one moved same day (0 days).
    // Old `> 0` filter would drop the 0 → average = 3.
    // Fixed: average = (3 + 0) / 2 = 1.5.
    const history = [
      hist({ candidate_id: 1, days_in_previous_stage: 3 }),
      hist({ candidate_id: 2, days_in_previous_stage: 0 }),
    ];
    const result = computeStageVelocity(history, stages, wideFilters);
    const applied = result.find(r => r.stage_id === 1);
    expect(applied?.candidate_count).toBe(2);
    expect(applied?.avg_days_in_stage).toBe(1.5);
  });

  it("INCLUDES transitions on the endDate (after midnight UTC)", () => {
    const history = [hist({ timestamp: "2026-04-23T14:30:00.000Z" })];
    const result = computeStageVelocity(history, stages, {
      startDate: "2026-04-01",
      endDate:   "2026-04-23",
    });
    expect(result.find(r => r.stage_id === 1)?.candidate_count).toBe(1);
  });

  it("counts rejections from each stage in rejected_count", () => {
    const history = [
      // A: Applied → Reviewed (normal move from Applied)
      hist({ candidate_id: 1, stage_from_id: 1, stage_to_id: 2 }),
      // B: Reviewed → Rejected (rejection from Reviewed)
      hist({ candidate_id: 2, stage_from_id: 2, stage_to_id: 99 }),
      // C: Reviewed → Rejected (another from Reviewed)
      hist({ candidate_id: 3, stage_from_id: 2, stage_to_id: 99 }),
      // D: Applied → Rejected (rejection from Applied)
      hist({ candidate_id: 4, stage_from_id: 1, stage_to_id: 99 }),
    ];
    const result = computeStageVelocity(history, stages, wideFilters);
    expect(result.find(r => r.stage_id === 1)?.rejected_count).toBe(1); // Applied
    expect(result.find(r => r.stage_id === 2)?.rejected_count).toBe(2); // Reviewed
  });

  it("rejected_count is 0 when no rejected stage is configured", () => {
    const stagesNoRej = stages.filter(s => !s.is_rejected);
    const history = [hist({ stage_from_id: 1, stage_to_id: 2 })];
    const result = computeStageVelocity(history, stagesNoRej, wideFilters);
    expect(result.every(r => r.rejected_count === 0)).toBe(true);
  });
});

describe("computeTimeToHireTrend (regression: month-boundary bucketing)", () => {
  it("attributes a hire on the 1st of a month to THAT month, not the previous", () => {
    // Reproduces the EDT off-by-one: candidate hired April 1 should land
    // in the April bucket. Old code computed `monthEnd = April 0 23:59 LOCAL`
    // which, in EDT, was ~April 1 04:59 UTC — and `new Date("2026-04-01").getTime()`
    // is April 1 00:00 UTC, which fell inside the March bucket.
    const candidates = [
      makeCandidate({
        id: 1, status: "Hired",
        date_applied: "2026-03-20",
        date_last_stage_update: "2026-04-01",
      }),
    ];
    const result = computeTimeToHireTrend(candidates, 6);
    // Find the April-of-current-year-or-prior bucket. Tests are
    // calendar-relative so we match by label suffix.
    const aprBucket = result.find(r => r.month_label.startsWith("Apr"));
    const marBucket = result.find(r => r.month_label.startsWith("Mar"));
    if (aprBucket) {
      // If April is in the visible 6-month window, the hire must land here
      expect(aprBucket.avg_days_to_hire).toBeGreaterThan(0);
      if (marBucket) expect(marBucket.avg_days_to_hire).toBe(0);
    }
  });
});

describe("computeRejectionReasons", () => {
  const reasons: RefuseReasonRow[] = [
    { id: 1, name: "Salary mismatch",  is_enabled: true },
    { id: 2, name: "Skills gap",       is_enabled: true },
    { id: 3, name: "Withdrew",         is_enabled: true },
  ];

  it("counts rejected candidates by reason, sorted desc by count", () => {
    const candidates = [
      makeCandidate({ id: 1, status: "Rejected", refuse_reason_id: 1, date_last_stage_update: "2026-04-10" }),
      makeCandidate({ id: 2, status: "Rejected", refuse_reason_id: 2, date_last_stage_update: "2026-04-11" }),
      makeCandidate({ id: 3, status: "Rejected", refuse_reason_id: 1, date_last_stage_update: "2026-04-12" }),
      makeCandidate({ id: 4, status: "Rejected", refuse_reason_id: 1, date_last_stage_update: "2026-04-13" }),
    ];
    const result = computeRejectionReasons(candidates, reasons, wideFilters);
    expect(result[0]).toEqual({ reason_id: 1, reason_name: "Salary mismatch", count: 3 });
    expect(result[1]).toEqual({ reason_id: 2, reason_name: "Skills gap",      count: 1 });
  });

  it("excludes candidates without a reason set (legacy / pre-structured)", () => {
    const candidates = [
      makeCandidate({ id: 1, status: "Rejected", refuse_reason_id: null, date_last_stage_update: "2026-04-10" }),
      makeCandidate({ id: 2, status: "Rejected", refuse_reason_id: 1,    date_last_stage_update: "2026-04-11" }),
    ];
    const result = computeRejectionReasons(candidates, reasons, wideFilters);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(1);
  });

  it("excludes Active and Hired candidates", () => {
    const candidates = [
      makeCandidate({ id: 1, status: "Active",   refuse_reason_id: 1, date_last_stage_update: "2026-04-10" }),
      makeCandidate({ id: 2, status: "Hired",    refuse_reason_id: 1, date_last_stage_update: "2026-04-10" }),
      makeCandidate({ id: 3, status: "Rejected", refuse_reason_id: 1, date_last_stage_update: "2026-04-10" }),
    ];
    const result = computeRejectionReasons(candidates, reasons, wideFilters);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(1);
  });

  it("filters by date range using rejection date (date_last_stage_update)", () => {
    const candidates = [
      makeCandidate({ id: 1, status: "Rejected", refuse_reason_id: 1, date_applied: "2026-01-01", date_last_stage_update: "2026-03-15" }),
      makeCandidate({ id: 2, status: "Rejected", refuse_reason_id: 1, date_applied: "2026-01-01", date_last_stage_update: "2026-04-15" }),
      makeCandidate({ id: 3, status: "Rejected", refuse_reason_id: 1, date_applied: "2026-01-01", date_last_stage_update: "2026-05-15" }),
    ];
    const result = computeRejectionReasons(candidates, reasons, {
      startDate: "2026-04-01",
      endDate:   "2026-04-30",
    });
    expect(result[0].count).toBe(1);
  });

  it("filters by recruiterId", () => {
    const candidates = [
      makeCandidate({ id: 1, status: "Rejected", refuse_reason_id: 1, recruiter_id: 5,    date_last_stage_update: "2026-04-10" }),
      makeCandidate({ id: 2, status: "Rejected", refuse_reason_id: 1, recruiter_id: 7,    date_last_stage_update: "2026-04-10" }),
    ];
    const result = computeRejectionReasons(candidates, reasons, { ...wideFilters, recruiterId: 5 });
    expect(result[0].count).toBe(1);
  });

  it("returns empty when no rejections in scope", () => {
    expect(computeRejectionReasons([], reasons, wideFilters)).toEqual([]);
  });
});
