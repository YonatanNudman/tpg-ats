import { chromium } from 'playwright';

const BASE = process.env.QA_URL || 'http://localhost:4567';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const tag = Date.now();

  await page.goto(BASE);
  await page.waitForSelector('#app');
  await settle(page, 900);

  // Seed: 1 job, 2 candidates → reject one, leave the other active
  const job = await call(page, 'createJobOpening', {
    title: `Rejected Bucket Job ${tag}`, department: 'QA', location: 'Remote',
    status: 'Open', head_count: 2, filled: 0,
  });
  const activeC = await call(page, 'createCandidate', {
    first_name: 'Active', last_name: `T${tag}`, email: `active-${tag}@example.com`,
    phone: '', job_id: job.id, motion: 'Inbound',
  });
  const rejectC = await call(page, 'createCandidate', {
    first_name: 'Reject', last_name: `T${tag}`, email: `reject-${tag}@example.com`,
    phone: '', job_id: job.id, motion: 'Inbound',
  });
  // Use refuseReasonId from settings, then call rejectCandidate
  const reasonId = await page.evaluate(() => Alpine.store('app').settings.refuseReasons[0].id);
  await call(page, 'rejectCandidate', rejectC.id, reasonId);

  await page.evaluate(async () => {
    const root = Alpine.$data(document.querySelector('#app'));
    await root.reloadAll();
  });
  await settle(page, 700);

  // Funnel must now include a synthetic rejected bucket at the bottom
  const funnel = await page.evaluate(() => {
    const root = Alpine.$data(document.querySelector('#app'));
    return root.pipelineFunnelData.map(s => ({
      stage_id: s.stage_id, stage_name: s.stage_name,
      count: s.candidate_count, is_rejected_bucket: !!s.is_rejected_bucket,
    }));
  });
  const last = funnel[funnel.length - 1];
  assert(last && last.is_rejected_bucket && last.stage_name === 'Rejected',
    `Expected last funnel row to be the Rejected bucket; got: ${JSON.stringify(last)}`);
  assert(last.count >= 1,
    `Rejected bucket should contain at least 1 candidate; got ${last.count}`);

  // The rejected candidate must appear in funnelCandidatesForStage(-1)
  const rejectedRows = await page.evaluate(({ tag }) => {
    const root = Alpine.$data(document.querySelector('#app'));
    return root.funnelCandidatesForStage(-1).filter(c => c.email && c.email.includes(`reject-${tag}`));
  }, { tag });
  assert(rejectedRows.length === 1,
    `Rejected candidate should appear in rejected bucket; got ${rejectedRows.length} matches`);

  // The Active candidate must NOT appear in the rejected bucket
  const activeInBucket = await page.evaluate(({ tag }) => {
    const root = Alpine.$data(document.querySelector('#app'));
    return root.funnelCandidatesForStage(-1).filter(c => c.email && c.email.includes(`active-${tag}`));
  }, { tag });
  assert(activeInBucket.length === 0,
    'Active candidate must not show up in the Rejected bucket');

  await browser.close();
  console.log('[qa:funnel-rejected] PASS');
})().catch((e) => {
  console.error('[qa:funnel-rejected] FAIL:', e.message || e);
  process.exit(1);
});
