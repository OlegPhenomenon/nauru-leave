import { expect, test } from '@playwright/test';

// Walks the main demo story against a real stack in a fresh browser sandbox.

import { approveChain, goTo, pick, openDetails, moveDate, apiGet } from './helpers';

test('main scenario steps 1–5: balance, request, approval, amendment, time travel', async ({
  page,
}) => {
  // ---- 1. Alexei sees his Annual balance and the fictional-rule marking ----
  await page.goto('/');
  await pick(page, 'Alexei');
  await page.waitForURL('**/my');
  await expect(page.locator('body')).toContainText('Annual leave');
  await expect(page.locator('body')).toContainText('20 days');
  await expect(page.locator('body')).toContainText('fictional people and rules');
  const demo = page.locator('.demo-strip');
  await expect(demo.getByRole('button', { name: 'Switch user', exact: true })).toBeVisible();
  await expect(demo.getByRole('button', { name: 'Change date…', exact: true })).toBeVisible();
  await expect(demo.getByRole('button', { name: 'Reset demo…', exact: true })).toBeVisible();
  await demo.getByRole('button', { name: /^Emails \(\d+\)$/ }).click();
  const emails = page.getByRole('dialog', { name: 'Emails', exact: true });
  await expect(emails).toBeVisible();
  await emails.getByRole('button', { name: '✕ Close', exact: true }).click();
  await expect(emails).toHaveCount(0);

  // ---- 2. New request 9–13 Nov 2026: preview, warnings, route, submit ----
  await goTo(page, '/requests/new');
  await page
    .locator('.field:has-text("Leave type") select')
    .selectOption({ label: 'Annual leave' });
  await page.locator('.field:has-text("Start date") input').fill('2026-11-09');
  await page.locator('.field:has-text("End date") input').fill('2026-11-13');
  await expect(page.locator('body')).toContainText('5 working days');
  await openDetails(page, 'Show day by day');
  await expect(page.locator('body')).toContainText('Olga');
  await expect(page.locator('body')).toContainText('a final approver');
  // team-overlap warning must name the absent teammate (Lina)
  await expect(page.locator('body')).toContainText('Lina');
  await page.getByRole('button', { name: 'Send request' }).click();
  await page.waitForURL(/\/requests\/\d+$/);
  const reqId = Number(page.url().match(/requests\/(\d+)/)![1]);
  expect((await apiGet<{ current_revision: { total_minutes: number } }>(page, `/requests/${reqId}`)).current_revision.total_minutes).toBe(2400); // Five eight-hour days.

  await goTo(page, '/my');
  await expect(page.locator('body')).toContainText('15 days');
  await expect(page.locator('body')).toContainText('waiting for approval');

  // ---- 3. Olga recommends, Maria checks, Elena approves ----
  await approveChain(page, reqId);
  await pick(page, 'Alexei');
  await goTo(page, '/my');
  await expect(page.locator('body')).toContainText('15 days');

  // ---- 4. Amend to 9–11 Nov, approve again, balance becomes 17 ----
  await goTo(page, `/requests/${reqId}`);
  const actions = page.locator('.rq-summary > .btn-row');
  await expect(actions.getByRole('button', { name: 'Change dates', exact: true })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Cancel days', exact: true })).toBeVisible();
  await expect(actions.getByRole('link', { name: 'Print', exact: true })).toBeVisible();
  await expect(actions.locator('.menu')).toHaveCount(0);
  await page.getByRole('button', { name: /Change dates/ }).click();
  await expect(
    page.locator('.modal .field:has-text("First day") input'),
  ).toHaveValue('2026-11-09');
  await page.locator('.modal .field:has-text("Last day") input').fill('2026-11-11');
  await page
    .locator('.modal .field:has-text("Why? (required)") textarea')
    .fill('Plans changed — shorter trip');
  await page.getByRole('button', { name: 'Send change for approval' }).click();
  await page.waitForURL(
    (u) => /\/requests\/\d+$/.test(u.pathname) && u.pathname !== `/requests/${reqId}`,
  );
  const amendId = Number(page.url().match(/requests\/(\d+)/)![1]);
  await approveChain(page, amendId);
  await pick(page, 'Alexei');
  await goTo(page, '/my');
  await expect(page.locator('body')).toContainText('17 days');
  await goTo(page, `/requests/${reqId}`);
  await openDetails(page, 'Changes');
  await expect(page.locator('body')).toContainText('Change request');

  // The original request now shows the amended revision as in force:
  // 9–11 Nov / 3 days. The old 9–13 dates appear only as history.
  await expect(page.locator('body')).toContainText(/9(?:–11)? Nov/);
  await expect(page.locator('body')).toContainText('11 Nov');
  await expect(page.locator('body')).toContainText('3 days');
  await expect(page.locator('body')).toContainText('Approved');
  const histRow = page.getByRole('row', { name: /13 Nov/ });
  await expect(histRow).toHaveCount(1);
  await expect(histRow).toContainText('Superseded');

  // Same on the printable card: days in force 9–11 Nov, 3 days; the
  // superseded revision is listed in the history section only.
  await goTo(page, `/requests/${reqId}/print`);
  await expect(page.locator('body')).toContainText('Days');
  await expect(page.locator('body')).toContainText(/9(?:–11)? Nov/);
  await expect(page.locator('body')).toContainText('11 Nov');
  await expect(page.locator('body')).toContainText('3 days');
  await openDetails(page, 'Earlier versions and record details');
  const printHist = page.locator('details table').first();
  await expect(page.getByRole('row', { name: /13 Nov/ })).toHaveCount(1);
  await expect(printHist.getByRole('row', { name: /13 Nov/ })).toHaveCount(1);

  // ---- 5. Time travel to 2026-11-12: period ended, balance still 17 ----
  await moveDate(page, '2026-11-12');
  await expect(page.locator('.demo-strip')).toContainText('12 Nov 2026');
  await goTo(page, `/requests/${reqId}`);
  await expect(page.locator('.rq-status-text')).toContainText('ended');
  await goTo(page, '/my');
  await expect(page.locator('body')).toContainText('17 days');
});
