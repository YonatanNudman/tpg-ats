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

  // Reject button must be ENABLED right after a reason is picked (single reject path)
  const rejectBtn = page.locator('.modal-dialog .modal-footer .btn-danger').first();
  let isDisabled = await rejectBtn.isDisabled();
  assert(isDisabled, 'Reject button should be disabled until a reason is picked');

  // Pick a reason via Alpine to avoid select-option fragility across rendered text
  await page.evaluate(() => {
    const dlg = document.querySelector('.modal-dialog');
    const cmp = Alpine.$data(dlg);
    cmp.refuseReasonId = String(Alpine.store('app').settings.refuseReasons[0].id);
  });
  await settle(page, 200);

  isDisabled = await rejectBtn.isDisabled();
  assert(!isDisabled, 'Reject button should be enabled once a reason is picked (single reject)');

  // Click the actual button
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

  // Verify the new "Recent Rejections" section now shows the candidate
  await settle(page, 400);
  const inRejectionsList = await page.evaluate(async ({ tag }) => {
    const root = Alpine.$data(document.querySelector('#app'));
    await root.loadRecentRejections();
    return (root.recentRejections || []).some((c) => c.email && c.email.includes(`rejecto-${tag}`));
  }, { tag });
  assert(inRejectionsList, 'Rejected candidate should appear in Recent Rejections section');

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
