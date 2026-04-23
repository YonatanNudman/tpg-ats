/**
 * QA Harness server.
 *
 * Mirrors what doGet() does in the production GAS deploy:
 *   - Calls ensureDefaultData() to seed pipeline stages, sources, regions, reasons.
 *   - Resolves <?!= include('foo') ?> tags from the index.html template by
 *     inlining the matching frontend/foo.html partial.
 *
 * Adds a thin /api/:fn POST endpoint and a tiny google.script.run shim
 * injected into the served HTML so the Alpine.js front-end runs UNCHANGED.
 *
 * Single in-memory MockSheetDB persists for the life of the process.
 */
const path = require('path');
const fs = require('fs');
const express = require('express');

const { MockSheetDB } = require('./mock-db');
const { makeHandlers } = require('./handlers');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');

const db = new MockSheetDB();
const handlers = makeHandlers(db);
handlers.ensureDefaultData();

// Seed a couple of recruiters so dropdowns aren't empty by default — DEFAULT_*
// in src/SheetDB.ts only seeds stages/sources/regions/reasons.
handlers.saveRecruiters([
  { id: 0, name: 'Alex Recruiter',  email: 'alex@tpg.local',  is_active: true  },
  { id: 0, name: 'Jordan Sourcer',  email: 'jordan@tpg.local', is_active: true  },
]);

// ---------- Template renderer ----------
// Resolves: <?!= include('app.js') ?> → contents of frontend/app.js.html
// (matches the GAS HtmlService.createHtmlOutputFromFile contract)
function renderIndex() {
  const indexPath = path.join(FRONTEND, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  html = html.replace(/<\?!=\s*include\(['"]([^'"]+)['"]\)\s*\?>/g, (_, name) => {
    const partialPath = path.join(FRONTEND, `${name}.html`);
    if (!fs.existsSync(partialPath)) {
      return `<!-- include not found: ${name} -->`;
    }
    return fs.readFileSync(partialPath, 'utf8');
  });

  // Inject google.script.run shim BEFORE the bundled <script> tags load.
  // The shim posts to /api/:fn and resolves the success/failure handler chain
  // exactly the way GAS does for the production deploy.
  const shim = `
<script>
window.google = window.google || {};
window.google.script = window.google.script || {};
window.google.script.run = (function () {
  function makeRunner(success, failure) {
    var runner = {};
    var fnNames = [
      'ensureDefaultData','getSettings','saveStages','saveSources','saveRegions',
      'saveRecruiters','saveRefuseReasons','getCurrentUserEmail','getCandidates',
      'getCandidateDetail','createCandidate','updateCandidate','updateCandidateStage',
      'rejectCandidate','deleteCandidate','getJobOpenings','createJobOpening',
      'updateJobOpening','deleteJobOpening','getDashboardData','getSyncFingerprint',
      'getRecruiterPerformance','getSourceEffectiveness','getAnalyticsHistorical',
      'getWaterfallMetrics',
      'getRecentActivity','getRecentHires','getRecentRejections','findDuplicateCandidatesByEmail',
      'touchAppPresence','getAppPresence','touchPresence','getPresence',
      'bulkAdvanceStage','bulkAssignRecruiter','bulkRejectCandidates',
      'updateKanbanState','updatePostHireStatus','assignRecruiter',
      'logClientError','getDebugInfo',
    ];
    runner.withSuccessHandler = function (cb) { return makeRunner(cb, failure); };
    runner.withFailureHandler = function (cb) { return makeRunner(success, cb); };
    fnNames.forEach(function (fn) {
      runner[fn] = function () {
        var args = Array.prototype.slice.call(arguments);
        fetch('/api/' + fn, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ args: args }),
        }).then(function (r) {
          return r.json().then(function (body) { return { ok: r.ok, body: body }; });
        }).then(function (res) {
          if (res.ok) {
            if (success) success(res.body.result);
          } else {
            if (failure) failure(new Error(res.body.error || 'Unknown error'));
            else console.error('GAS shim error:', res.body.error);
          }
        }).catch(function (err) {
          if (failure) failure(err);
          else console.error('GAS shim network error:', err);
        });
      };
    });
    return runner;
  }
  return makeRunner(null, null);
})();
</script>`;

  // Inject just before the closing </head> so the shim is defined before any
  // <script> in the body executes.
  html = html.replace('</head>', shim + '\n</head>');
  return html;
}

// ---------- HTTP server ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.type('html').send(renderIndex());
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/api/:fn', (req, res) => {
  const fn = req.params.fn;
  if (!Object.prototype.hasOwnProperty.call(handlers, fn)) {
    return res.status(404).json({ error: `Unknown handler: ${fn}` });
  }
  try {
    const args = (req.body && Array.isArray(req.body.args)) ? req.body.args : [];
    const result = handlers[fn](...args);
    res.json({ result: result == null ? null : result });
  } catch (err) {
    console.error(`[QA] handler ${fn} threw:`, err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Convenience endpoint to inspect server-side state from the QA test
app.get('/__qa/state', (_req, res) => {
  res.json({
    candidates: db.getAllCandidates(),
    jobs:       db.getAllJobs(),
    history:    db.getAllHistory(),
    stages:     db.getAllStages(),
    sources:    db.getAllSources(),
    regions:    db.getAllRegions(),
    recruiters: db.getAllRecruiters(),
    refuseReasons: db.getAllRefuseReasons(),
  });
});

const PORT = Number(process.env.QA_PORT) || 4567;
const server = app.listen(PORT, () => {
  console.log(`[QA] server listening on http://localhost:${PORT}`);
});

function shutdown(signal) {
  console.log(`[QA] received ${signal}, shutting down…`);
  server.close(() => process.exit(0));
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
