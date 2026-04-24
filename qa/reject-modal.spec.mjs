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

  // Seed one job + one candidate scoped to this test
  const job = await call(page, 'createJobOpening', {
    title: `Reject Modal Job ${tag}`, department: 'QA', location: 'Remote',
    status: 'Open', head_count: 1, filled: 0,
  });
  await call(page, 'createCandidate', {
    first_name: 'Rejecto', last_name: `T${tag}`, email: `rejecto-${tag}@example.com`,
    phone: '', job_id: job.id, recruiter_id: 1, motion: 'Inbound',
  });

  await page.evaluate(async () => {
    const root = Alpine.$data(document.querySelector('#app'));
    await root.reloadAll();
  });
  await settle(page, 600);

  // Open peek and trigger reject modal via store API (deterministic, no clicking)
  await page.evaluate(async ({ tag }) => {
    const root = Alpine.$data(document.querySelector('#app'));
    const c = root.allCandidates.find((x) => x.email === `rejecto-${tag}@example.com`);
    Alpine.store('app').openModal('confirmReject', {
      candidateId: c.id,
      candidateName: 'Rejecto T' + tag,
    });
  }, { tag });
  await page.waitForSelector('.modal-dialog .modal-title');
  await settle(page, 250);

  // Header text must NOT contain a literal "\u" escape sequence
  const headerText = await page.locator('.modal-dialog .modal-header').textContent();
  assert(!/\\u[0-9a-fA-F]{4}/.test(headerText),
    `Modal header contains literal unicode escape: ${headerText}`);

  // Reject button is always clickable (only locked while submitting).
  // Validation happens on click as an inline error + toast.
  const rejectBtn = page.locator('.modal-dialog .modal-footer .btn-danger').first();
  let isDisabled = await rejectBtn.isDisabled();
  assert(!isDisabled, 'Reject button should be clickable for single reject (validation happens on submit)');

  // Click without picking a reason → expect validation toast, no submission
  await rejectBtn.click();
  await settle(page, 400);
  const stateBefore = await page.evaluate(async () => (await fetch('/__qa/state')).json());
  const stillActive = stateBefore.candidates.find((c) => /^rejecto-/.test(c.email));
  assert(stillActive && stillActive.status === 'Active',
    'Clicking Reject without a reason must NOT submit');
  const errToast = await page.locator('.toast.toast-error').first().textContent();
  assert(/reason/i.test(errToast || ''), `Expected reason-required error toast; got: ${errToast}`);

  // Pick a reason and click again — should ready up + brighten + submit
  await page.evaluate(() => {
    const dlg = document.querySelector('.modal-dialog');
    const cmp = Alpine.$data(dlg);
    cmp.refuseReasonId = String(Alpine.store('app').settings.refuseReasons[0].id);
  });
  await settle(page, 200);

  const isReady = await rejectBtn.evaluate((el) => el.classList.contains('reject-ready'));
  assert(isReady, 'Reject button should get .reject-ready visual state once a reason is picked');

  await rejectBtn.click();
  await settle(page, 800);

  // Verify candidate is now Rejected on the server
  const state = await page.evaluate(async () => {
    const r = await fetch('/__qa/state');
    return r.json();
  });
  const updated = state.candidates.find((c) => c.email && c.email.includes(`rejecto-${tag}`));
  assert(updated && updated.status === 'Rejected',
    `Candidate should be Rejected; got status=${updated && updated.status}`);

  // Verify the funnel's synthetic Rejected bucket now contains the candidate.
  // The bucket uses stage_id = -1 as a sentinel (see _buildFunnelCache).
  await settle(page, 400);
  const inRejectedBucket = await page.evaluate(({ tag }) => {
    const root = Alpine.$data(document.querySelector('#app'));
    const rows = root.funnelCandidatesForStage(-1) || [];
    return rows.some((c) => c.email && c.email.includes(`rejecto-${tag}`));
  }, { tag });
  assert(inRejectedBucket, 'Rejected candidate should appear in the funnel Rejected bucket');

  // Verify the toast included the "View rejections" action
  const toastHasAction = await page.evaluate(() => {
    const toasts = Alpine.store('app').toasts || [];
    return toasts.some((t) => t.actionLabel === 'View rejections');
  });
  assert(toastHasAction, 'Reject success toast should include "View rejections" action');

  await browser.close();
  console.log('[qa:reject-modal] PASS');
})().catch((e) => {
  console.error('[qa:reject-modal] FAIL:', e.message || e);
  process.exit(1);
});
