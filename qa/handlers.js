/**
 * QA Harness — re-implements the thin frontend-callable wrappers in src/Code.ts.
 *
 * Heavy lifting (joinCandidate, computeKpis, computeFunnelConversion, ...) is
 * imported from the SAME modules the production GAS deploy uses (bundled by
 * qa/build-bundle.js). The orchestration glue here matches src/Code.ts almost
 * line-for-line so any divergence between QA and prod stays visible.
 */
const {
  logHistory,
  joinCandidate,
  joinCandidates,
  todayStr,
  nowStr,
  getCurrentUserEmail,
  computeKpis,
  computePipelineSnapshot,
  computeFunnelConversion,
  computeRecruiterPerformance,
  computeSourceEffectiveness,
  computeTimeToHireTrend,
  computeStageVelocity,
  computeRejectionReasons,
  computeSlaBreaches,
  computeStaleCandidates,
  computeWaterfall,
  filterCandidates,
} = require('./.bundle/logic.cjs');

function makeHandlers(db) {
  // ============================================================
  // Settings / init
  // ============================================================

  function ensureDefaultData() { db.seedDefaultData(); }

  function getSettings() {
    return {
      stages: db.getAllStages(),
      sources: db.getAllSources(),
      regions: db.getAllRegions(),
      recruiters: db.getAllRecruiters(),
      refuseReasons: db.getAllRefuseReasons(),
    };
  }

  function saveStages(stages) { db.replaceStages(stages); }
  function saveSources(sources) { db.replaceSources(sources); }
  function saveRegions(regions) { db.replaceRegions(regions); }
  function saveRecruiters(recruiters) { db.replaceRecruiters(recruiters); }
  function saveRefuseReasons(reasons) { db.replaceRefuseReasons(reasons); }
  function saveWaterfallBenchmarks(rows) { db.replaceWaterfallBenchmarks(rows); }

  function getCurrentUserEmailHandler() { return getCurrentUserEmail(); }

  // ============================================================
  // Candidates
  // ============================================================

  function getCandidates(filters) {
    filters = filters || {};
    let all = db.getAllCandidates();

    if (filters.jobId === '__unassigned__') {
      all = all.filter(c => !c.job_id || c.job_id === 0);
    } else if (filters.jobId) {
      all = all.filter(c => c.job_id === filters.jobId);
    }
    if (filters.stageId)     all = all.filter(c => c.stage_id     === filters.stageId);
    if (filters.recruiterId === '__unassigned__') {
      all = all.filter(c => !c.recruiter_id || c.recruiter_id === 0);
    } else if (filters.recruiterId === '__assigned__') {
      all = all.filter(c => !!c.recruiter_id && c.recruiter_id !== 0);
    } else if (filters.recruiterId) {
      all = all.filter(c => c.recruiter_id === filters.recruiterId);
    }
    if (filters.sourceId === '__unassigned__') {
      all = all.filter(c => !c.source_id || c.source_id === 0);
    } else if (filters.sourceId) {
      all = all.filter(c => c.source_id === filters.sourceId);
    }
    if (filters.regionId === '__unassigned__') {
      all = all.filter(c => !c.region_id || c.region_id === 0);
    } else if (filters.regionId) {
      all = all.filter(c => c.region_id === filters.regionId);
    }
    if (filters.motion === '__unassigned__') {
      all = all.filter(c => c.motion !== 'Inbound' && c.motion !== 'Outbound');
    } else if (filters.motion) {
      all = all.filter(c => c.motion === filters.motion);
    }
    if (filters.status)      all = all.filter(c => c.status       === filters.status);

    if (filters.search) {
      const q = String(filters.search).toLowerCase();
      all = all.filter(c =>
        `${c.first_name} ${c.last_name}`.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q),
      );
    }

    // Calendar-date compare (mirrors src/Code.ts:getCandidates). Avoids the
    // "candidate stored at midnight Eastern is excluded from a same-day
    // endDate window" bug.
    if (filters.startDate) {
      const start = String(filters.startDate).slice(0, 10);
      all = all.filter(c => {
        const d = String(c.date_applied || "").slice(0, 10);
        return !d || d >= start;
      });
    }
    if (filters.endDate) {
      const end = String(filters.endDate).slice(0, 10);
      all = all.filter(c => {
        const d = String(c.date_applied || "").slice(0, 10);
        return !d || d <= end;
      });
    }

    return joinCandidates(all, db);
  }

  function getCandidateDetail(id) {
    const candidate = db.getCandidateById(id);
    if (!candidate) throw new Error(`Candidate ${id} not found`);

    return {
      candidate: joinCandidate(
        candidate,
        db.getAllStages(),
        db.getAllJobs(),
        db.getAllRecruiters(),
        db.getAllSources(),
        db.getAllRegions(),
        db.getAllRefuseReasons(),
      ),
      history: db.getHistoryForCandidate(id),
    };
  }

  function findDuplicateCandidatesByEmail(email) {
    if (!email) return [];
    const needle = String(email).trim().toLowerCase();
    if (!needle) return [];
    const matches = db.getAllCandidates().filter(c => (c.email || '').trim().toLowerCase() === needle);
    if (matches.length === 0) return [];
    return matches.map(c => joinCandidate(
      c, db.getAllStages(), db.getAllJobs(), db.getAllRecruiters(),
      db.getAllSources(), db.getAllRegions(), db.getAllRefuseReasons(),
    ));
  }

  function createCandidate(data) {
    const stages = db.getAllStages()
      .filter(s => s.is_enabled)
      .sort((a, b) => a.sequence - b.sequence);
    if (stages.length === 0) throw new Error('No pipeline stages configured');

    const firstStage = stages[0];
    const today = todayStr();
    const userEmail = getCurrentUserEmail();

    let motion = data.motion || 'Inbound';
    if (data.source_id) {
      const src = db.getAllSources().find(s => s.id === data.source_id);
      if (src) motion = src.default_motion;
    }

    const candidate = db.appendCandidate({
      first_name:             data.first_name,
      last_name:              data.last_name,
      email:                  data.email,
      phone:                  data.phone || '',
      job_id:                 data.job_id,
      stage_id:               firstStage.id,
      recruiter_id:           data.recruiter_id != null ? data.recruiter_id : null,
      source_id:              data.source_id != null ? data.source_id : null,
      region_id:              data.region_id != null ? data.region_id : null,
      motion,
      status:                 'Active',
      rating:                 0,
      linkedin_url:           data.linkedin_url || '',
      resume_url:             '',
      notes:                  data.notes || '',
      refuse_reason_id:       null,
      kanban_state:           'Normal',
      post_hire_status:       '',
      date_applied:           today,
      date_last_stage_update: today,
      created_by:             userEmail,
      created_at:             nowStr(),
    });

    const job = db.getJobById(data.job_id);
    logHistory(
      db,
      candidate.id, `${data.first_name} ${data.last_name}`,
      data.job_id, (job && job.title) || '',
      null, '',
      firstStage.id, firstStage.name,
      userEmail, today,
    );

    return candidate;
  }

  function updateCandidate(id, data) {
    db.updateCandidate(id, data);
  }

  function updateCandidateStage(id, newStageId) {
    const candidate = db.getCandidateById(id);
    if (!candidate) throw new Error(`Candidate ${id} not found`);
    if (candidate.stage_id === newStageId) return;

    const stages = db.getAllStages();
    const fromStage = stages.find(s => s.id === candidate.stage_id);
    const toStage   = stages.find(s => s.id === newStageId);
    if (!toStage) throw new Error(`Stage ${newStageId} not found`);

    const userEmail = getCurrentUserEmail();
    const today = todayStr();

    let newStatus = candidate.status;
    if (toStage.is_hired) newStatus = 'Hired';
    else if (toStage.is_rejected) newStatus = 'Rejected';

    logHistory(
      db,
      id, `${candidate.first_name} ${candidate.last_name}`,
      candidate.job_id, '',
      candidate.stage_id, (fromStage && fromStage.name) || '',
      newStageId, toStage.name,
      userEmail, candidate.date_last_stage_update,
    );

    db.updateCandidate(id, {
      stage_id:               newStageId,
      status:                 newStatus,
      date_last_stage_update: today,
    });
  }

  function rejectCandidate(id, refuseReasonId) {
    const candidate = db.getCandidateById(id);
    if (!candidate) throw new Error(`Candidate ${id} not found`);

    const stages = db.getAllStages();
    const rejectedStage = stages.find(s => s.is_rejected && s.is_enabled);
    if (!rejectedStage) throw new Error('No rejected stage configured');

    const fromStage = stages.find(s => s.id === candidate.stage_id);
    const userEmail = getCurrentUserEmail();
    const today = todayStr();

    logHistory(
      db,
      id, `${candidate.first_name} ${candidate.last_name}`,
      candidate.job_id, '',
      candidate.stage_id, (fromStage && fromStage.name) || '',
      rejectedStage.id, rejectedStage.name,
      userEmail, candidate.date_last_stage_update,
    );

    db.updateCandidate(id, {
      stage_id:               rejectedStage.id,
      status:                 'Rejected',
      refuse_reason_id:       refuseReasonId,
      date_last_stage_update: today,
    });
  }

  function deleteCandidate(id) { db.deleteCandidate(id); }

  function assignRecruiter(id, recruiterId) { db.updateCandidate(id, { recruiter_id: recruiterId }); }
  function updateKanbanState(id, state) { db.updateCandidate(id, { kanban_state: state }); }
  function updatePostHireStatus(id, status) { db.updateCandidate(id, { post_hire_status: status }); }

  // ============================================================
  // Bulk operations
  // ============================================================

  function _runBulk(ids, perRow) {
    const successIds = [];
    const failures = [];
    for (const rawId of ids || []) {
      const id = Number(rawId);
      if (!id || isNaN(id)) { failures.push({ id: rawId, message: 'Invalid id' }); continue; }
      try { perRow(id); successIds.push(id); }
      catch (e) { failures.push({ id, message: e.message || String(e) }); }
    }
    return { successIds, failures };
  }

  function bulkAdvanceStage(ids, targetStageId) {
    const stageId = Number(targetStageId);
    if (!stageId) throw new Error('targetStageId required');
    return _runBulk(ids, (id) => updateCandidateStage(id, stageId));
  }

  function bulkAssignRecruiter(ids, recruiterId) {
    const rid = recruiterId == null ? null : Number(recruiterId);
    return _runBulk(ids, (id) => assignRecruiter(id, rid));
  }

  function bulkRejectCandidates(ids, refuseReasonId) {
    const rid = Number(refuseReasonId);
    if (!rid) throw new Error('refuseReasonId required');
    return _runBulk(ids, (id) => rejectCandidate(id, rid));
  }

  // ============================================================
  // Jobs
  // ============================================================

  function getJobOpenings(statusFilter) {
    const jobs = db.getAllJobs();
    const regions    = db.getAllRegions();
    const recruiters = db.getAllRecruiters();
    const candidates = db.getAllCandidates();
    const regionMap    = new Map(regions.map(r    => [r.id, r.name]));
    const recruiterMap = new Map(recruiters.map(r => [r.id, r.name]));

    return jobs
      .filter(j => !statusFilter || j.status === statusFilter)
      .map(j => ({
        ...j,
        region_name:    j.region_id    ? (regionMap.get(j.region_id)       || '') : '',
        recruiter_name: j.recruiter_id ? (recruiterMap.get(j.recruiter_id) || '') : '',
        candidate_count: candidates.filter(c => c.job_id === j.id && c.status === 'Active').length,
      }))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  function createJobOpening(data) {
    return db.appendJob({
      title:           data.title,
      department:      data.department || '',
      location:        data.location || '',
      region_id:       data.region_id != null ? data.region_id : null,
      status:          data.status,
      head_count:      data.head_count,
      filled:          data.filled != null ? data.filled : 0,
      recruiter_id:    data.recruiter_id != null ? data.recruiter_id : null,
      salary_range:    data.salary_range || '',
      posted_date:     data.posted_date  || todayStr(),
      closes_date:     data.closes_date  || '',
      posting_expires: data.posting_expires || '',
      notes:           data.notes || '',
      created_at:      nowStr(),
    });
  }

  function updateJobOpening(id, data) { db.updateJob(id, data); }

  function deleteJobOpening(id) {
    const hasCandidate = db.getAllCandidates().some(c => c.job_id === id);
    if (hasCandidate) {
      throw new Error('Cannot delete a job with existing candidates. Close the job instead.');
    }
    db.deleteJob(id);
  }

  // ============================================================
  // Dashboard
  // ============================================================

  function getDashboardData(filters) {
    const candidates    = db.getAllCandidates();
    const jobs          = db.getAllJobs();
    const stages        = db.getAllStages();
    const sources       = db.getAllSources();
    const regions       = db.getAllRegions();
    const recruiters    = db.getAllRecruiters();
    const refuseReasons = db.getAllRefuseReasons();
    const allHistory    = db.getAllHistory();

    const joinedCandidates = candidates.map(c =>
      joinCandidate(c, stages, jobs, recruiters, sources, regions, refuseReasons),
    );

    const recentHires = joinedCandidates
      .filter(c => c.status === 'Hired')
      .sort((a, b) =>
        new Date(b.date_last_stage_update).getTime() -
        new Date(a.date_last_stage_update).getTime(),
      )
      .slice(0, 20);

    return {
      kpis:                 computeKpis(candidates, jobs, stages, filters),
      pipelineSnapshot:     computePipelineSnapshot(candidates, stages, filters),
      funnelConversion:     computeFunnelConversion(allHistory, stages, filters),
      recruiterPerformance: computeRecruiterPerformance(candidates, recruiters, filters),
      sourceEffectiveness:  computeSourceEffectiveness(candidates, sources, filters),
      timeToHireTrend:      computeTimeToHireTrend(candidates),
      stageVelocity:        computeStageVelocity(allHistory, stages, filters),
      rejectionReasons:     computeRejectionReasons(candidates, refuseReasons, filters),
      slaBreaches:          computeSlaBreaches(candidates, stages, recruiters, jobs, filters),
      recentHires,
    };
  }

  function getRecruiterPerformance(filters, hiresFilters) {
    return computeRecruiterPerformance(
      db.getAllCandidates(), db.getAllRecruiters(), filters, hiresFilters,
    );
  }

  function getSourceEffectiveness(filters) {
    return computeSourceEffectiveness(db.getAllCandidates(), db.getAllSources(), filters);
  }

  function getAnalyticsHistorical(filters) {
    const candidates    = db.getAllCandidates();
    const stages        = db.getAllStages();
    const allHistory    = db.getAllHistory();
    const refuseReasons = db.getAllRefuseReasons();
    return {
      funnelConversion: computeFunnelConversion(allHistory, stages, filters),
      timeToHireTrend:  computeTimeToHireTrend(filterCandidates(candidates, filters)),
      stageVelocity:    computeStageVelocity(allHistory, stages, filters),
      rejectionReasons: computeRejectionReasons(candidates, refuseReasons, filters),
    };
  }

  function getWaterfallMetrics(filters) {
    return computeWaterfall(
      db.getAllCandidates(),
      db.getAllHistory(),
      db.getAllStages(),
      db.getAllJobs(),
      filters,
    );
  }

  function getRecentActivity(limit) {
    const history = db.getAllHistory().slice();
    history.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    return history.slice(0, Math.max(1, Math.min(200, limit | 0)));
  }

  function getRecentRejections(days, limit) {
    const cutoffMs = Date.now() - (days || 30) * 86400000;
    const cutoff = new Date(cutoffMs).toISOString().split('T')[0];
    return db.getAllCandidates()
      .filter(c => c.status === 'Rejected' && c.date_last_stage_update >= cutoff)
      .sort((a, b) => (b.date_last_stage_update || '').localeCompare(a.date_last_stage_update || ''))
      .slice(0, Math.max(1, Math.min(500, (limit || 100) | 0)))
      .map(c => joinCandidate(
        c, db.getAllStages(), db.getAllJobs(), db.getAllRecruiters(),
        db.getAllSources(), db.getAllRegions(), db.getAllRefuseReasons(),
      ));
  }

  function getRecentHires(days) {
    const cutoffMs = Date.now() - (days || 90) * 86400000;
    const cutoff = new Date(cutoffMs).toISOString().split('T')[0];
    return db.getAllCandidates()
      .filter(c => c.status === 'Hired' && c.date_last_stage_update >= cutoff)
      .map(c => joinCandidate(
        c, db.getAllStages(), db.getAllJobs(), db.getAllRecruiters(),
        db.getAllSources(), db.getAllRegions(), db.getAllRefuseReasons(),
      ));
  }

  function touchAppPresence() { return { ok: true }; }
  function getAppPresence()   { return [{ email: getCurrentUserEmail(), secondsAgo: 0, isSelf: true }]; }
  function touchPresence(_id) { return { ok: true }; }
  function getPresence(_id)   { return []; }
  function logClientError(_p) { return { ok: true }; }
  function getDebugInfo() {
    return {
      version: 'qa', user: getCurrentUserEmail(), serverTime: new Date().toISOString(),
      schema: { ok: true, errors: [] }, sampleCandidate: null,
      counts: {
        candidates: db.getAllCandidates().length, jobs: db.getAllJobs().length,
        history: db.getAllHistory().length, stages: db.getAllStages().length,
        sources: db.getAllSources().length, regions: db.getAllRegions().length,
        recruiters: db.getAllRecruiters().length,
      },
      failureCounters: {}, spreadsheetId: 'qa', scriptTimezone: 'UTC',
    };
  }

  function getSyncFingerprint() {
    const candidates = db.getAllCandidates();
    const jobs = db.getAllJobs();

    let maxCandidateId = 0;
    let latestStageUpdate = '';
    let activeCount = 0;
    for (const c of candidates) {
      if (c.id > maxCandidateId) maxCandidateId = c.id;
      if (c.date_last_stage_update > latestStageUpdate) latestStageUpdate = c.date_last_stage_update;
      if (c.status === 'Active') activeCount++;
    }

    const maxJobId = jobs.reduce((m, j) => Math.max(m, j.id), 0);

    return {
      sig: [
        candidates.length, activeCount, maxCandidateId,
        latestStageUpdate, jobs.length, maxJobId,
      ].join('|'),
      userEmail: getCurrentUserEmail(),
    };
  }

  return {
    ensureDefaultData,
    getSettings,
    saveStages,
    saveSources,
    saveRegions,
    saveRecruiters,
    saveRefuseReasons,
    saveWaterfallBenchmarks,
    getCurrentUserEmail: getCurrentUserEmailHandler,
    getCandidates,
    getCandidateDetail,
    findDuplicateCandidatesByEmail,
    createCandidate,
    updateCandidate,
    updateCandidateStage,
    rejectCandidate,
    deleteCandidate,
    assignRecruiter,
    updateKanbanState,
    updatePostHireStatus,
    bulkAdvanceStage,
    bulkAssignRecruiter,
    bulkRejectCandidates,
    getJobOpenings,
    createJobOpening,
    updateJobOpening,
    deleteJobOpening,
    getDashboardData,
    getRecruiterPerformance,
    getSourceEffectiveness,
    getAnalyticsHistorical,
    getWaterfallMetrics,
    getRecentActivity,
    getRecentHires,
    getRecentRejections,
    touchAppPresence,
    getAppPresence,
    touchPresence,
    getPresence,
    logClientError,
    getDebugInfo,
    getSyncFingerprint,
  };
}

module.exports = { makeHandlers };
