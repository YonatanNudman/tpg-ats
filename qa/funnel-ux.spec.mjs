import { chromium } from 'playwright';

const BASE = process.env.QA_URL || 'http://localhost:4567';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function settle(page, ms = 350) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

async function expandStage(page, stageName) {
  const stage = page.locator('.funnel-stage').filter({ hasText: stageName }).first();
  await stage.locator('.funnel-row').click();
  await settle(page, 200);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const tag = Date.now();

  await page.goto(BASE);
  await page.waitForSelector('#app');
  await settle(page, 900);

  // 1) Add one job + one candidate (current funnel-first journey)
  await page.locator('button:has-text("Add Job")').click();
  await page.waitForSelector('.modal-dialog .modal-title:has-text("Add Job Opening")');
  await page.locator('.modal-dialog input[x-model="form.title"]').fill(`QA UX Job ${tag}`);
  await page.locator('.modal-dialog .modal-footer button:has-text("Add Job")').click();
  await settle(page, 500);

  await page.locator('button:has-text("Add Candidate")').click();
  await page.waitForSelector('.modal-dialog .modal-title:has-text("Add Candidate")');
  await page.locator('.modal-dialog input[x-model="form.first_name"]').fill('QA');
  await page.locator('.modal-dialog input[x-model="form.last_name"]').fill(`User${tag}`);
  await page.locator('.modal-dialog input[x-model="form.email"]').fill(`qa-ux-${tag}@example.com`);
  await page.locator('.modal-dialog select[x-model="form.job_id"]').selectOption({ label: `QA UX Job ${tag}` });
  await page.locator('.modal-dialog .modal-footer button:has-text("Add Candidate")').click();
  await settle(page, 800);

  // 2) Expand Applied stage and verify candidate row appears
  await expandStage(page, 'Applied');
  const candidateRow = page.locator('.funnel-candidate-row').filter({ hasText: `QA User${tag}` }).first();
  assert(await candidateRow.count(), 'Expected candidate in Applied stage');

  // 3) Apply a section scope filter and confirm localStorage persistence
  await page.locator('#sec-funnel .section-filter').first().selectOption({ label: `QA UX Job ${tag}` });
  await settle(page, 300);

  const stateBefore = await page.evaluate(() => {
    return localStorage.getItem('tpg-ats.section-state.v1') || '';
  });
  assert(stateBefore.includes('funnelFilters'), 'Expected funnel filter state in localStorage');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await settle(page, 900);

  const stateAfter = await page.evaluate(() => {
    return localStorage.getItem('tpg-ats.section-state.v1') || '';
  });
  assert(stateAfter.includes('funnelFilters'), 'Expected persisted funnelFilters after reload');

  await browser.close();
  console.log('[qa:ux] PASS');
})().catch((e) => {
  console.error('[qa:ux] FAIL:', e.message || e);
  process.exit(1);
});

