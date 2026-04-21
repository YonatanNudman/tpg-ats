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
