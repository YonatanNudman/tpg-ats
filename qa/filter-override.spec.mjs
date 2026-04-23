import { chromium } from 'playwright';

const BASE = process.env.QA_URL || 'http://localhost:4567';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function settle(page, ms = 350) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

async function setGlobal(page, field, value) {
  await page.evaluate(({ f, v }) => {
    const root = Alpine.$data(document.querySelector('#app'));
    root.filters[f] = v;
    root.applyFilters();
  }, { f: field, v: value });
  await settle(page, 250);
}

async function setSection(page, section, field, value) {
  await page.evaluate(({ s, f, v }) => {
    const root = Alpine.$data(document.querySelector('#app'));
    root[s][f] = v;
  }, { s: section, f: field, v: value });
  await settle(page, 200);
}

async function readScopedFunnel(page, jobId) {
  // Funnel respects funnelFilters; we look up which of OUR seeded
  // candidates (filtered to one job_id) the funnel currently shows.
  return await page.evaluate((jid) => {
    const root = Alpine.$data(document.querySelector('#app'));
    const stages = root.pipelineFunnelData || [];
    let visibleEmails = [];
    for (const s of stages) {
      const rows = root.funnelCandidatesForStage(s.stage_id) || [];
      for (const r of rows) {
        if (Number(r.job_id) === Number(jid)) visibleEmails.push(r.email);
      }
    }
    return visibleEmails.sort();
  }, jobId);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const tag = Date.now();

  await page.goto(BASE);
  await page.waitForSelector('#app');
  await settle(page, 900);

  const jobTitle = `Filter Override Job ${tag}`;
  const seedResult = await page.evaluate(async ({ jobTitle, tag }) => {
    const call = (fn, ...args) => new Promise((resolve, reject) => {
      google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(reject)[fn](...args);
    });
    const job = await call('createJobOpening', {
      title: jobTitle, department: 'QA', location: 'Remote',
      status: 'Open', head_count: 3, filled: 0,
    });
    await call('createCandidate', {
      first_name: 'Alpha', last_name: `T${tag}`, email: `alpha-${tag}@example.com`,
      phone: '', job_id: job.id, recruiter_id: 1, motion: 'Inbound',
    });
    await call('createCandidate', {
      first_name: 'Beta', last_name: `T${tag}`, email: `beta-${tag}@example.com`,
      phone: '', job_id: job.id, recruiter_id: 2, motion: 'Inbound',
    });
    await call('createCandidate', {
      first_name: 'Gamma', last_name: `T${tag}`, email: `gamma-${tag}@example.com`,
      phone: '', job_id: job.id, recruiter_id: null, motion: 'Inbound',
    });
    return { jobId: job.id };
  }, { jobTitle, tag });

  await page.evaluate(async () => {
    const root = Alpine.$data(document.querySelector('#app'));
    await root.reloadAll();
  });
  await settle(page, 600);

  const jobId = seedResult.jobId;

  // Baseline (no filters): all 3 of our seeded candidates visible
  let visible = await readScopedFunnel(page, jobId);
  assert(
    visible.length === 3,
    `Baseline should show 3 of our candidates; got ${visible.length}: ${visible}`
  );

  // 1) Global recruiter=1 → only Alpha
  await setGlobal(page, 'recruiterId', '1');
  visible = await readScopedFunnel(page, jobId);
  assert(
    visible.length === 1 && visible[0].startsWith('alpha-'),
    `Global recruiter=1 should show only Alpha; got: ${visible}`
  );

  // 2) Section override = unassigned → only Gamma (overrides global)
  await setSection(page, 'funnelFilters', 'recruiterId', '__unassigned__');
  visible = await readScopedFunnel(page, jobId);
  assert(
    visible.length === 1 && visible[0].startsWith('gamma-'),
    `Section recruiter=__unassigned__ should show only Gamma; got: ${visible}`
  );

  // 3) Clear section → falls back to global recruiter=1 (Alpha)
  await setSection(page, 'funnelFilters', 'recruiterId', '');
  visible = await readScopedFunnel(page, jobId);
  assert(
    visible.length === 1 && visible[0].startsWith('alpha-'),
    `Cleared section should fall back to global Alpha; got: ${visible}`
  );

  // 4) Clear global, set section=__assigned__ → Alpha + Beta only
  await setGlobal(page, 'recruiterId', '');
  await setSection(page, 'funnelFilters', 'recruiterId', '__assigned__');
  visible = await readScopedFunnel(page, jobId);
  assert(
    visible.length === 2 &&
      visible.some((e) => e.startsWith('alpha-')) &&
      visible.some((e) => e.startsWith('beta-')),
    `Section recruiter=__assigned__ should show Alpha + Beta; got: ${visible}`
  );

  // 5) Section job=__unassigned__ → none of ours match (they all have a job)
  await setSection(page, 'funnelFilters', 'recruiterId', '');
  await setSection(page, 'funnelFilters', 'jobId', '__unassigned__');
  visible = await readScopedFunnel(page, jobId);
  assert(
    visible.length === 0,
    `Section job=__unassigned__ should show none of our (job-assigned) candidates; got: ${visible}`
  );

  // 6) Restore: section job=our jobId → all 3 ours
  await setSection(page, 'funnelFilters', 'jobId', String(jobId));
  visible = await readScopedFunnel(page, jobId);
  assert(
    visible.length === 3,
    `Section job=ours should show all 3; got: ${visible}`
  );

  await browser.close();
  console.log('[qa:filter-override] PASS');
})().catch((e) => {
  console.error('[qa:filter-override] FAIL:', e.message || e);
  process.exit(1);
});
