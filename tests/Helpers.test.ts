import { daysBetween, logHistory, joinCandidate } from "../src/Helpers";
import type { ISheetDB, CandidateRow, StageRow, JobRow, RecruiterRow, SourceRow, RegionRow, RefuseReasonRow } from "../src/types";

// ---------- Mock SheetDB ----------

function makeMockDB(overrides: Partial<ISheetDB> = {}): ISheetDB {
  return {
    getAllCandidates: jest.fn(() => []),
    getCandidateById: jest.fn(() => null),
    appendCandidate: jest.fn(),
    updateCandidate: jest.fn(),
    deleteCandidate: jest.fn(),
    getAllJobs: jest.fn(() => []),
    getJobById: jest.fn(() => null),
    appendJob: jest.fn(),
    updateJob: jest.fn(),
    deleteJob: jest.fn(),
    appendHistory: jest.fn(),
    getHistoryForCandidate: jest.fn(() => []),
    getAllHistory: jest.fn(() => []),
    getAllStages: jest.fn(() => []),
    getAllSources: jest.fn(() => []),
    getAllRegions: jest.fn(() => []),
    getAllRecruiters: jest.fn(() => []),
    getAllRefuseReasons: jest.fn(() => []),
    replaceStages: jest.fn(),
    replaceSources: jest.fn(),
    replaceRegions: jest.fn(),
    replaceRecruiters: jest.fn(),
    replaceRefuseReasons: jest.fn(),
    seedDefaultData: jest.fn(),
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: 1, first_name: "Jane", last_name: "Doe", email: "j@t.com", phone: "",
    job_id: 1, stage_id: 1, recruiter_id: null, source_id: null, region_id: null,
    motion: "Inbound", status: "Active", rating: 0, linkedin_url: "", resume_url: "",
    notes: "", refuse_reason_id: null, kanban_state: "Normal", post_hire_status: "",
    date_applied: "2026-01-01", date_last_stage_update: "2026-01-01",
    created_by: "test@t.com", created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ============================================================
// daysBetween
// ============================================================

describe("daysBetween", () => {
  it("returns 0 for same date", () => {
    expect(daysBetween("2026-01-01", "2026-01-01")).toBe(0);
  });

  it("returns 1 for consecutive days", () => {
    expect(daysBetween("2026-01-01", "2026-01-02")).toBe(1);
  });

  it("returns 10 for 10 days apart", () => {
    expect(daysBetween("2026-01-01", "2026-01-11")).toBe(10);
  });

  it("returns 0 when either date is empty", () => {
    expect(daysBetween("", "2026-01-01")).toBe(0);
    expect(daysBetween("2026-01-01", "")).toBe(0);
  });

  it("is order-independent (absolute difference)", () => {
    expect(daysBetween("2026-01-11", "2026-01-01")).toBe(10);
  });
});

// ============================================================
// logHistory
// ============================================================

describe("logHistory", () => {
  it("calls db.appendHistory with correct fields", () => {
    const mockDB = makeMockDB();
    logHistory(
      mockDB,
      42, "Jane Doe",
      7, "Sales Rep",
      1, "Applied",
      2, "Reviewed",
      "recruiter@test.com",
      "2026-01-01"
    );

    expect(mockDB.appendHistory).toHaveBeenCalledTimes(1);
    const callArgs = (mockDB.appendHistory as jest.Mock).mock.calls[0][0];
    expect(callArgs.candidate_id).toBe(42);
    expect(callArgs.candidate_name).toBe("Jane Doe");
    expect(callArgs.job_id).toBe(7);
    expect(callArgs.job_title).toBe("Sales Rep");
    expect(callArgs.stage_from_id).toBe(1);
    expect(callArgs.stage_from_name).toBe("Applied");
    expect(callArgs.stage_to_id).toBe(2);
    expect(callArgs.stage_to_name).toBe("Reviewed");
    expect(callArgs.changed_by).toBe("recruiter@test.com");
    expect(typeof callArgs.timestamp).toBe("string");
    expect(typeof callArgs.days_in_previous_stage).toBe("number");
  });

  it("sets days_in_previous_stage to 0 when stage_from_id is null", () => {
    const mockDB = makeMockDB();
    logHistory(mockDB, 1, "Jane", 1, "Job", null, "", 1, "Applied", "user@t.com", "2026-01-01");
    const callArgs = (mockDB.appendHistory as jest.Mock).mock.calls[0][0];
    expect(callArgs.days_in_previous_stage).toBe(0);
  });
});

// ============================================================
// joinCandidate
// ============================================================

describe("joinCandidate", () => {
  const stages: StageRow[] = [
    { id: 1, name: "Applied", sequence: 100, color: "#1976d2", is_hired: false, is_rejected: false, is_offer: false, target_hours: null, is_enabled: true },
  ];
  const jobs: JobRow[] = [
    { id: 1, title: "Sales Rep", department: "Sales", location: "Remote", region_id: null, status: "Open", head_count: 1, recruiter_id: null, salary_range: "", posted_date: "", closes_date: "", posting_expires: "", notes: "", created_at: "" },
  ];
  const recruiters: RecruiterRow[] = [
    { id: 10, name: "Alice Smith", email: "alice@t.com", is_active: true },
  ];
  const sources: SourceRow[] = [
    { id: 1, name: "LinkedIn", medium: "Direct", default_motion: "Inbound", is_enabled: true },
  ];
  const regions: RegionRow[] = [
    { id: 1, name: "US - East", is_enabled: true },
  ];
  const refuseReasons: RefuseReasonRow[] = [
    { id: 1, name: "No-Show", is_enabled: true },
  ];

  it("populates stage_name and stage_color", () => {
    const c = makeCandidate({ stage_id: 1 });
    const result = joinCandidate(c, stages, jobs, recruiters, sources, regions, refuseReasons);
    expect(result.stage_name).toBe("Applied");
    expect(result.stage_color).toBe("#1976d2");
  });

  it("populates job_title", () => {
    const c = makeCandidate({ job_id: 1 });
    const result = joinCandidate(c, stages, jobs, recruiters, sources, regions, refuseReasons);
    expect(result.job_title).toBe("Sales Rep");
  });

  it("populates recruiter_name when assigned", () => {
    const c = makeCandidate({ recruiter_id: 10 });
    const result = joinCandidate(c, stages, jobs, recruiters, sources, regions, refuseReasons);
    expect(result.recruiter_name).toBe("Alice Smith");
  });

  it("returns empty recruiter_name when not assigned", () => {
    const c = makeCandidate({ recruiter_id: null });
    const result = joinCandidate(c, stages, jobs, recruiters, sources, regions, refuseReasons);
    expect(result.recruiter_name).toBe("");
  });

  it("populates source_name", () => {
    const c = makeCandidate({ source_id: 1 });
    const result = joinCandidate(c, stages, jobs, recruiters, sources, regions, refuseReasons);
    expect(result.source_name).toBe("LinkedIn");
  });

  it("populates region_name", () => {
    const c = makeCandidate({ region_id: 1 });
    const result = joinCandidate(c, stages, jobs, recruiters, sources, regions, refuseReasons);
    expect(result.region_name).toBe("US - East");
  });

  it("computes full_name", () => {
    const c = makeCandidate({ first_name: "Jane", last_name: "Doe" });
    const result = joinCandidate(c, stages, jobs, recruiters, sources, regions, refuseReasons);
    expect(result.full_name).toBe("Jane Doe");
  });

  it("computes days_in_stage > 0 for old candidates", () => {
    const c = makeCandidate({ date_last_stage_update: "2020-01-01" });
    const result = joinCandidate(c, stages, jobs, recruiters, sources, regions, refuseReasons);
    expect(result.days_in_stage).toBeGreaterThan(0);
  });

  it("uses default stage_color when stage not found", () => {
    const c = makeCandidate({ stage_id: 999 }); // unknown stage
    const result = joinCandidate(c, stages, jobs, recruiters, sources, regions, refuseReasons);
    expect(result.stage_color).toBe("#6c757d");
  });
});
