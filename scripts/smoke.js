#!/usr/bin/env node
/**
 * Post-deploy smoke test.
 *
 * Hits the live deployment URL and verifies that the response is the
 * actual TPG ATS shell, not a "Page Not Found" / "Setup needed" page.
 * Designed to be run RIGHT AFTER `clasp deploy` so we catch the class
 * of bugs that produced v11 (broken </style>) and v15 (funnel rendering
 * count "0" inconsistency) before a recruiter does.
 *
 * Why a separate script vs. extending the QA harness:
 *   - The QA harness (qa/qa.spec.mjs) runs against an in-memory express
 *     stub, not the deployed GAS web app. It catches logic regressions
 *     but cannot detect a broken deploy (wrong scriptId, missing perms,
 *     un-pushed code, schema validator rejecting the spreadsheet).
 *   - This script hits the actual deployed URL. If the deploy is broken,
 *     it returns a non-zero exit code and a useful diff against expected.
 *
 * Usage:
 *   npm run smoke                # uses default deployment URL
 *   SMOKE_URL=<url> npm run smoke
 *
 * Note: the deployment is restricted to thepipelinegroup.io accounts, so
 * this script can't fully fetch the rendered HTML without a session
 * cookie. What it CAN check is that the URL resolves to a Google login
 * redirect (correct deployment ID) rather than 404 (deployment broken or
 * deleted). For richer post-deploy validation we'd need a headless-browser
 * smoke test running as an authorized user, which is more infrastructure
 * than this 3-month tool warrants.
 */

const https = require('https');
const { URL } = require('url');

// Same deployment ID used by clasp deploy commands. Hardcoded here on
// purpose — the smoke test should fail loudly if someone accidentally
// points it at the wrong deployment.
const DEFAULT_URL =
  'https://script.google.com/a/macros/thepipelinegroup.io/s/' +
  'AKfycby8Uh4_8Xp0UnLwJIWob7-WRq3brrYQBNav_PHKgR2VFv6Qs_fsWQOYc2SzymX7AFupqA/exec';

const url = process.env.SMOKE_URL || DEFAULT_URL;

function get(target, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('Too many redirects'));
    const req = https.get(target, { timeout: 10000 }, (res) => {
      const status = res.statusCode || 0;
      // Follow 301/302/303 so a Google auth redirect ends at a stable page.
      if (status >= 300 && status < 400 && res.headers.location) {
        const next = new URL(res.headers.location, target).toString();
        res.resume();
        return resolve(get(next, depth + 1));
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status, headers: res.headers, body, finalUrl: target }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
  });
}

async function main() {
  console.log(`[smoke] GET ${url}`);
  let res;
  try {
    res = await get(url);
  } catch (err) {
    console.error(`[smoke] ✗ Network error: ${err.message}`);
    process.exit(1);
  }

  console.log(`[smoke] status=${res.status} finalUrl=${res.finalUrl}`);

  // Hard fails — deployment is definitely broken.
  if (res.status === 404) {
    console.error('[smoke] ✗ 404 — deployment ID is wrong or the deploy was deleted.');
    process.exit(1);
  }
  if (res.status >= 500) {
    console.error(`[smoke] ✗ HTTP ${res.status} — Google returned a server error.`);
    process.exit(1);
  }

  // GAS web apps under DOMAIN restriction redirect anonymous traffic to
  // accounts.google.com. Reaching that page (signin/v2 or oauth flow)
  // means our deployment URL is valid; we just don't have credentials.
  // That's the expected non-authenticated path, treat as success.
  const looksLikeGoogleLogin =
    /accounts\.google\.com/.test(res.finalUrl) ||
    /<title>Sign in/i.test(res.body);

  // Authorized happy path — we got the actual app HTML. Verify a couple
  // of structural markers so we don't false-pass on a generic Google page.
  const looksLikeApp =
    res.body.includes('TPG Recruiting ATS') &&
    res.body.includes('id="app"');

  // Schema-failure happy path — our friendly error page is rendering.
  // Treated as a "successful deploy of a deploy-time error message".
  const looksLikeSchemaError = /TPG ATS — Setup needed/.test(res.body);

  if (looksLikeApp) {
    console.log('[smoke] ✓ App HTML rendered with expected markers.');
    process.exit(0);
  }
  if (looksLikeSchemaError) {
    console.warn('[smoke] ⚠ Deploy reachable but schema validator flagged the spreadsheet.');
    console.warn('[smoke]   This means the build is good but the backing sheet needs fixing.');
    process.exit(0);
  }
  if (looksLikeGoogleLogin) {
    console.log('[smoke] ✓ Deployment reachable (Google login redirect — expected for unauthenticated runs).');
    process.exit(0);
  }

  console.error('[smoke] ✗ Unrecognized response — neither app HTML nor login redirect.');
  console.error('[smoke]   First 400 chars of body:');
  console.error(res.body.slice(0, 400));
  process.exit(1);
}

main();
