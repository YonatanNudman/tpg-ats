/**
 * serve-mock.js — Local static server that:
 *   1. Serves the frontend/ HTML files as if GAS rendered them
 *   2. Resolves `<?!= include('name') ?>` template tags by inlining the
 *      corresponding `frontend/name.html` file contents
 *   3. Injects a mock `window.google.script.run` shim with canned responses,
 *      so Playwright E2E tests can click through the app deterministically
 *
 * Run: node scripts/serve-mock.js [port]    (default 4321)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || process.env.PORT || '4321', 10);
const ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT, 'frontend');

// ── Mock shim injected before <?!= include('app.js') ?> ──────────────
// Replaces google.script.run with an in-memory test harness. The "db"
// state is keyed off the URL so Playwright specs can reset per-test via
// ?scenario=NAME query params.
const MOCK_SHIM = `
<script>
  // ── Mock data ──
  window.__MOCK_DB__ = {
    userEmail: 'test.recruiter@thepipelinegroup.io',
    stages: [
      { id: 1, name: 'Applied',        sequence: 100, color: '#1976d2', is_hired: false, is_rejected: false, is_offer: false, target_hours: 72,   is_enabled: true },
      { id: 2, name: 'Reviewed',       sequence: 200, color: '#039be5', is_hired: false, is_rejected: false, is_offer: false, target_hours: 96,   is_enabled: true },
      { id: 3, name: 'Contacted',      sequence: 300, color: '#26a69a', is_hired: false, is_rejected: false, is_offer: false, target_hours: 120,  is_enabled: true },
      { id: 4, name: 'Pre-screen',     sequence: 400, color: '#66bb6a', is_hired: false, is_rejected: false, is_offer: false, target_hours: 168,  is_enabled: true },
      { id: 5, name: 'Roleplay/CG',    sequence: 500, color: '#ffa726', is_hired: false, is_rejected: false, is_offer: false, target_hours: 240,  is_enabled: true },
      { id: 6, name: 'Final Interview',sequence: 600, color: '#ff7043', is_hired: false, is_rejected: false, is_offer: false, target_hours: 336,  is_enabled: true },
      { id: 7, name: 'Offer',          sequence: 700, color: '#8e24aa', is_hired: false, is_rejected: false, is_offer: true,  target_hours: 168,  is_enabled: true },
      { id: 8, name: 'Hired',          sequence: 800, color: '#4caf50', is_hired: true,  is_rejected: false, is_offer: false, target_hours: null, is_enabled: true },
      { id: 9, name: 'Rejected',       sequence: 900, color: '#e53935', is_hired: false, is_rejected: true,  is_offer: false, target_hours: null, is_enabled: true },
    ],
    sources: [
      { id: 1, name: 'LinkedIn',  medium: 'Direct',  default_motion: 'Inbound',  is_enabled: true },
      { id: 2, name: 'Indeed',    medium: 'Website', default_motion: 'Inbound',  is_enabled: true },
      { id: 3, name: 'Referral',  medium: 'Direct',  default_motion: 'Inbound',  is_enabled: true },
      { id: 4, name: 'Outbound',  medium: 'Direct',  default_motion: 'Outbound', is_enabled: true },
    ],
    regions: [
      { id: 1, name: 'US - East',     is_enabled: true },
      { id: 2, name: 'US - West',     is_enabled: true },
      { id: 3, name: 'Remote',        is_enabled: true },
    ],
    recruiters: [
      { id: 1, name: 'Alice Smith', email: 'alice@tpg.io', is_active: true },
      { id: 2, name: 'Bob Jones',   email: 'bob@tpg.io',   is_active: true },
    ],
    refuseReasons: [
      { id: 1, name: 'No-Show',          is_enabled: true },
      { id: 2, name: 'Withdrew',         is_enabled: true },
      { id: 3, name: 'Failed Assessment',is_enabled: true },
    ],
    jobs: [
      { id: 1, title: 'Senior BDR',    department: 'Sales',       location: 'NYC',       region_id: 1, status: 'Open',   head_count: 2, recruiter_id: 1,    salary_range: '$70k-$90k',  posted_date: '2026-04-01', closes_date: '', posting_expires: '2026-06-01', notes: '', created_at: '2026-04-01T00:00:00Z', recruiter_name: 'Alice Smith', region_name: 'US - East',    candidate_count: 2 },
      { id: 2, title: 'Account Exec',  department: 'Sales',       location: 'Remote',    region_id: 3, status: 'Open',   head_count: 1, recruiter_id: null, salary_range: '$90k-$120k', posted_date: '2026-04-05', closes_date: '', posting_expires: '', notes: '', created_at: '2026-04-05T00:00:00Z', recruiter_name: '', region_name: 'Remote', candidate_count: 1 },
      { id: 3, title: 'Ops Manager',   department: 'Operations',  location: 'SF',        region_id: 2, status: 'On Hold', head_count: 1, recruiter_id: 2,   salary_range: '$110k-$140k', posted_date: '2026-03-15', closes_date: '', posting_expires: '2025-01-01', notes: '', created_at: '2026-03-15T00:00:00Z', recruiter_name: 'Bob Jones',  region_name: 'US - West', candidate_count: 0 },
    ],
    candidates: [
      { id: 1, first_name: 'Jane',  last_name: 'Doe',      email: 'jane@ex.com',  phone: '555-0001', job_id: 1, stage_id: 2, recruiter_id: 1,    source_id: 1, region_id: 1, motion: 'Inbound',  status: 'Active',   rating: 4, linkedin_url: '', resume_url: '', notes: '', refuse_reason_id: null, kanban_state: 'Normal',  post_hire_status: '', date_applied: '2026-04-10', date_last_stage_update: '2026-04-15', created_by: 'alice@tpg.io', created_at: '2026-04-10T00:00:00Z', full_name: 'Jane Doe',  job_title: 'Senior BDR',   stage_name: 'Reviewed',   stage_color: '#039be5', recruiter_name: 'Alice Smith', source_name: 'LinkedIn', region_name: 'US - East', refuse_reason_name: '', days_in_stage: 6, days_since_applied: 11 },
      { id: 2, first_name: 'Mark',  last_name: 'Pilot',    email: 'mark@ex.com',  phone: '',         job_id: 1, stage_id: 4, recruiter_id: null, source_id: 2, region_id: 1, motion: 'Inbound',  status: 'Active',   rating: 3, linkedin_url: '', resume_url: '', notes: '', refuse_reason_id: null, kanban_state: 'Blocked', post_hire_status: '', date_applied: '2026-04-08', date_last_stage_update: '2026-04-18', created_by: 'alice@tpg.io', created_at: '2026-04-08T00:00:00Z', full_name: 'Mark Pilot', job_title: 'Senior BDR',   stage_name: 'Pre-screen', stage_color: '#66bb6a', recruiter_name: '',            source_name: 'Indeed',   region_name: 'US - East', refuse_reason_name: '', days_in_stage: 3, days_since_applied: 13 },
      { id: 3, first_name: 'Sarah', last_name: 'Outbound', email: 'sarah@ex.com', phone: '',         job_id: 2, stage_id: 1, recruiter_id: 2,    source_id: 4, region_id: 3, motion: 'Outbound', status: 'Active',   rating: 5, linkedin_url: '', resume_url: '', notes: '', refuse_reason_id: null, kanban_state: 'Ready',   post_hire_status: '', date_applied: '2026-04-20', date_last_stage_update: '2026-04-20', created_by: 'bob@tpg.io',   created_at: '2026-04-20T00:00:00Z', full_name: 'Sarah Outbound', job_title: 'Account Exec', stage_name: 'Applied', stage_color: '#1976d2', recruiter_name: 'Bob Jones', source_name: 'Outbound', region_name: 'Remote',     refuse_reason_name: '', days_in_stage: 1, days_since_applied: 1 },
      { id: 4, first_name: 'Peter', last_name: 'Hired',    email: 'peter@ex.com', phone: '',         job_id: 1, stage_id: 8, recruiter_id: 1,    source_id: 3, region_id: 1, motion: 'Inbound',  status: 'Hired',    rating: 5, linkedin_url: '', resume_url: '', notes: '', refuse_reason_id: null, kanban_state: 'Normal',  post_hire_status: 'Active', date_applied: '2026-02-01', date_last_stage_update: '2026-03-15', created_by: 'alice@tpg.io', created_at: '2026-02-01T00:00:00Z', full_name: 'Peter Hired', job_title: 'Senior BDR',  stage_name: 'Hired',     stage_color: '#4caf50', recruiter_name: 'Alice Smith', source_name: 'Referral', region_name: 'US - East', refuse_reason_name: '', days_in_stage: 37, days_since_applied: 79 },
      { id: 5, first_name: 'Rex',   last_name: 'Rejected', email: 'rex@ex.com',   phone: '',         job_id: 1, stage_id: 9, recruiter_id: 1,    source_id: 1, region_id: 1, motion: 'Inbound',  status: 'Rejected', rating: 2, linkedin_url: '', resume_url: '', notes: '', refuse_reason_id: 1,    kanban_state: 'Normal',  post_hire_status: '', date_applied: '2026-03-01', date_last_stage_update: '2026-04-01', created_by: 'alice@tpg.io', created_at: '2026-03-01T00:00:00Z', full_name: 'Rex Rejected', job_title: 'Senior BDR', stage_name: 'Rejected',  stage_color: '#e53935', recruiter_name: 'Alice Smith', source_name: 'LinkedIn', region_name: 'US - East', refuse_reason_name: 'No-Show', days_in_stage: 20, days_since_applied: 51 },
    ],
    history: [
      { id: 1, timestamp: '2026-04-10T10:00:00Z', candidate_id: 1, candidate_name: 'Jane Doe', job_id: 1, job_title: 'Senior BDR', stage_from_id: null, stage_from_name: '', stage_to_id: 1, stage_to_name: 'Applied', changed_by: 'alice@tpg.io', days_in_previous_stage: 0 },
      { id: 2, timestamp: '2026-04-15T14:30:00Z', candidate_id: 1, candidate_name: 'Jane Doe', job_id: 1, job_title: 'Senior BDR', stage_from_id: 1, stage_from_name: 'Applied', stage_to_id: 2, stage_to_name: 'Reviewed', changed_by: 'alice@tpg.io', days_in_previous_stage: 5 },
    ],
    nextId: 100,
    mutations: [],
  };

  // ── Mock google.script.run ──
  window.google = {
    script: {
      run: (function () {
        function clone(o) { return JSON.parse(JSON.stringify(o)); }
        function makeRunner(succ, fail) {
          var handlers = { success: succ || function(){}, failure: fail || function(){} };
          var runner = {
            withSuccessHandler: function (fn) { handlers.success = fn; return runner; },
            withFailureHandler: function (fn) { handlers.failure = fn; return runner; },
          };
          // Dynamically attach every function the frontend calls:
          [
            'getCurrentUserEmail', 'getSettings', 'getCandidates', 'getCandidateDetail',
            'createCandidate', 'updateCandidate', 'updateCandidateStage', 'rejectCandidate',
            'deleteCandidate', 'assignRecruiter', 'updateKanbanState', 'updatePostHireStatus',
            'getJobOpenings', 'createJobOpening', 'updateJobOpening', 'deleteJobOpening',
            'getDashboardData', 'getRecentHires', 'getSyncFingerprint',
            'saveStages', 'saveSources', 'saveRegions', 'saveRecruiters', 'saveRefuseReasons',
          ].forEach(function (fn) {
            runner[fn] = function () {
              var args = Array.prototype.slice.call(arguments);
              setTimeout(function () {
                try {
                  var r = window.__MOCK_DISPATCH__(fn, args);
                  handlers.success(r);
                } catch (e) {
                  handlers.failure({ message: e.message || String(e) });
                }
              }, 20);   // simulate network latency
              return undefined;
            };
          });
          return runner;
        }
        return {
          withSuccessHandler: function (fn) { return makeRunner(fn, null); },
          withFailureHandler: function (fn) { return makeRunner(null, fn); },
        };
      })(),
      history: {
        push:    function () {},
        setChangeHandler: function () {},
      },
    },
  };

  // ── Dispatch table for mocked GAS functions ──
  window.__MOCK_DISPATCH__ = function (fn, args) {
    var db = window.__MOCK_DB__;
    db.mutations.push({ fn: fn, args: args });
    // Local clone() so we don't leak mock state to callers (JSON round-trip is fine for plain data)
    function clone(o) { return JSON.parse(JSON.stringify(o)); }

    switch (fn) {
      case 'getCurrentUserEmail':
        return db.userEmail;

      case 'getSettings':
        return {
          stages: db.stages, sources: db.sources, regions: db.regions,
          recruiters: db.recruiters, refuseReasons: db.refuseReasons,
        };

      case 'getCandidates': {
        var filters = args[0] || {};
        var list = db.candidates.slice();
        if (filters.status) list = list.filter(function (c) { return c.status === filters.status; });
        if (filters.jobId)  list = list.filter(function (c) { return c.job_id === filters.jobId; });
        if (filters.stageId)   list = list.filter(function (c) { return c.stage_id === filters.stageId; });
        if (filters.recruiterId && filters.recruiterId !== '__unassigned__') {
          list = list.filter(function (c) { return c.recruiter_id == filters.recruiterId; });
        }
        return list;
      }

      case 'getCandidateDetail': {
        var id = args[0];
        var c = db.candidates.find(function (x) { return x.id === id; });
        if (!c) throw new Error('Candidate ' + id + ' not found');
        var hist = db.history.filter(function (h) { return h.candidate_id === id; })
          .sort(function (a, b) { return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(); });
        return { candidate: clone(c), history: clone(hist) };
      }

      case 'createCandidate': {
        var data = args[0];
        var newId = ++db.nextId;
        var job = db.jobs.find(function (j) { return j.id === data.job_id; });
        var stage = db.stages[0];
        var today = new Date().toISOString().split('T')[0];
        var newC = {
          id: newId,
          first_name: data.first_name, last_name: data.last_name,
          email: data.email, phone: data.phone || '',
          job_id: data.job_id, stage_id: stage.id, recruiter_id: null,
          source_id: data.source_id || null, region_id: data.region_id || null,
          motion: data.motion || 'Inbound', status: 'Active', rating: 0,
          linkedin_url: data.linkedin_url || '', resume_url: '', notes: data.notes || '',
          refuse_reason_id: null, kanban_state: 'Normal', post_hire_status: '',
          date_applied: today, date_last_stage_update: today,
          created_by: db.userEmail, created_at: new Date().toISOString(),
          full_name: data.first_name + ' ' + data.last_name,
          job_title: job ? job.title : '',
          stage_name: stage.name, stage_color: stage.color,
          recruiter_name: '', source_name: '', region_name: '', refuse_reason_name: '',
          days_in_stage: 0, days_since_applied: 0,
        };
        db.candidates.push(newC);
        return newC;
      }

      case 'updateCandidate': {
        var id2 = args[0], updates = args[1];
        var c2 = db.candidates.find(function (x) { return x.id === id2; });
        if (!c2) throw new Error('Candidate ' + id2 + ' not found');
        Object.assign(c2, updates);
        // re-join denormalised fields
        if (updates.recruiter_id !== undefined) {
          var r = db.recruiters.find(function (x) { return x.id == updates.recruiter_id; });
          c2.recruiter_name = r ? r.name : '';
        }
        if (updates.source_id !== undefined) {
          var s = db.sources.find(function (x) { return x.id == updates.source_id; });
          c2.source_name = s ? s.name : '';
        }
        if (updates.region_id !== undefined) {
          var rg = db.regions.find(function (x) { return x.id == updates.region_id; });
          c2.region_name = rg ? rg.name : '';
        }
        return;
      }

      case 'updateCandidateStage': {
        var idS = args[0], newStageId = args[1];
        var cS = db.candidates.find(function (x) { return x.id === idS; });
        if (!cS) throw new Error('Candidate ' + idS + ' not found');
        var newStage = db.stages.find(function (x) { return x.id === newStageId; });
        db.history.push({
          id: ++db.nextId, timestamp: new Date().toISOString(),
          candidate_id: idS, candidate_name: cS.full_name,
          job_id: cS.job_id, job_title: cS.job_title,
          stage_from_id: cS.stage_id, stage_from_name: cS.stage_name,
          stage_to_id: newStageId, stage_to_name: newStage.name,
          changed_by: db.userEmail, days_in_previous_stage: cS.days_in_stage,
        });
        cS.stage_id = newStageId;
        cS.stage_name = newStage.name;
        cS.stage_color = newStage.color;
        cS.date_last_stage_update = new Date().toISOString().split('T')[0];
        cS.days_in_stage = 0;
        if (newStage.is_hired) cS.status = 'Hired';
        else if (newStage.is_rejected) cS.status = 'Rejected';
        return;
      }

      case 'rejectCandidate': {
        var idR = args[0], reasonId = args[1];
        var cR = db.candidates.find(function (x) { return x.id === idR; });
        if (!cR) throw new Error('Candidate ' + idR + ' not found');
        var rejStage = db.stages.find(function (s) { return s.is_rejected; });
        cR.stage_id = rejStage.id;
        cR.stage_name = rejStage.name;
        cR.stage_color = rejStage.color;
        cR.status = 'Rejected';
        cR.refuse_reason_id = reasonId;
        return;
      }

      case 'deleteCandidate': {
        var idD = args[0];
        db.candidates = db.candidates.filter(function (c) { return c.id !== idD; });
        return;
      }

      case 'getJobOpenings': {
        var statusFilter = args[0];
        return statusFilter
          ? db.jobs.filter(function (j) { return j.status === statusFilter; })
          : db.jobs.slice();
      }

      case 'createJobOpening': {
        var jd = args[0];
        var newJ = Object.assign({ id: ++db.nextId, created_at: new Date().toISOString(), candidate_count: 0 }, jd);
        db.jobs.push(newJ);
        return newJ;
      }

      case 'updateJobOpening': {
        var jid = args[0], jud = args[1];
        var j = db.jobs.find(function (x) { return x.id === jid; });
        if (j) Object.assign(j, jud);
        return;
      }

      case 'deleteJobOpening': {
        var jidd = args[0];
        var hasCand = db.candidates.some(function (c) { return c.job_id === jidd; });
        if (hasCand) throw new Error('Cannot delete a job with existing candidates. Close the job instead.');
        db.jobs = db.jobs.filter(function (x) { return x.id !== jidd; });
        return;
      }

      case 'getDashboardData': {
        var active = db.candidates.filter(function (c) { return c.status === 'Active'; });
        var hired = db.candidates.filter(function (c) { return c.status === 'Hired'; });
        return {
          kpis: {
            activeCandidates: active.length,
            openPositions: db.jobs.filter(function (j) { return j.status === 'Open'; }).length,
            hiresThisPeriod: hired.length,
            slaBreaches: 0,
            avgDaysToHire: 45,
            offerAcceptanceRate: 66.7,
            expiredPostings: db.jobs.filter(function (j) { return j.posting_expires && new Date(j.posting_expires).getTime() < Date.now(); }).length,
            expiringPostings: 0,
          },
          pipelineSnapshot: db.stages.filter(function (s) { return s.is_enabled && !s.is_rejected; }).map(function (s) {
            return { stage_id: s.id, stage_name: s.name, stage_color: s.color, sequence: s.sequence,
                     candidate_count: active.filter(function (c) { return c.stage_id === s.id; }).length };
          }),
          funnelConversion: [
            { stage_id: 1, stage_name: 'Applied',   sequence: 100, entered_count: 5, conversion_rate: 100 },
            { stage_id: 2, stage_name: 'Reviewed',  sequence: 200, entered_count: 3, conversion_rate: 60 },
            { stage_id: 4, stage_name: 'Pre-screen',sequence: 400, entered_count: 2, conversion_rate: 40 },
            { stage_id: 8, stage_name: 'Hired',     sequence: 800, entered_count: 1, conversion_rate: 20 },
          ],
          recruiterPerformance: db.recruiters.map(function (r) {
            var myCs = db.candidates.filter(function (c) { return c.recruiter_id === r.id; });
            return { recruiter_id: r.id, recruiter_name: r.name,
                     total_candidates: myCs.length,
                     active_candidates: myCs.filter(function (c) { return c.status === 'Active'; }).length,
                     hires: myCs.filter(function (c) { return c.status === 'Hired'; }).length,
                     rejections: myCs.filter(function (c) { return c.status === 'Rejected'; }).length,
                     avg_days_to_hire: myCs.filter(function (c) { return c.status === 'Hired'; }).length > 0 ? 42 : 0 };
          }),
          sourceEffectiveness: db.sources.map(function (s) {
            var srcCs = db.candidates.filter(function (c) { return c.source_id === s.id; });
            var h = srcCs.filter(function (c) { return c.status === 'Hired'; }).length;
            return { source_id: s.id, source_name: s.name, medium: s.medium,
                     total_candidates: srcCs.length, hired_candidates: h,
                     hire_rate: srcCs.length > 0 ? Math.round((h / srcCs.length) * 100) : 0 };
          }),
          timeToHireTrend: [
            { month_label: 'Nov 2025', avg_days_to_hire: 50 },
            { month_label: 'Dec 2025', avg_days_to_hire: 47 },
            { month_label: 'Jan 2026', avg_days_to_hire: 45 },
            { month_label: 'Feb 2026', avg_days_to_hire: 42 },
            { month_label: 'Mar 2026', avg_days_to_hire: 44 },
            { month_label: 'Apr 2026', avg_days_to_hire: 45 },
          ],
          stageVelocity: db.stages.filter(function (s) { return s.is_enabled; }).map(function (s) {
            return { stage_id: s.id, stage_name: s.name, stage_color: s.color,
                     avg_days_in_stage: Math.round(s.sequence / 100),
                     candidate_count: db.candidates.filter(function (c) { return c.stage_id === s.id; }).length };
          }),
          slaBreaches: [],
          recentHires: hired,
        };
      }

      case 'getSyncFingerprint':
        return { sig: String(db.candidates.length) + '|' + String(db.jobs.length) + '|' + String(db.history.length), userEmail: db.userEmail };

      case 'saveStages':       db.stages = args[0];        return;
      case 'saveSources':      db.sources = args[0];       return;
      case 'saveRegions':      db.regions = args[0];       return;
      case 'saveRecruiters':   db.recruiters = args[0];    return;
      case 'saveRefuseReasons':db.refuseReasons = args[0]; return;

      default:
        throw new Error('Unmocked GAS call: ' + fn);
    }
  };
</script>
`;

// ── Template include resolver ────────────────────────────────────────
function resolveIncludes(html) {
  // Replace all <?!= include('NAME') ?> with contents of frontend/NAME.html
  return html.replace(/<\?!?\=\s*include\(['"]([^'"]+)['"]\)\s*\?>/g, function (_m, name) {
    var file = path.join(FRONTEND_DIR, name + (name.endsWith('.html') ? '' : '.html'));
    // app.js → app.js.html, styles.css → styles.css.html
    if (!fs.existsSync(file)) {
      var altFile = path.join(FRONTEND_DIR, name + '.html');
      if (fs.existsSync(altFile)) file = altFile;
      else return '<!-- include not found: ' + name + ' -->';
    }
    return resolveIncludes(fs.readFileSync(file, 'utf8'));
  });
}

// ── HTTP server ──────────────────────────────────────────────────────
const server = http.createServer(function (req, res) {
  var url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    var indexPath = path.join(FRONTEND_DIR, 'index.html');
    var html = resolveIncludes(fs.readFileSync(indexPath, 'utf8'));
    // Inject the mock shim BEFORE the first <script defer Alpine...>
    // Use function form so `$` chars inside MOCK_SHIM (e.g. "$90k-$120k") aren't
    // treated as regex backreferences — that was silently corrupting the shim.
    html = html.replace(
      /(<script defer[^>]*alpinejs[^>]*><\/script>)/,
      function (_match, alpineTag) { return MOCK_SHIM + "\n" + alpineTag; }
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // 404
  res.writeHead(404);
  res.end('not found: ' + url);
});

server.listen(PORT, function () {
  console.log('Mock ATS server running at http://localhost:' + PORT);
});
