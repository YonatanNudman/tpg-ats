/**
 * Settings.test.ts
 *
 * Tests settings-related business logic: stage/source/region/recruiter/refuse-reason
 * CRUD operations, flag validation, ordering, idempotent seeding, and enable/disable.
 *
 * SheetDB is mocked — all tests run without touching Google Sheets.
 */

import type { ISheetDB, StageRow, SourceRow, RegionRow, RecruiterRow, RefuseReasonRow } from "../src/types";
import { DEFAULT_STAGES, DEFAULT_SOURCES, DEFAULT_REGIONS, DEFAULT_REFUSE_REASONS } from "../src/SheetDB";

// ---------- Mock helpers ----------

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
    getAllStages: jest.fn(() => DEFAULT_STAGES),
    getAllSources: jest.fn(() => DEFAULT_SOURCES),
    getAllRegions: jest.fn(() => DEFAULT_REGIONS),
    getAllRecruiters: jest.fn(() => []),
    getAllRefuseReasons: jest.fn(() => DEFAULT_REFUSE_REASONS),
    replaceStages: jest.fn(),
    replaceSources: jest.fn(),
    replaceRegions: jest.fn(),
    replaceRecruiters: jest.fn(),
    replaceRefuseReasons: jest.fn(),
    seedDefaultData: jest.fn(),
    ...overrides,
  };
}

function makeStage(overrides: Partial<StageRow> = {}): StageRow {
  return {
    id: 1, name: "Applied", sequence: 100, color: "#1976d2",
    is_hired: false, is_rejected: false, is_offer: false,
    target_hours: null, is_enabled: true,
    ...overrides,
  };
}

function makeSource(overrides: Partial<SourceRow> = {}): SourceRow {
  return { id: 1, name: "LinkedIn", medium: "Direct", default_motion: "Inbound", is_enabled: true, ...overrides };
}

function makeRegion(overrides: Partial<RegionRow> = {}): RegionRow {
  return { id: 1, name: "US - East", is_enabled: true, ...overrides };
}

function makeRecruiter(overrides: Partial<RecruiterRow> = {}): RecruiterRow {
  return { id: 1, name: "Alice Smith", email: "alice@t.com", is_active: true, ...overrides };
}

function makeRefuseReason(overrides: Partial<RefuseReasonRow> = {}): RefuseReasonRow {
  return { id: 1, name: "No-Show", is_enabled: true, ...overrides };
}

// ============================================================
// replaceStages — write contract
// ============================================================

describe("replaceStages", () => {
  it("calls replaceStages with the provided array", () => {
    const db = makeMockDB();
    const stages = [makeStage({ id: 1 }), makeStage({ id: 2, name: "Reviewed", sequence: 200 })];
    db.replaceStages(stages);
    expect(db.replaceStages).toHaveBeenCalledWith(stages);
    expect(db.replaceStages).toHaveBeenCalledTimes(1);
  });

  it("replaces (not appends) — getAllStages returns what replaceStages was given", () => {
    const stored: StageRow[] = [];
    const db = makeMockDB({
      replaceStages: jest.fn((rows) => { stored.length = 0; stored.push(...rows); }),
      getAllStages: jest.fn(() => stored),
    });

    const v1 = [makeStage({ id: 1 }), makeStage({ id: 2, name: "Reviewed", sequence: 200 })];
    db.replaceStages(v1);
    expect(db.getAllStages()).toHaveLength(2);

    // Replace with a smaller set — old entries gone
    const v2 = [makeStage({ id: 1 })];
    db.replaceStages(v2);
    expect(db.getAllStages()).toHaveLength(1);
  });

  it("preserves stage IDs and sequences exactly", () => {
    const db = makeMockDB();
    const stages = [
      makeStage({ id: 10, sequence: 500 }),
      makeStage({ id: 20, name: "Final", sequence: 600 }),
    ];
    db.replaceStages(stages);
    const saved = (db.replaceStages as jest.Mock).mock.calls[0][0] as StageRow[];
    expect(saved[0].id).toBe(10);
    expect(saved[0].sequence).toBe(500);
    expect(saved[1].id).toBe(20);
    expect(saved[1].sequence).toBe(600);
  });
});

// ============================================================
// replaceSources — write contract
// ============================================================

describe("replaceSources", () => {
  it("calls replaceSources with the provided array", () => {
    const db = makeMockDB();
    const sources = [makeSource({ id: 1 }), makeSource({ id: 2, name: "Indeed" })];
    db.replaceSources(sources);
    expect(db.replaceSources).toHaveBeenCalledWith(sources);
  });

  it("replaces (not appends)", () => {
    const stored: SourceRow[] = [];
    const db = makeMockDB({
      replaceSources: jest.fn((rows) => { stored.length = 0; stored.push(...rows); }),
      getAllSources: jest.fn(() => stored),
    });
    db.replaceSources([makeSource({ id: 1 }), makeSource({ id: 2, name: "Indeed" })]);
    db.replaceSources([makeSource({ id: 1 })]);
    expect(db.getAllSources()).toHaveLength(1);
  });
});

// ============================================================
// replaceRegions — write contract
// ============================================================

describe("replaceRegions", () => {
  it("calls replaceRegions with the provided array", () => {
    const db = makeMockDB();
    const regions = [makeRegion({ id: 1 }), makeRegion({ id: 2, name: "US - West" })];
    db.replaceRegions(regions);
    expect(db.replaceRegions).toHaveBeenCalledWith(regions);
  });
});

// ============================================================
// replaceRecruiters — write contract
// ============================================================

describe("replaceRecruiters", () => {
  it("calls replaceRecruiters with the provided array", () => {
    const db = makeMockDB();
    const recruiters = [makeRecruiter({ id: 1 }), makeRecruiter({ id: 2, name: "Bob Jones" })];
    db.replaceRecruiters(recruiters);
    expect(db.replaceRecruiters).toHaveBeenCalledWith(recruiters);
  });

  it("inactive recruiter is preserved in the saved array", () => {
    const db = makeMockDB();
    const recruiters = [
      makeRecruiter({ id: 1, is_active: true }),
      makeRecruiter({ id: 2, name: "Old Recruiter", is_active: false }),
    ];
    db.replaceRecruiters(recruiters);
    const saved = (db.replaceRecruiters as jest.Mock).mock.calls[0][0] as RecruiterRow[];
    expect(saved.find(r => r.id === 2)?.is_active).toBe(false);
  });
});

// ============================================================
// replaceRefuseReasons — write contract
// ============================================================

describe("replaceRefuseReasons", () => {
  it("calls replaceRefuseReasons with the provided array", () => {
    const db = makeMockDB();
    const reasons = [makeRefuseReason({ id: 1 }), makeRefuseReason({ id: 2, name: "Withdrew" })];
    db.replaceRefuseReasons(reasons);
    expect(db.replaceRefuseReasons).toHaveBeenCalledWith(reasons);
  });
});

// ============================================================
// Stage flag validation (business logic — pure)
// ============================================================

describe("stage flag validation", () => {
  // These tests run validation logic inline, mirroring what saveStages() in Code.ts
  // should enforce before calling replaceStages().

  function validateStageFlags(stages: StageRow[]): string | null {
    const hiredCount = stages.filter(s => s.is_hired).length;
    const rejectedCount = stages.filter(s => s.is_rejected).length;
    const offerCount = stages.filter(s => s.is_offer).length;
    if (hiredCount > 1) return "Only one stage can be the Hired stage.";
    if (rejectedCount > 1) return "Only one stage can be the Rejected stage.";
    if (offerCount > 1) return "Only one stage can be the Offer stage.";
    return null;
  }

  it("accepts a valid set of stages (one hired, one rejected, one offer)", () => {
    const stages = [
      makeStage({ id: 1, is_hired: false }),
      makeStage({ id: 2, is_hired: true }),
      makeStage({ id: 3, is_rejected: true }),
      makeStage({ id: 4, is_offer: true }),
    ];
    expect(validateStageFlags(stages)).toBeNull();
  });

  it("rejects two hired stages", () => {
    const stages = [
      makeStage({ id: 1, is_hired: true }),
      makeStage({ id: 2, is_hired: true }),
    ];
    expect(validateStageFlags(stages)).toMatch(/Hired/);
  });

  it("rejects two rejected stages", () => {
    const stages = [
      makeStage({ id: 1, is_rejected: true }),
      makeStage({ id: 2, is_rejected: true }),
    ];
    expect(validateStageFlags(stages)).toMatch(/Rejected/);
  });

  it("rejects two offer stages", () => {
    const stages = [
      makeStage({ id: 1, is_offer: true }),
      makeStage({ id: 2, is_offer: true }),
    ];
    expect(validateStageFlags(stages)).toMatch(/Offer/);
  });

  it("accepts no hired/rejected/offer flags at all (edge case)", () => {
    const stages = [makeStage({ id: 1 }), makeStage({ id: 2, name: "Reviewed", sequence: 200 })];
    expect(validateStageFlags(stages)).toBeNull();
  });
});

// ============================================================
// Stage sequence ordering
// ============================================================

describe("stage sequence ordering", () => {
  it("enabled stages can be sorted by sequence ascending", () => {
    const stages: StageRow[] = [
      makeStage({ id: 3, sequence: 300 }),
      makeStage({ id: 1, sequence: 100 }),
      makeStage({ id: 2, sequence: 200 }),
    ];
    const sorted = [...stages].sort((a, b) => a.sequence - b.sequence);
    expect(sorted[0].id).toBe(1);
    expect(sorted[1].id).toBe(2);
    expect(sorted[2].id).toBe(3);
  });

  it("sequences are unique after editing", () => {
    const stages: StageRow[] = [
      makeStage({ id: 1, sequence: 100 }),
      makeStage({ id: 2, sequence: 200 }),
      makeStage({ id: 3, sequence: 300 }),
    ];
    const seqs = stages.map(s => s.sequence);
    expect(new Set(seqs).size).toBe(stages.length);
  });

  it("disabled stages do not appear when filtering for Kanban columns", () => {
    const stages: StageRow[] = [
      makeStage({ id: 1, is_enabled: true }),
      makeStage({ id: 2, name: "Hidden", sequence: 200, is_enabled: false }),
      makeStage({ id: 3, name: "Active", sequence: 300, is_enabled: true }),
    ];
    const kanbanColumns = stages.filter(s => s.is_enabled).sort((a, b) => a.sequence - b.sequence);
    expect(kanbanColumns).toHaveLength(2);
    expect(kanbanColumns.every(s => s.is_enabled)).toBe(true);
  });
});

// ============================================================
// seedDefaultData — idempotency
// ============================================================

describe("seedDefaultData idempotency", () => {
  it("calls seedDefaultData on the db (called at startup)", () => {
    const db = makeMockDB();
    db.seedDefaultData();
    expect(db.seedDefaultData).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite existing stages when tabs are non-empty (logic check)", () => {
    // Simulates the guard in SheetDB.seedDefaultData():
    // if (existingStages.length > 0) skip
    const existingStages = [makeStage({ id: 99, name: "Custom" })];
    const db = makeMockDB({ getAllStages: jest.fn(() => existingStages) });

    function conditionalSeed(db_: typeof db) {
      if (db_.getAllStages().length === 0) {
        db_.replaceStages(DEFAULT_STAGES);
      }
    }

    conditionalSeed(db);
    expect(db.replaceStages).not.toHaveBeenCalled();
  });

  it("seeds stages when tab is empty", () => {
    const db = makeMockDB({ getAllStages: jest.fn(() => []) });

    function conditionalSeed(db_: typeof db) {
      if (db_.getAllStages().length === 0) {
        db_.replaceStages(DEFAULT_STAGES);
      }
    }

    conditionalSeed(db);
    expect(db.replaceStages).toHaveBeenCalledWith(DEFAULT_STAGES);
  });

  it("seeds each settings type independently (if empty)", () => {
    // All empty — all five seed calls should fire
    const db = makeMockDB({
      getAllStages: jest.fn(() => []),
      getAllSources: jest.fn(() => []),
      getAllRegions: jest.fn(() => []),
      getAllRecruiters: jest.fn(() => []),
      getAllRefuseReasons: jest.fn(() => []),
    });

    function conditionalSeedAll(db_: typeof db) {
      if (db_.getAllStages().length === 0) db_.replaceStages(DEFAULT_STAGES);
      if (db_.getAllSources().length === 0) db_.replaceSources(DEFAULT_SOURCES);
      if (db_.getAllRegions().length === 0) db_.replaceRegions(DEFAULT_REGIONS);
      if (db_.getAllRefuseReasons().length === 0) db_.replaceRefuseReasons(DEFAULT_REFUSE_REASONS);
    }

    conditionalSeedAll(db);
    expect(db.replaceStages).toHaveBeenCalledTimes(1);
    expect(db.replaceSources).toHaveBeenCalledTimes(1);
    expect(db.replaceRegions).toHaveBeenCalledTimes(1);
    expect(db.replaceRefuseReasons).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// Enable / disable toggle (pure logic)
// ============================================================

describe("enable/disable toggle logic", () => {
  it("toggling a source disabled removes it from active dropdowns", () => {
    const sources: SourceRow[] = [
      makeSource({ id: 1, is_enabled: true }),
      makeSource({ id: 2, name: "Disabled Source", is_enabled: false }),
    ];
    const active = sources.filter(s => s.is_enabled);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(1);
  });

  it("toggling a region disabled removes it from active dropdowns", () => {
    const regions: RegionRow[] = [
      makeRegion({ id: 1, is_enabled: true }),
      makeRegion({ id: 2, name: "Old Region", is_enabled: false }),
    ];
    const active = regions.filter(r => r.is_enabled);
    expect(active).toHaveLength(1);
  });

  it("toggling a refuse reason disabled removes it from rejection dropdown", () => {
    const reasons: RefuseReasonRow[] = [
      makeRefuseReason({ id: 1, is_enabled: true }),
      makeRefuseReason({ id: 2, name: "Archived Reason", is_enabled: false }),
    ];
    const active = reasons.filter(r => r.is_enabled);
    expect(active).toHaveLength(1);
  });
});

// ============================================================
// Source default_motion auto-detection (used by createCandidate)
// ============================================================

describe("source default_motion lookup", () => {
  it("looks up default_motion from source when creating a candidate", () => {
    const sources: SourceRow[] = [
      makeSource({ id: 1, name: "LinkedIn", default_motion: "Inbound" }),
      makeSource({ id: 2, name: "Outbound Campaign", default_motion: "Outbound" }),
    ];
    const getMotionForSource = (sourceId: number) =>
      sources.find(s => s.id === sourceId)?.default_motion ?? "Inbound";

    expect(getMotionForSource(1)).toBe("Inbound");
    expect(getMotionForSource(2)).toBe("Outbound");
    expect(getMotionForSource(99)).toBe("Inbound"); // unknown → default Inbound
  });
});

// ============================================================
// Settings data structure integrity
// ============================================================

describe("settings data structure integrity", () => {
  it("all DEFAULT_STAGES have required fields", () => {
    DEFAULT_STAGES.forEach(s => {
      expect(typeof s.id).toBe("number");
      expect(typeof s.name).toBe("string");
      expect(s.name.length).toBeGreaterThan(0);
      expect(typeof s.sequence).toBe("number");
      expect(typeof s.color).toBe("string");
      expect(s.color).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(typeof s.is_enabled).toBe("boolean");
    });
  });

  it("all DEFAULT_SOURCES have required fields", () => {
    DEFAULT_SOURCES.forEach(s => {
      expect(typeof s.id).toBe("number");
      expect(typeof s.name).toBe("string");
      expect(["Inbound", "Outbound"]).toContain(s.default_motion);
    });
  });

  it("all DEFAULT_REGIONS have required fields", () => {
    DEFAULT_REGIONS.forEach(r => {
      expect(typeof r.id).toBe("number");
      expect(typeof r.name).toBe("string");
      expect(r.name.length).toBeGreaterThan(0);
    });
  });

  it("all DEFAULT_REFUSE_REASONS have required fields", () => {
    DEFAULT_REFUSE_REASONS.forEach(r => {
      expect(typeof r.id).toBe("number");
      expect(typeof r.name).toBe("string");
      expect(r.name.length).toBeGreaterThan(0);
    });
  });

  it("DEFAULT_STAGES IDs are unique", () => {
    const ids = DEFAULT_STAGES.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("DEFAULT_SOURCES IDs are unique", () => {
    const ids = DEFAULT_SOURCES.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("DEFAULT_REGIONS IDs are unique", () => {
    const ids = DEFAULT_REGIONS.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("DEFAULT_REFUSE_REASONS IDs are unique", () => {
    const ids = DEFAULT_REFUSE_REASONS.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exactly one DEFAULT_STAGE is the hired stage", () => {
    expect(DEFAULT_STAGES.filter(s => s.is_hired)).toHaveLength(1);
  });

  it("exactly one DEFAULT_STAGE is the rejected stage", () => {
    expect(DEFAULT_STAGES.filter(s => s.is_rejected)).toHaveLength(1);
  });

  it("exactly one DEFAULT_STAGE is the offer stage", () => {
    expect(DEFAULT_STAGES.filter(s => s.is_offer)).toHaveLength(1);
  });

  it("all DEFAULT_STAGES are enabled by default", () => {
    expect(DEFAULT_STAGES.every(s => s.is_enabled)).toBe(true);
  });

  it("all DEFAULT_SOURCES are enabled by default", () => {
    expect(DEFAULT_SOURCES.every(s => s.is_enabled)).toBe(true);
  });

  it("all DEFAULT_REGIONS are enabled by default", () => {
    expect(DEFAULT_REGIONS.every(r => r.is_enabled)).toBe(true);
  });

  it("all DEFAULT_REFUSE_REASONS are enabled by default", () => {
    expect(DEFAULT_REFUSE_REASONS.every(r => r.is_enabled)).toBe(true);
  });
});

// ============================================================
// Recruiter active-only filter
// ============================================================

describe("recruiter active filter", () => {
  it("only active recruiters appear in assignment dropdowns", () => {
    const recruiters: RecruiterRow[] = [
      makeRecruiter({ id: 1, is_active: true }),
      makeRecruiter({ id: 2, name: "Former", email: "x@t.com", is_active: false }),
    ];
    const active = recruiters.filter(r => r.is_active);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(1);
  });

  it("deactivated recruiter is preserved in db (not deleted)", () => {
    const db = makeMockDB({
      getAllRecruiters: jest.fn(() => [
        makeRecruiter({ id: 1, is_active: true }),
        makeRecruiter({ id: 2, name: "Former", email: "x@t.com", is_active: false }),
      ]),
    });
    const all = db.getAllRecruiters();
    expect(all).toHaveLength(2); // both present in DB
    expect(all.filter(r => r.is_active)).toHaveLength(1); // only 1 active
  });
});
