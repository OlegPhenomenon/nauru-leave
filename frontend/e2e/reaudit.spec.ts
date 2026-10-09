import { expect, test, type Page } from '@playwright/test';
import { apiGet, apiPost, approveChain, decide, goTo, pick } from './helpers';
import type { LeaveType, RequestDetail } from '../src/api/types';

// Playwright gives each test its own browser context. The first pick explicitly
// starts a fresh sandbox; no shared seed modifications or requests are reused.
test('R01: first policy from October supports October–December monthly accrual', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Maria'); await goTo(page, '/settings');
  await page.getByRole('button', { name: 'New leave type' }).click();
  let modal = page.locator('.modal');
  await modal.locator('label.field:has-text("Code") input').fill('OCT_MONTH');
  await modal.locator('label.field:has-text("Name") input').fill('October monthly demonstration');
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).toHaveCount(0);
  const panel = page.getByRole('heading', { name: 'October monthly demonstration' }).locator('xpath=..');
  await panel.getByRole('button', { name: 'New policy version' }).click();
  modal = page.locator('.modal');
  await modal.locator('label.field:has-text("Valid from") input').fill('2026-10-01');
  await modal.locator('label.field:has-text("Annual entitlement") input').fill('7200');
  await modal.locator('label.field:has-text("Accrual mode") select').selectOption('monthly');
  await modal.locator('label.field:has-text("Explanation") textarea').fill('Fictional October monthly rule');
  await modal.getByRole('button', { name: 'Create policy version' }).click();
  await expect(modal).toHaveCount(0);
  expect((await apiPost(page, '/demo/clock', { date: '2026-12-01' })).status).toBe(200);
  await goTo(page, '/balances');
  for (const month of ['October', 'November', 'December']) {
    await page.getByRole('button', { name: 'Run accrual', exact: true }).click();
    modal = page.locator('.modal');
    await modal.locator('label.field:has-text("Leave type") select').selectOption({ label: 'October monthly demonstration' });
    await modal.locator('label.field:has-text("Period year") input').fill('2026');
    const months = modal.locator('label.field:has(> span.field-label:text-is("Month")) select');
    await expect(months).toBeVisible();
    await months.selectOption({ label: 'September' });
    await expect(modal.getByRole('button', { name: 'Run accrual', exact: true })).toBeDisabled();
    await months.selectOption({ label: month });
    const response = page.waitForResponse(r => r.url().endsWith('/accruals/run') && r.request().method() === 'POST');
    await modal.getByRole('button', { name: 'Run accrual', exact: true }).click();
    const result = await response;
    expect(result.status()).toBe(200);
    expect((await result.json()).posted).toBeGreaterThan(0);
    await expect(modal).toHaveCount(0);
  }
  const types = await apiGet<LeaveType[]>(page, '/leave-types');
  const type = types.find(t => t.code === 'OCT_MONTH')!;
  expect(type.policies).toHaveLength(1);
  expect(type.policies[0].valid_from).toBe('2026-10-01');
});

async function createAnnual(page: Page, end = '2026-11-09') {
  const result = await apiPost(page, '/requests', { leave_type_id: 1, start_date: '2026-11-09', end_date: end, start_part: 'full', end_part: 'full' });
  expect(result.status).toBe(200);
  return JSON.parse(result.body) as RequestDetail;
}
async function upload(page: Page, filename: string, contents: string) {
  await page.getByRole('button', { name: 'Upload attachment', exact: true }).click();
  const modal = page.locator('.modal');
  await modal.locator('input[type=file]').setInputFiles({ name: filename, mimeType: 'application/pdf', buffer: Buffer.from(contents) });
  await modal.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(modal).toHaveCount(0);
}

test('R02: a corrected date is disabled and a second correction cannot credit it', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Alexei');
  const req = await createAnnual(page);
  expect((await apiPost(page, `/requests/${req.id}/submit`, { expected_version: req.version })).status).toBe(200);
  await approveChain(page, req.id); await pick(page, 'Maria');
  expect((await apiPost(page, '/demo/clock', { date: '2026-11-10' })).status).toBe(200);
  await goTo(page, `/requests/${req.id}`);
  await page.getByRole('button', { name: 'Confirm actual / propose adjustment' }).click();
  let modal = page.locator('.modal');
  await modal.locator('select').selectOption('propose_adjustment');
  await modal.locator('input[type=checkbox]').check();
  await modal.locator('textarea').fill('Worked on November 9');
  await modal.locator('input[type=text]').fill('Fictional attendance');
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await page.getByRole('button', { name: 'Confirm actual / propose adjustment' }).click();
  modal = page.locator('.modal'); await modal.locator('select').selectOption('propose_adjustment');
  await expect(modal.locator('input[type=checkbox]')).toBeDisabled();
  await expect(modal).toContainText('Correction pending');
  await modal.getByRole('button', { name: 'Back', exact: true }).click();
  await pick(page, 'David'); await goTo(page, '/balances');
  await page.getByRole('row', { name: /Worked on November 9/ }).getByRole('button', { name: 'Apply', exact: true }).click();
  await pick(page, 'Maria'); await goTo(page, `/requests/${req.id}`);
  await page.getByRole('button', { name: 'Confirm actual / propose adjustment' }).click();
  modal = page.locator('.modal'); await modal.locator('select').selectOption('propose_adjustment');
  await expect(modal.locator('input[type=checkbox]')).toBeDisabled();
  await expect(modal).toContainText('Already corrected');
  await expect(modal.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const detail = await apiGet<RequestDetail>(page, `/requests/${req.id}`);
  const duplicate = await apiPost(page, `/requests/${req.id}/actual`, { expected_version: detail.version, action: 'propose_adjustment', worked_dates: ['2026-11-09'], note: 'New separate attempt', basis_document: 'Attendance' });
  expect(duplicate.status).toBe(422);
  const after = await apiGet<RequestDetail>(page, `/requests/${req.id}`);
  expect(after.ledger_entries.filter(e => e.kind === 'adjustment').reduce((sum, e) => sum + e.minutes, 0)).toBe(480);
});

test('R03: quarantined-only evidence blocks final approval; a clean file allows it', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Maria');
  const types = await apiGet<LeaveType[]>(page, '/leave-types');
  const annual = types.find(t => t.id === 1)!;
  const policy = await apiPost(page, '/leave-types/1/policies', { ...annual.policy, valid_from: '2026-10-01', requires_attachment: true, explanation: 'Fictional supporting document rule' });
  expect(policy.status).toBe(200);
  await pick(page, 'Alexei'); const req = await createAnnual(page);
  expect((await apiPost(page, `/requests/${req.id}/submit`, { expected_version: req.version })).status).toBe(422);
  await goTo(page, `/requests/${req.id}`);
  const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
  await upload(page, 'quarantined-support.pdf', `%PDF-1.4\n${eicar}`);
  await expect(page.locator('body')).toContainText('Quarantined');
  await expect(page.locator('a[href^="/api/attachments/"]', { hasText: 'quarantined-support.pdf' })).toHaveCount(0);
  let detail = await apiGet<RequestDetail>(page, `/requests/${req.id}`);
  expect((await apiPost(page, `/requests/${req.id}/submit`, { expected_version: detail.version })).status).toBe(200);
  for (const persona of ['Olga', 'Maria']) { await pick(page, persona); await goTo(page, `/requests/${req.id}`); await decide(page); }
  await pick(page, 'Elena'); await goTo(page, `/requests/${req.id}`);
  await page.getByRole('button', { name: /Decide —/ }).first().click();
  await page.locator('.modal input[name=outcome]').first().check();
  await expect(page.locator('.modal')).toContainText('A readable supporting document is required');
  await expect(page.getByRole('button', { name: 'Record decision' })).toBeDisabled();
  detail = await apiGet<RequestDetail>(page, `/requests/${req.id}`);
  const blocked = await apiPost(page, `/requests/${req.id}/decide`, { expected_version: detail.version, step_id: detail.decidable_step!.id, outcome: 'approve' });
  expect(blocked.status).toBe(422);
  expect(blocked.body).toContain('A readable supporting document is required');
  await pick(page, 'Alexei'); await goTo(page, `/requests/${req.id}`);
  await upload(page, 'clean-support.pdf', '%PDF-1.4\nFictional readable supporting document');
  await pick(page, 'Elena'); await goTo(page, `/requests/${req.id}`); await decide(page);
  expect((await apiGet<RequestDetail>(page, `/requests/${req.id}`)).status).toBe('approved');
});
