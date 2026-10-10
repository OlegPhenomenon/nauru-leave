import { expect, test, type Page } from '@playwright/test';
import { apiGet, apiPost, approveChain, decide, goTo, more, openDetails, pick } from './helpers';
import type { LeaveType, RequestDetail } from '../src/api/types';

// Playwright gives each test its own browser context. The first pick explicitly
// starts a fresh sandbox; no shared seed modifications or requests are reused.
test('R01: first policy from October supports October–December monthly accrual', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Maria'); await goTo(page, '/settings/leave-types');
  await page.getByRole('button', { name: 'Add leave type…', exact: true }).click();
  let modal = page.locator('.modal');
  await modal.getByLabel('Name', { exact: true }).fill('October monthly demonstration');
  await modal.getByLabel('Rules start on').fill('2026-10-01');
  await modal.getByLabel('Days per year').fill('15');
  await openDetails(page, 'More rules');
  await modal.getByLabel('How the days are added').selectOption('monthly');
  await modal.getByLabel('Rule explanation').fill('Fictional October monthly rule');
  await modal.getByRole('button', { name: 'Add leave type', exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect((await apiPost(page, '/demo/clock', { date: '2026-12-01' })).status).toBe(200);
  await goTo(page, '/balances');
  for (const month of ['October', 'November', 'December']) {
    await more(page, 'Add entitlement…');
    modal = page.locator('.modal');
    for (const box of await modal.locator('fieldset label').filter({ hasNotText: 'October monthly demonstration' }).locator('input[type=checkbox]').all()) await box.uncheck();
    await modal.locator('.field:has-text("Year") input').fill('2026');
    const months = modal.locator('.field:has(> label.field-label:text-is("Month")) select');
    await expect(months).toBeVisible();
    await months.selectOption({ label: 'September' });
    await expect(modal.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
    await months.selectOption({ label: month });
    const response = page.waitForResponse(r => r.url().endsWith('/accruals/run') && r.request().method() === 'POST');
    await modal.getByRole('button', { name: 'Add', exact: true }).click();
    const result = await response;
    expect(result.status()).toBe(200);
    expect((await result.json()).posted).toBeGreaterThan(0);
    await modal.getByRole('button', { name: 'Done' }).click();
    await expect(modal).toHaveCount(0);
  }
  const types = await apiGet<LeaveType[]>(page, '/leave-types');
  const type = types.find(t => t.name === 'October monthly demonstration')!;
  expect(type.policies).toHaveLength(1);
  expect(type.policies[0].valid_from).toBe('2026-10-01');
});

async function createAnnual(page: Page, end = '2026-11-09') {
  const result = await apiPost(page, '/requests', { leave_type_id: 1, start_date: '2026-11-09', end_date: end, start_part: 'full', end_part: 'full' });
  expect(result.status).toBe(200);
  return JSON.parse(result.body) as RequestDetail;
}
async function upload(page: Page, filename: string, contents: string) {
  await more(page, 'Add document…');
  const modal = page.locator('.modal');
  await modal.locator('input[type=file]').setInputFiles({ name: filename, mimeType: 'application/pdf', buffer: Buffer.from(contents) });
  await modal.getByRole('button', { name: 'Add document', exact: true }).click();
  await expect(modal).toHaveCount(0);
}

test('R02: a corrected date is disabled and a second correction cannot credit it', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Alexei');
  const req = await createAnnual(page);
  expect((await apiPost(page, `/requests/${req.id}/submit`, { expected_version: req.version })).status).toBe(200);
  await approveChain(page, req.id); await pick(page, 'Maria');
  expect((await apiPost(page, '/demo/clock', { date: '2026-11-10' })).status).toBe(200);
  await goTo(page, `/requests/${req.id}`);
  await page.getByRole('button', { name: 'Days actually worked…' }).click();
  let modal = page.locator('.modal');

  await modal.locator('input[type=checkbox]').check();
  await modal.locator('textarea').fill('Worked on November 9');
  await modal.locator('input[type=text]').fill('Fictional attendance');
  await modal.getByRole('button', { name: 'Send for second approval', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await page.getByRole('button', { name: 'Days actually worked…' }).click();
  modal = page.locator('.modal');
  await expect(modal.locator('input[type=checkbox]')).toBeDisabled();
  await expect(modal).toContainText('correction waiting for approval');
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  await pick(page, 'David'); await goTo(page, '/balances');
  await page.locator('.msg', { hasText: 'Worked on November 9' }).getByRole('button', { name: 'Approve', exact: true }).click();
  await pick(page, 'Maria'); await goTo(page, `/requests/${req.id}`);
  await page.getByRole('button', { name: 'Days actually worked…' }).click();
  modal = page.locator('.modal');
  await expect(modal.locator('input[type=checkbox]')).toBeDisabled();
  await expect(modal).toContainText('already corrected');
  await expect(modal.getByRole('button', { name: 'Send for second approval', exact: true })).toBeDisabled();
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
  await expect(page.locator('.dc-docs')).toBeVisible();
  await expect(page.locator('body')).toContainText('blocked by the virus check');
  await expect(page.locator('a[href^="/api/attachments/"]', { hasText: 'quarantined-support.pdf' })).toHaveCount(0);
  let detail = await apiGet<RequestDetail>(page, `/requests/${req.id}`);
  expect((await apiPost(page, `/requests/${req.id}/submit`, { expected_version: detail.version })).status).toBe(200);
  for (const persona of ['Olga', 'Maria']) { await pick(page, persona); await goTo(page, `/requests/${req.id}`); await decide(page); }
  await pick(page, 'Elena'); await goTo(page, `/requests/${req.id}`);
  await expect(page.locator('.dc')).toContainText('Add a readable supporting document before approving.');
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  detail = await apiGet<RequestDetail>(page, `/requests/${req.id}`);
  const blocked = await apiPost(page, `/requests/${req.id}/decide`, { expected_version: detail.version, step_id: detail.decidable_step!.id, outcome: 'approve' });
  expect(blocked.status).toBe(422);
  expect(blocked.body).toContain('A readable supporting document is required');
  await pick(page, 'Alexei'); await goTo(page, `/requests/${req.id}`);
  await upload(page, 'clean-support.pdf', '%PDF-1.4\nFictional readable supporting document');
  await pick(page, 'Elena'); await goTo(page, `/requests/${req.id}`); await decide(page);
  expect((await apiGet<RequestDetail>(page, `/requests/${req.id}`)).status).toBe('approved');
});
