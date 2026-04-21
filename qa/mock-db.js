/**
 * In-memory ISheetDB implementation for the QA harness.
 * Exposes the same surface as src/SheetDB.ts so all of Code.ts's
 * frontend-callable functions can run unchanged.
 *
 * Default seed matches DEFAULT_STAGES/SOURCES/REGIONS/REFUSE_REASONS
 * from src/SheetDB.ts (we re-export those from the bundled logic.cjs).
 */
const {
  DEFAULT_STAGES,
  DEFAULT_SOURCES,
  DEFAULT_REGIONS,
  DEFAULT_REFUSE_REASONS,
} = require('./.bundle/logic.cjs');

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

class MockSheetDB {
  constructor() {
    this.candidates = [];
    this.jobs = [];
    this.history = [];
    this.stages = [];
    this.sources = [];
    this.regions = [];
    this.recruiters = [];
    this.refuseReasons = [];
    this._candidateNextId = 1;
    this._jobNextId = 1;
    this._historyNextId = 1;
  }

  // -------- Candidates --------
  getAllCandidates() { return clone(this.candidates); }
  getCandidateById(id) {
    const c = this.candidates.find(c => c.id === id);
    return c ? clone(c) : null;
  }
  appendCandidate(row) {
    const c = { ...row, id: this._candidateNextId++ };
    this.candidates.push(c);
    return clone(c);
  }
  updateCandidate(id, updates) {
    const idx = this.candidates.findIndex(c => c.id === id);
    if (idx < 0) throw new Error(`Candidate ${id} not found`);
    this.candidates[idx] = { ...this.candidates[idx], ...updates, id };
  }
  deleteCandidate(id) {
    const idx = this.candidates.findIndex(c => c.id === id);
    if (idx < 0) throw new Error(`Candidate ${id} not found`);
    this.candidates.splice(idx, 1);
  }

  // -------- Jobs --------
  getAllJobs() { return clone(this.jobs); }
  getJobById(id) {
    const j = this.jobs.find(j => j.id === id);
    return j ? clone(j) : null;
  }
  appendJob(row) {
    const j = { ...row, id: this._jobNextId++ };
    this.jobs.push(j);
    return clone(j);
  }
  updateJob(id, updates) {
    const idx = this.jobs.findIndex(j => j.id === id);
    if (idx < 0) throw new Error(`Job ${id} not found`);
    this.jobs[idx] = { ...this.jobs[idx], ...updates, id };
  }
  deleteJob(id) {
    const idx = this.jobs.findIndex(j => j.id === id);
    if (idx < 0) throw new Error(`Job ${id} not found`);
    this.jobs.splice(idx, 1);
  }

  // -------- History --------
  appendHistory(row) {
    this.history.push({ ...row, id: this._historyNextId++ });
  }
  getHistoryForCandidate(candidateId) {
    return this.history
      .filter(h => h.candidate_id === candidateId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .map(clone);
  }
  getAllHistory() { return clone(this.history); }

  // -------- Settings --------
  getAllStages() { return clone(this.stages); }
  getAllSources() { return clone(this.sources); }
  getAllRegions() { return clone(this.regions); }
  getAllRecruiters() { return clone(this.recruiters); }
  getAllRefuseReasons() { return clone(this.refuseReasons); }

  // GAS contract: replace* assigns IDs sequentially when input id is 0/missing
  // (matches the behavior the unit tests exercise via Settings.test.ts).
  replaceStages(rows) {
    let next = Math.max(0, ...rows.map(r => Number(r.id) || 0)) + 1;
    this.stages = rows.map(r => clone({ ...r, id: r.id && r.id > 0 ? r.id : next++ }));
  }
  replaceSources(rows) {
    let next = Math.max(0, ...rows.map(r => Number(r.id) || 0)) + 1;
    this.sources = rows.map(r => clone({ ...r, id: r.id && r.id > 0 ? r.id : next++ }));
  }
  replaceRegions(rows) {
    let next = Math.max(0, ...rows.map(r => Number(r.id) || 0)) + 1;
    this.regions = rows.map(r => clone({ ...r, id: r.id && r.id > 0 ? r.id : next++ }));
  }
  replaceRecruiters(rows) {
    let next = Math.max(0, ...rows.map(r => Number(r.id) || 0)) + 1;
    this.recruiters = rows.map(r => clone({ ...r, id: r.id && r.id > 0 ? r.id : next++ }));
  }
  replaceRefuseReasons(rows) {
    let next = Math.max(0, ...rows.map(r => Number(r.id) || 0)) + 1;
    this.refuseReasons = rows.map(r => clone({ ...r, id: r.id && r.id > 0 ? r.id : next++ }));
  }

  seedDefaultData() {
    if (this.stages.length === 0) this.replaceStages(DEFAULT_STAGES);
    if (this.sources.length === 0) this.replaceSources(DEFAULT_SOURCES);
    if (this.regions.length === 0) this.replaceRegions(DEFAULT_REGIONS);
    if (this.refuseReasons.length === 0) this.replaceRefuseReasons(DEFAULT_REFUSE_REASONS);
  }
}

module.exports = { MockSheetDB };
