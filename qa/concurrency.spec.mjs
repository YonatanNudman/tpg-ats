import { chromium } from 'playwright';

const BASE = process.env.QA_URL || 'http://localhost:4567';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function settle(page, ms = 350) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

async function expandApplied(page) {
  const applied = page.locator('.funnel-stage').filter({ hasText: 'Applied' }).first();
  await applied.locator('.funnel-row').click();
  await settle(page, 200);
}

(async () => {
  const browser = await chromium.launch();
  const tag = Date.now();
  const fullName = `Conflict User${tag}`;
  const email = `qa-conflict-${tag}@example.com`;
  const jobTitle = `QA Conflict Job ${tag}`;

  // Setup page
  const setupCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const setup = await setupCtx.newPage();
  await setup.goto(BASE);
  await setup.waitForSelector('#app');
  await settle(setup, 900);

  await setup.locator('button:has-text("Add Job")').click();
  await setup.waitForSelector('.modal-dialog .modal-title:has-text("Add Job Opening")');
  await setup.locator('.modal-dialog input[x-model="form.title"]').fill(jobTitle);
  await setup.locator('.modal-dialog .modal-footer button:has-text("Add Job")').click();
  await settle(setup, 500);

  await setup.locator('button:has-text("Add Candidate")').click();
  await setup.waitForSelector('.modal-dialog .modal-title:has-text("Add Candidate")');
  await setup.locator('.modal-dialog input[x-model="form.first_name"]').fill('Conflict');
  await setup.locator('.modal-dialog input[x-model="form.last_name"]').fill(`User${tag}`);
  await setup.locator('.modal-dialog input[x-model="form.email"]').fill(email);
  await setup.locator('.modal-dialog select[x-model="form.job_id"]').selectOption({ label: jobTitle });
  await setup.locator('.modal-dialog .modal-footer button:has-text("Add Candidate")').click();
  await settle(setup, 700);

  // Two independent "recruiter" sessions
  const c1 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p1 = await c1.newPage();
  const p2 = await c2.newPage();

  await Promise.all([p1.goto(BASE), p2.goto(BASE)]);
  await Promise.all([settle(p1, 900), settle(p2, 900)]);

  await p1.evaluate(async ({ candidateEmail }) => {
    const root = Alpine.$data(document.querySelector('#app'));
    const c = (root?.allCandidates || []).find((x) => x.email === candidateEmail);
    if (!c) throw new Error('Candidate not found in app state');
    await Alpine.store('app').openPeek(c.id);
  }, { candidateEmail: email });
  await p1.waitForSelector('.peek-panel .peek-name');
  await settle(p1, 250);

  // Session 1 updates stage first
  await p1.locator('.peek-panel .peek-stage-row select').first().selectOption({ label: 'Contacted' });
  await settle(p1, 700);

  // Session 2 refreshes after teammate change (regression check: no UI crash).
  await p2.locator('.topbar .refresh-btn').click();
  await settle(p2, 900);
  const state = await p2.evaluate(async () => {
    const r = await fetch('/__qa/state');
    return r.json();
  });
  const candidate = (state.candidates || []).find((c) => c.email === email);
  assert(!!candidate, 'Expected candidate in QA state');
  assert(Number(candidate.stage_id) !== 1, `Expected candidate to leave Applied stage, got stage_id=${candidate.stage_id}`);

  await Promise.all([setupCtx.close(), c1.close(), c2.close()]);
  await browser.close();
  console.log('[qa:concurrency] PASS');
})().catch((e) => {
  console.error('[qa:concurrency] FAIL:', e.message || e);
  process.exit(1);
});

