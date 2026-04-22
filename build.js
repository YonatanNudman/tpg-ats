/**
 * build.js — Bundle all TypeScript sources into a single .gs file
 * ready for Google Apps Script deployment via clasp.
 *
 * Uses esbuild to bundle src/Code.ts + its transitive imports into one file,
 * then strips ES module syntax that GAS doesn't understand.
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const DIST = path.join(__dirname, 'dist');
const FRONTEND_DEST = path.join(DIST, 'frontend');

// ---- Ensure dist/ exists and is clean ----
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });
fs.mkdirSync(FRONTEND_DEST, { recursive: true });

// ---- 1. Bundle TypeScript → single .js file ----
// Disable tree-shaking: GAS calls top-level functions (doGet, include, saveStages,
// etc.) by name from the outside, so esbuild must not drop them as "unused".
// keepNames preserves function/class names for stack traces.
esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'src/Code.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2019',
  platform: 'neutral',
  outfile: path.join(DIST, 'Code.js'),
  treeShaking: false,
  keepNames: true,
  logLevel: 'info',
});

// ---- 2. Post-process: strip ESM syntax that GAS can't parse ----
let bundled = fs.readFileSync(path.join(DIST, 'Code.js'), 'utf8');

// Remove all "export" keywords (GAS has a single global scope)
bundled = bundled.replace(/^export\s+/gm, '');
bundled = bundled.replace(/\bexport\s+\{[^}]*\};?\s*$/gm, '');
bundled = bundled.replace(/\bexport\s+default\s+/g, '');

fs.writeFileSync(path.join(DIST, 'Code.js'), bundled);

// ---- 3. Copy frontend/*.html → dist/frontend/ ----
const frontendSrc = path.join(__dirname, 'frontend');
for (const file of fs.readdirSync(frontendSrc)) {
  const srcPath = path.join(frontendSrc, file);
  const destPath = path.join(FRONTEND_DEST, file);
  if (fs.statSync(srcPath).isFile() && file.endsWith('.html')) {
    fs.copyFileSync(srcPath, destPath);
  }
}

// ---- 3b. Structural sanity checks on the copied frontend ----
// Catches the class of bugs that produced v11 (a stray </style> mid-file
// leaked 68 lines of raw CSS into the page body as text). Cheap to run
// every build; failing here is much friendlier than discovering the same
// issue from a recruiter's screenshot post-deploy.
//
// The checks are intentionally conservative — they verify structural
// invariants the deployed app cannot survive without, NOT visual quality.
// A failure here means "this build will render broken", not "stylistic
// nit". To bypass during local experimentation, set SKIP_BUILD_CHECKS=1.
function checkFrontendStructure() {
  const errors = [];

  function check(filename, predicate, message) {
    const filepath = path.join(FRONTEND_DEST, filename);
    if (!fs.existsSync(filepath)) {
      errors.push(`${filename}: file missing from dist/`);
      return;
    }
    const content = fs.readFileSync(filepath, 'utf8');
    if (!predicate(content)) errors.push(`${filename}: ${message}`);
  }

  // styles.css.html: exactly one <style> and one </style>, with </style>
  // at the very end. Extra closing tags mid-file render the rest as body text.
  check('styles.css.html',
    s => (s.match(/<style>/g) || []).length === 1,
    'expected exactly one <style> opening tag');
  check('styles.css.html',
    s => (s.match(/<\/style>/g) || []).length === 1,
    'expected exactly one </style> closing tag');
  check('styles.css.html',
    s => /<\/style>\s*$/.test(s),
    '</style> must be at end of file (anything after leaks into the page body as text)');

  // app.js.html: must be wrapped in a single <script>...</script> block.
  check('app.js.html',
    s => (s.match(/<script>/g) || []).length === 1 &&
         (s.match(/<\/script>/g) || []).length === 1,
    'expected exactly one <script>/</script> pair');
  check('app.js.html',
    s => /<\/script>\s*$/.test(s),
    '</script> must be at end of file');

  // index.html: required mounting points the app cannot start without.
  check('index.html', s => s.includes('id="app"'),     'missing #app root mount');
  check('index.html', s => s.includes("x-data=\"atsApp()\""), 'missing atsApp() x-data on #app');
  check('index.html', s => s.includes("x-init=\"init()\""),   'missing x-init on #app');
  check('index.html', s => s.includes("include('styles.css')"), 'missing styles.css include');
  check('index.html', s => s.includes("include('app.js')"),     'missing app.js include');

  // index.html: each top-level dashboard section must be present, since
  // removing one accidentally would visibly break the funnel-primary layout.
  const REQUIRED_SECTIONS = [
    ['funnel-card',          'Pipeline Funnel section'],
    ['recruiter-perf-card',  'Recruiter Performance section'],
    ['source-roi-card',      'Sourcing ROI section'],
  ];
  for (const [cls, label] of REQUIRED_SECTIONS) {
    check('index.html',
      s => s.includes(cls),
      `missing ${label} (.${cls})`);
  }

  // Code.js: bundled output must expose doGet (GAS web-app entry point).
  // Without this, the deployment URL returns "Script function not found".
  const codeJs = fs.readFileSync(path.join(DIST, 'Code.js'), 'utf8');
  if (!/function\s+doGet\s*\(/.test(codeJs)) {
    errors.push('Code.js: missing doGet() — web app would 404 after deploy');
  }

  if (errors.length > 0) {
    console.error('\n[build.js] Structural sanity checks FAILED:');
    for (const e of errors) console.error('  ✗ ' + e);
    if (process.env.SKIP_BUILD_CHECKS === '1') {
      console.warn('\n[build.js] Continuing anyway because SKIP_BUILD_CHECKS=1.');
    } else {
      console.error('\n[build.js] Aborting. Set SKIP_BUILD_CHECKS=1 to bypass.\n');
      process.exit(1);
    }
  } else {
    console.log('[build.js] Structural sanity: ok');
  }
}
checkFrontendStructure();

// ---- 4. Copy appsscript.json → dist/ ----
fs.copyFileSync(
  path.join(__dirname, 'appsscript.json'),
  path.join(DIST, 'appsscript.json')
);

// ---- Report ----
const files = fs.readdirSync(DIST, { recursive: true });
console.log('\nBuilt to dist/:');
for (const f of files) console.log('  ' + f);
console.log(`\nCode.js: ${(fs.statSync(path.join(DIST, 'Code.js')).size / 1024).toFixed(1)} KB`);
