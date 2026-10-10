import { expect, test, type Page } from '@playwright/test';
import type { BalanceSummary, RequestDetail } from '../src/api/types';
import { apiGet, apiPost, approveChain, goTo, more, pick } from './helpers';

async function create(page: Page) {
  const response = await apiPost(page, '/requests', { leave_type_id: 1, start_date: '2026-10-19', end_date: '2026-10-23' });
  expect(response.status).toBe(200);
  const request = JSON.parse(response.body) as RequestDetail;
  expect((await apiPost(page, `/requests/${request.id}/submit`, { expected_version: request.version })).status).toBe(200);
  return request;
}

test('review: amendment balance, returned days, child rows and partial cancellation dates agree with the server', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Alexei');
  const original = await create(page);
  await approveChain(page, original.id); await pick(page, 'Alexei');
  await goTo(page, `/requests/${original.id}`);
  await page.getByRole('button', { name: 'Change dates', exact: true }).click();
  const modal = page.locator('.modal');
  await expect(modal).toContainText('15 days left after');
  await modal.getByLabel('Last day', { exact: true }).fill('2026-10-22');
  await modal.getByLabel('Why?').fill('One day shorter');
  await expect(modal).toContainText('16 days left after');
  const changed = page.waitForResponse(r => r.url().endsWith(`/requests/${original.id}/amend`) && r.request().method() === 'POST');
  await modal.getByRole('button', { name: 'Send change for approval', exact: true }).click();
  const amendment = ((await (await changed).json()) as RequestDetail).id;
  await page.waitForURL(`**/requests/${amendment}`);
  await approveChain(page, amendment); await pick(page, 'Alexei');
  const balances = await apiGet<BalanceSummary[]>(page, '/balances/me');
  expect(balances.find(b => b.leave_type.id === 1)!.available_minutes).toBe(16 * 480);
  await goTo(page, '/my');
  await expect(page.locator(`a[href="/requests/${amendment}"]`)).not.toBeVisible();
  await expect(page.locator(`a[href="/requests/${original.id}"]`).first()).toHaveText('19–22 Oct 2026');
  await goTo(page, '/balances/8/explain?leave_type_id=1');
  await expect(page.locator('.sum-list')).toContainText('given 20 days');
  await expect(page.locator('.sum-list')).toContainText('4 days used');
  await expect(page.locator('main')).not.toContainText('Leave 19–22 Oct 2026 approved');
  const current = await apiGet<RequestDetail>(page, `/requests/${original.id}`);
  const response = await apiPost(page, `/requests/${original.id}/cancel`, { expected_version: current.version, from_date: '2026-10-20', to_date: '2026-10-20', change_reason: 'Working on Tuesday' });
  expect(response.status).toBe(200);
  const cancellation = JSON.parse(response.body) as RequestDetail;
  await approveChain(page, cancellation.id); await pick(page, 'Alexei');
  await goTo(page, '/my');
  await expect(page.locator(`a[href="/requests/${cancellation.id}"]`)).not.toBeVisible();
  await expect(page.locator(`a[href="/requests/${original.id}"]`).first()).toHaveText('19 Oct 2026, 21–22 Oct 2026');
  await goTo(page, `/requests/${original.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('19 Oct 2026, 21–22 Oct 2026');
  await expect(page.locator('.rq-duration')).toHaveText('3 days of leave');
});

test('review: manager sees their pending question and the returned answer; badge follows decisions', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Alexei'); const request = await create(page);
  await pick(page, 'Olga');
  let row = page.locator('.queue-row').filter({ has: page.locator(`button[aria-controls="request-${request.id}"]`) });
  await row.locator('.queue-row-toggle').click();
  await row.getByRole('button', { name: 'Ask a question…' }).click();
  await row.getByLabel('Your question').fill('Which flight?');
  await row.getByRole('button', { name: 'Send question', exact: true }).click();
  const waiting = page.locator('details').filter({ has: page.locator('summary', { hasText: /^Waiting for the employee/ }) });
  await expect(waiting).toContainText('Alexei Novak');
  await pick(page, 'Alexei');
  await expect(page.locator('.toast-region').filter({ hasText: 'Question sent' })).toHaveCount(0);
  await page.getByLabel('Your answer').fill('Monday morning flight');
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await pick(page, 'Olga');
  row = page.locator('.queue-row').filter({ has: page.locator(`button[aria-controls="request-${request.id}"]`) });
  await row.locator('.queue-row-toggle').click();
  await expect(row.locator('.dc')).toContainText('Which flight?');
  await expect(row.locator('.dc')).toContainText('Monday morning flight');
  const badge = page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: /^Approvals/ }).locator('.nav-count');
  const before = Number(await badge.innerText());
  await row.getByRole('button', { name: 'Recommend approval', exact: true }).click();
  if (before === 1) await expect(badge).toHaveCount(0); else await expect(badge).toHaveText(String(before - 1));
});

test('review: admin shortcuts fit three clicks and Settings uses a single footer', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Maria');
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add unit…', exact: true }).click();
  await page.locator('.modal').getByLabel('Name', { exact: true }).fill('Review Unit');
  await page.locator('.modal').getByRole('button', { name: 'Add unit', exact: true }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await goTo(page, '/settings');
  await page.getByRole('button', { name: 'Add public holiday…' }).click();
  await expect(page.locator('.modal-foot').getByRole('button')).toHaveCount(2);
  await expect(page.locator('.modal-foot').getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);
  await page.locator('.modal').getByRole('button', { name: 'Cancel', exact: true }).click();
  await goTo(page, '/history?q=NLD-2026-00009');
  const entry = page.locator('.history-list > li').first();
  await entry.locator('summary').first().click();
  await expect(entry.locator('pre')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('recommend_approve');
});

test('review: year defaults stay appropriate and the correction badge refreshes after approval', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Maria');
  await goTo(page, '/balances');
  await more(page, 'Add entitlement…');
  await expect(page.locator('.modal').getByLabel('Year', { exact: true })).toHaveValue('2027');
  await page.locator('.modal').getByRole('button', { name: 'Cancel', exact: true }).click();
  await pick(page, 'Maria'); await goTo(page, '/balances'); await more(page, 'Close year…');
  await expect(page.getByRole('dialog', { name: 'Close 2025', exact: true }).getByLabel('Year to close')).toHaveValue('2025');
  await page.locator('.modal').getByRole('button', { name: 'Cancel', exact: true }).click();
  await goTo(page, '/balances');
  await page.getByRole('button', { name: 'Correct balance…', exact: true }).click();
  await expect(page.locator('.modal').getByLabel('Year', { exact: true })).toHaveValue('2026');
  await page.locator('.modal').getByRole('button', { name: 'Cancel', exact: true }).click();
  const correction = await apiPost(page, '/adjustments', { employee_id: 8, leave_type_id: 1, period_year: 2026, minutes: 480, reason: 'Live badge verification', basis_document: 'Opening sheet' });
  expect(correction.status).toBe(200);
  await pick(page, 'David'); await goTo(page, '/balances');
  const badge = page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: /^Balances/ }).locator('.nav-count');
  const before = Number(await badge.innerText());
  await page.locator('.msg', { hasText: 'Live badge verification' }).getByRole('button', { name: 'Approve', exact: true }).click();
  if (before === 1) await expect(badge).toHaveCount(0); else await expect(badge).toHaveText(String(before - 1));
});

test('review: absence rows are chronological and creating payroll downloads it in three clicks', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Maria');
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'Reports', exact: true }).click();
  const dates = page.locator('.reports-layout table tbody tr td:first-child');
  await expect(dates.first()).toHaveText('1 Oct 2026');
  const rendered = await dates.allTextContents();
  expect(rendered).toEqual([...rendered].sort((a, b) => Number(a.split(' ')[0]) - Number(b.split(' ')[0])));
  await page.getByRole('navigation', { name: 'Reports', exact: true }).getByRole('button', { name: 'Payroll files', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Create payroll file', exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('payroll-2026-10-01-2026-10-31.csv');
  expect(await file.failure()).toBeNull();
  await expect(page.locator('.reports-layout').getByRole('button', { name: 'Download', exact: true })).toBeVisible();
});
