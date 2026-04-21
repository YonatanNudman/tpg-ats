/**
 * Bundles the pure-logic TypeScript modules (Helpers, Analytics, types,
 * SheetDB defaults) into a single CommonJS file for the QA harness.
 *
 * The QA server uses these via require() — they are the SAME functions the
 * GAS deployment runs, so any analytics/helpers bug surfaces here too.
 *
 * SheetDB.ts touches SpreadsheetApp, but we only need its DEFAULT_* exports.
 * We stub SpreadsheetApp/LockService/Session at require time.
 */
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const OUT_DIR = path.join(__dirname, '.bundle');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Single entry that re-exports everything we need.
const ENTRY = path.join(OUT_DIR, '_entry.ts');
fs.writeFileSync(
  ENTRY,
  `
export * from "../../src/Helpers";
export * from "../../src/Analytics";
export {
  DEFAULT_STAGES,
  DEFAULT_SOURCES,
  DEFAULT_REGIONS,
  DEFAULT_REFUSE_REASONS,
} from "../../src/SheetDB";
`,
);

esbuild.buildSync({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: path.join(OUT_DIR, 'logic.cjs'),
  // Stub the GAS globals that SheetDB.ts touches at module-eval time.
  // SheetDB constructor only runs if we instantiate it, which we don't.
  banner: {
    js: `
      globalThis.SpreadsheetApp = { openById: () => null, getActiveSpreadsheet: () => null };
      globalThis.Session = { getActiveUser: () => ({ getEmail: () => 'qa-user@tpg.local' }) };
      globalThis.LockService = { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) };
      globalThis.HtmlService = {};
    `,
  },
  logLevel: 'error',
});

console.log('Wrote', path.join(OUT_DIR, 'logic.cjs'));
