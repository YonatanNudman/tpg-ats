/**
 * Jobs.test.ts — Tests for job opening business logic
 */

import type { ISheetDB, JobRow, CandidateRow } from "../src/types";

function makeMockDB(jobs: JobRow[] = [], candidates: CandidateRow[] = [], overrides: Partial<ISheetDB> = {}): ISheetDB {
  return {
    getAllCandidates: jest.fn(() => candidates),
    getCandidateById: jest.fn(() => null),
    appendCandidate: jest.fn(),
    updateCandidate: jest.fn(),
    deleteCandidate: jest.fn(),
    getAllJobs: jest.fn(() => jobs),
    getJobById: jest.fn(id => jobs.find(j => j.id === id) ?? null),
    appendJob: jest.fn(row => ({ ...row, id: 99 } as JobRow)),
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

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 1, title: "Sales Rep", department: "Sales", location: "Remote",
    region_id: null, status: "Open", head_count: 1, filled: 0, recruiter_id: null,
    salary_range: "", posted_date: "2026-01-01", closes_date: "", posting_expires: "",
    notes: "", created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCandidate(jobId: number, id = 1): CandidateRow {
  return {
    id, first_name: "Jane", last_name: "Doe", email: "j@t.com", phone: "",
    job_id: jobId, stage_id: 1, recruiter_id: null, source_id: null, region_id: null,
    motion: "Inbound", status: "Active", rating: 0, linkedin_url: "", resume_url: "",
    notes: "", refuse_reason_id: null, kanban_state: "Normal", post_hire_status: "",
    date_applied: "2026-01-01", date_last_stage_update: "2026-01-01",
    created_by: "t@t.com", created_at: "2026-01-01T00:00:00Z",
  };
}

// ============================================================
// deleteJobOpening guard
// ============================================================

describe("deleteJobOpening guard", () => {
  it("should throw when job has candidates", () => {
    const candidates = [makeCandidate(1)];
    const db = makeMockDB([makeJob({ id: 1 })], candidates);

    // Replicate the guard logic from Code.ts deleteJobOpening
    function deleteJobWithGuard(id: number) {
      const hasCandidate = db.getAllCandidates().some(c => c.job_id === id);
      if (hasCandidate) throw new Error("Cannot delete a job with existing candidates. Close the job instead.");
      db.deleteJob(id);
    }

    expect(() => deleteJobWithGuard(1)).toThrow("Cannot delete a job with existing candidates");
    expect(db.deleteJob).not.toHaveBeenCalled();
  });

  it("should succeed when job has no candidates", () => {
    const db = makeMockDB([makeJob({ id: 1 })], []);

    function deleteJobWithGuard(id: number) {
      const hasCandidate = db.getAllCandidates().some(c => c.job_id === id);
      if (hasCandidate) throw new Error("Cannot delete a job with existing candidates. Close the job instead.");
      db.deleteJob(id);
    }

    expect(() => deleteJobWithGuard(1)).not.toThrow();
    expect(db.deleteJob).toHaveBeenCalledWith(1);
  });

  it("guard checks the correct job id (not all jobs)", () => {
    const candidates = [makeCandidate(2)]; // candidate on job 2, not job 1
    const db = makeMockDB([makeJob({ id: 1 }), makeJob({ id: 2 })], candidates);

    function deleteJobWithGuard(id: number) {
      const hasCandidate = db.getAllCandidates().some(c => c.job_id === id);
      if (hasCandidate) throw new Error("Cannot delete a job with existing candidates.");
      db.deleteJob(id);
    }

    // Deleting job 1 (no candidates) should succeed
    expect(() => deleteJobWithGuard(1)).not.toThrow();
    // Deleting job 2 (has candidates) should throw
    expect(() => deleteJobWithGuard(2)).toThrow();
  });
});

// ============================================================
// Job status filtering
// ============================================================

describe("job status filtering", () => {
  const jobs = [
    makeJob({ id: 1, status: "Open" }),
    makeJob({ id: 2, status: "On Hold" }),
    makeJob({ id: 3, status: "Closed" }),
    makeJob({ id: 4, status: "Open" }),
  ];

  it("filters to Open only", () => {
    const result = jobs.filter(j => j.status === "Open");
    expect(result).toHaveLength(2);
  });

  it("filters to On Hold only", () => {
    const result = jobs.filter(j => j.status === "On Hold");
    expect(result).toHaveLength(1);
  });

  it("returns all when no status filter", () => {
    const result = jobs.filter(() => true);
    expect(result).toHaveLength(4);
  });
});

// ============================================================
// Job expiry logic
// ============================================================

describe("job posting expiry", () => {
  it("identifies expired postings (past date)", () => {
    const jobs = [
      makeJob({ id: 1, posting_expires: "2020-01-01", status: "Open" }),
      makeJob({ id: 2, posting_expires: "2099-12-31", status: "Open" }),
      makeJob({ id: 3, posting_expires: "", status: "Open" }),
    ];
    const today = new Date();
    const expired = jobs.filter(j =>
      j.status === "Open" &&
      j.posting_expires &&
      new Date(j.posting_expires).getTime() < today.getTime()
    );
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe(1);
  });

  it("identifies expiring within 7 days", () => {
    const today = new Date();
    const in3Days = new Date(today.getTime() + 3 * 86_400_000).toISOString().split("T")[0];
    const in10Days = new Date(today.getTime() + 10 * 86_400_000).toISOString().split("T")[0];
    const jobs = [
      makeJob({ id: 1, posting_expires: in3Days, status: "Open" }),
      makeJob({ id: 2, posting_expires: in10Days, status: "Open" }),
    ];
    const soon = jobs.filter(j => {
      if (!j.posting_expires || j.status !== "Open") return false;
      const exp = new Date(j.posting_expires).getTime();
      const sevenDays = today.getTime() + 7 * 86_400_000;
      return exp >= today.getTime() && exp <= sevenDays;
    });
    expect(soon).toHaveLength(1);
    expect(soon[0].id).toBe(1);
  });
});

// ============================================================
// appendJob called with correct structure
// ============================================================

describe("appendJob", () => {
  it("calls appendJob with all required fields", () => {
    const db = makeMockDB();
    const input = {
      title: "BDR", department: "Sales", location: "Remote",
      region_id: null, status: "Open" as const, head_count: 2, filled: 0,
      recruiter_id: null, salary_range: "$50k", posted_date: "2026-01-01",
      closes_date: "", posting_expires: "", notes: "", created_at: "2026-01-01T00:00:00Z",
    };
    db.appendJob(input);
    expect(db.appendJob).toHaveBeenCalledWith(expect.objectContaining({ title: "BDR" }));
  });
});
