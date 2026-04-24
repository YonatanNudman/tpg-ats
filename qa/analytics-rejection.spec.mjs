/**
 * QA spec: Analytics section shows the "Rejected" column on Stage Velocity
 * AND a Rejection Reasons panel, populated from real data.
 *
 * Boots the QA harness (in-memory ISheetDB), seeds a job + 4 candidates,
 * rejects 3 of them with two distinct refuse reasons, then asserts the
 * Analytics UI surfaces both the per-stage rejection count and the
 * top-reasons breakdown.
 *
 * Why this exists: the user reported "I don't see the Rejected column"
 * after a deploy that should have shipped it. Manual eyeballing wasn't
 * giving us certainty (cache, iframe, build mismatch, render bug — many
 * candidate explanations). This spec proves the column renders against
 * the same logic + HTML the production deploy uses, taking the cache
 * theory off the table either way.
 */
import { chromium } from 'playwright';

const BASE = process.env.QA_URL || 'http://localhost:4567';

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
}

async function settle(page, ms = 350) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

async function call(page, fn, ...args) {
  return await page.evaluate(({ fn, args }) => {
    return new Promise((resolve, reject) => {
      google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(reject)[fn](...args);
    });
  }, { fn, args });
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const tag = Date.now();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push('[console] ' + msg.text());
  });

  await page.goto(BASE);
  await page.waitForSelector('#app');
  await settle(page, 900);

  // ── Seed test data ─────────────────────────────────────────
  // 1 job, 4 candidates, reject 3 (2 with reason A, 1 with reason B)
  const job = await call(page, 'createJobOpening', {
    title: `Analytics Rejection Test ${tag}`, department: 'QA', location: 'Remote',
    status: 'Open', head_count: 5, filled: 0,
  });
  const c1 = await call(page, 'createCandidate', {
    first_name: 'Active', last_name: `T${tag}`, email: `c1-${tag}@example.com`,
    phone: '', job_id: job.id, motion: 'Inbound',
  });
  const c2 = await call(page, 'createCandidate', {
    first_name: 'Reject1', last_name: `T${tag}`, email: `c2-${tag}@example.com`,
    phone: '', job_id: job.id, motion: 'Inbound',
  });
  const c3 = await call(page, 'createCandidate', {
    first_name: 'Reject2', last_name: `T${tag}`, email: `c3-${tag}@example.com`,
    phone: '', job_id: job.id, motion: 'Inbound',
  });
  const c4 = await call(page, 'createCandidate', {
    first_name: 'Reject3', last_name: `T${tag}`, email: `c4-${tag}@example.com`,
    phone: '', job_id: job.id, motion: 'Inbound',
  });

  const reasons = await page.evaluate(
    () => Alpine.store('app').settings.refuseReasons.filter(r => r.is_enabled)
  );
  assert(reasons.length >= 2, `need >= 2 enabled refuse reasons, got ${reasons.length}`);
  const reasonA = reasons[0];
  const reasonB = reasons[1];

  await call(page, 'rejectCandidate', c2.id, reasonA.id);
  await call(page, 'rejectCandidate', c3.id, reasonA.id);
  await call(page, 'rejectCandidate', c4.id, reasonB.id);

  // Force reloadAll so analytics refresh
  await page.evaluate(async () => {
    const root = Alpine.$data(document.querySelector('#app'));
    await root.reloadAll();
  });
  await settle(page, 700);

  // ── Open the Analytics section ─────────────────────────────
  await page.evaluate(() => {
    const root = Alpine.$data(document.querySelector('#app'));
    root.showAnalytics = true;
  });
  await settle(page, 500);

  // ── ASSERTION 1: Stage Velocity table has a "Rejected" column ─
  const velocityHeaders = await page.evaluate(() => {
    // Find the panel by header text, then read its <th> contents
    const panels = Array.from(document.querySelectorAll('.analytics-panel'));
    const sv = panels.find(p =>
      (p.querySelector('.panel-header')?.textContent || '').trim() === 'Stage Velocity'
    );
    if (!sv) return null;
    return Array.from(sv.querySelectorAll('thead th')).map(th => th.textContent.trim());
  });
  console.log('Stage Velocity headers:', velocityHeaders);
  assert(velocityHeaders, 'Stage Velocity panel not found in DOM');
  assert(
    velocityHeaders.includes('Rejected'),
    `Stage Velocity missing "Rejected" column. Headers: ${JSON.stringify(velocityHeaders)}`
  );

  // ── ASSERTION 2: Rejection Reasons panel exists with correct counts ─
  const reasonsState = await page.evaluate(() => {
    const root = Alpine.$data(document.querySelector('#app'));
    return root.analytics.rejectionReasons;
  });
  console.log('analytics.rejectionReasons (state):', reasonsState);
  assert(Array.isArray(reasonsState), 'analytics.rejectionReasons is not an array');
  assert(reasonsState.length >= 2, `expected >= 2 reasons in state, got ${reasonsState.length}`);

  const reasonsPanelExists = await page.evaluate(() => {
    // Use .includes() rather than strict equality — the panel header now
    // carries a "(N total)" suffix as metadata, so an exact-match check
    // would falsely report the panel missing.
    const panels = Array.from(document.querySelectorAll('.analytics-panel'));
    return panels.some(p =>
      (p.querySelector('.panel-header')?.textContent || '').includes('Rejection Reasons')
    );
  });
  assert(reasonsPanelExists, 'Rejection Reasons panel not rendered in DOM');

  // ── ASSERTION 3: Counts match what we seeded ───────────────
  // We rejected: 2 with reasonA, 1 with reasonB
  const reasonAEntry = reasonsState.find(r => r.reason_id === reasonA.id);
  const reasonBEntry = reasonsState.find(r => r.reason_id === reasonB.id);
  assert(reasonAEntry, `reason A (id=${reasonA.id}, ${reasonA.name}) not in results`);
  assert(reasonBEntry, `reason B (id=${reasonB.id}, ${reasonB.name}) not in results`);
  assert(
    reasonAEntry.count >= 2,
    `reason A count expected >=2 (we just rejected 2), got ${reasonAEntry.count}`
  );
  assert(
    reasonBEntry.count >= 1,
    `reason B count expected >=1 (we just rejected 1), got ${reasonBEntry.count}`
  );

  // ── ASSERTION 3b: Rejection Reasons panel shows a total ────
  // Total = sum of all reason counts. Surfaces in the panel header
  // ("(N total)") and as a footer row in the table.
  const totalsInDom = await page.evaluate(() => {
    const panels = Array.from(document.querySelectorAll('.analytics-panel'));
    const rr = panels.find(p =>
      (p.querySelector('.panel-header')?.textContent || '').includes('Rejection Reasons')
    );
    if (!rr) return null;
    const headerText = rr.querySelector('.panel-header')?.textContent || '';
    const headerMatch = headerText.match(/\((\d+)\s*total\)/);
    const footerCell = rr.querySelector('tfoot .data-table-total-row td:last-child');
    return {
      headerTotal: headerMatch ? Number(headerMatch[1]) : null,
      footerTotal: footerCell ? Number(footerCell.textContent.trim()) : null,
    };
  });
  console.log('Rejection Reasons totals:', totalsInDom);
  assert(totalsInDom, 'could not locate Rejection Reasons panel for total check');
  assert(
    totalsInDom.headerTotal !== null,
    `header total not found in "Rejection Reasons" header text`
  );
  // We rejected 3 candidates total in this seed — header should reflect at least that.
  // (Could be more if previous test runs left data; the harness state isn't reset.)
  assert(
    totalsInDom.headerTotal >= 3,
    `header total expected >= 3 (we rejected 3), got ${totalsInDom.headerTotal}`
  );
  assert(
    totalsInDom.footerTotal === totalsInDom.headerTotal,
    `footer total (${totalsInDom.footerTotal}) should match header total (${totalsInDom.headerTotal})`
  );

  // ── ASSERTION 4: Stage Velocity rejected_count matches ─────
  // All 3 rejected candidates were in the first stage when rejected.
  const velocityState = await page.evaluate(() => {
    const root = Alpine.$data(document.querySelector('#app'));
    return root.analytics.stageVelocity;
  });
  console.log('analytics.stageVelocity (state):', velocityState);
  assert(Array.isArray(velocityState), 'stageVelocity is not an array');
  // First stage (Applied / equivalent) should show 3 rejected
  const firstStage = velocityState[0];
  assert(firstStage, 'no stages returned in stageVelocity');
  assert(
    typeof firstStage.rejected_count === 'number',
    `rejected_count missing/wrong type on first stage. Got: ${JSON.stringify(firstStage)}`
  );
  assert(
    firstStage.rejected_count >= 3,
    `first stage rejected_count expected >=3 (we rejected 3 from stage 1), got ${firstStage.rejected_count}`
  );

  // ── No JS errors RELATED TO THE ANALYTICS/REJECTION CODE ────
  // Filter out known unrelated noise — e.g. `waterfallGhostWidth is not
  // defined` from the waterfall section is a pre-existing issue and
  // shouldn't fail this spec, which is about the analytics rejection panel.
  const KNOWN_UNRELATED = [
    /waterfallGhostWidth is not defined/i,
    /Script error\.?$/i,   // cross-origin generic; matches no useful info
  ];
  const relevantErrors = errors.filter(e =>
    !KNOWN_UNRELATED.some(re => re.test(e))
  );
  if (relevantErrors.length) {
    console.error('JS errors during test:', relevantErrors);
    throw new Error(`${relevantErrors.length} JS error(s) during test — see log above`);
  }
  if (errors.length) {
    console.warn(`(filtered ${errors.length - relevantErrors.length} known unrelated JS error(s))`);
  }

  // Screenshot for visual confirmation
  await page.screenshot({
    path: 'qa/screenshots/analytics-rejection.png',
    fullPage: true,
  });

  console.log('✅ analytics-rejection.spec PASSED');
  console.log(`   - Stage Velocity has columns: ${JSON.stringify(velocityHeaders)}`);
  console.log(`   - Rejection Reasons in state: ${reasonsState.length} reasons`);
  console.log(`   - First stage rejected_count: ${firstStage.rejected_count}`);
  console.log(`   - Rejection Reasons header total: ${totalsInDom.headerTotal}, footer: ${totalsInDom.footerTotal}`);

  await browser.close();
  process.exit(0);
})().catch(async (err) => {
  console.error('❌ analytics-rejection.spec FAILED:', err.message);
  process.exit(1);
});
