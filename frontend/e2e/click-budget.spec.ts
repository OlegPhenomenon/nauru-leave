import { expect, test, type Locator, type Page } from '@playwright/test';
import type { RequestDetail } from '../src/api/types';
import { apiGet, apiPost, goTo, pick, requestId } from './helpers';

const internalText = /\b\d+ min\b|\(validation\)|\brev \d|Ledger|annual_upfront|_/;
async function plain(page: Page) {
  expect(await page.locator('body').innerText()).not.toMatch(internalText);
}
function budget(page: Page, name: string, max: number) {
  let count = 0;
  return {
    async click(control: Locator) {
      await plain(page);
      await control.click();
      count++;
      expect(count, `${name}: click budget`).toBeLessThanOrEqual(max);
      await plain(page);
    },
    async done(expected: number) {
      await plain(page);
      expect(count, `${name}: measured clicks`).toBe(expected);
      console.log(`${name}: ${count} clicks (budget ${max})`);
      test.info().annotations.push({ type: 'click budget', description: `${name}: ${count}/${max}` });
    },
  };
}
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: new RegExp(`^${name}`) });
const queue = (page: Page, number: string) => page.locator('.queue-row').filter({ has: page.locator(`button[aria-controls="request-${number}"]`) });

// Only fixture preparation uses HTTP. Each measured flow starts on the role's
// actual landing page and reaches every action by clicking rendered controls.
async function submitted(page: Page, date: string, stage: 'manager' | 'hr' | 'final' = 'manager', document = false) {
  await pick(page, 'Alexei');
  const created = await apiPost(page, '/requests', { leave_type_id: 1, start_date: date, end_date: date });
  expect(created.status).toBe(200);
  let request = JSON.parse(created.body) as RequestDetail;
  if (document) {
    const me = await apiGet<{ csrf_token: string }>(page, '/me');
    const upload = await page.request.post(`/api/requests/${request.id}/attachments`, {
      headers: { 'X-CSRF-Token': me.csrf_token, Origin: new URL(page.url()).origin },
      multipart: { file: { name: 'certificate.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nFictional supporting certificate') } },
    });
    expect(upload.status()).toBe(200);
    request = await apiGet<RequestDetail>(page, `/requests/${request.id}`);
  }
  expect((await apiPost(page, `/requests/${request.id}/submit`, { expected_version: request.version })).status).toBe(200);
  if (stage !== 'manager') await setupDecision(page, request.id, 'Olga', 'recommend_approve');
  if (stage === 'final') await setupDecision(page, request.id, 'Maria', 'checked_ok');
  return await apiGet<RequestDetail>(page, `/requests/${request.id}`);
}
async function setupDecision(page: Page, id: number, persona: string, outcome: string) {
  await pick(page, persona);
  const d = await apiGet<RequestDetail>(page, `/requests/${id}`);
  expect((await apiPost(page, `/requests/${id}/decide`, { expected_version: d.version, step_id: d.decidable_step!.id, outcome })).status).toBe(200);
}

test('click budgets: employee request, half day, answer and change dates', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Alexei');
  let request = 0;
  await test.step('request range ≤2', async () => {
    const b = budget(page, 'Employee request range', 2);
    await b.click(page.getByRole('link', { name: 'Request leave', exact: true }));
    await page.getByLabel('Start date').fill('2026-12-01');
    await page.getByLabel('End date').fill('2026-12-02');
    await expect(page.locator('.summary-line')).toContainText('2 working days'); await plain(page);
    await b.click(page.getByRole('button', { name: 'Send request', exact: true }));
    await page.waitForURL(/\/requests\/\d+$/); request = requestId(page);
    expect((await apiGet<RequestDetail>(page, `/requests/${request}`)).status).toBe('submitted');
    await b.done(2);
  });
  await goTo(page, '/my');
  await test.step('half day ≤3', async () => {
    const b = budget(page, 'Employee half day', 3);
    await b.click(page.getByRole('link', { name: 'Request leave', exact: true }));
    await page.getByLabel('Start date').fill('2026-12-03'); await page.getByLabel('End date').fill('2026-12-03');
    await b.click(page.getByRole('radio', { name: 'Morning', exact: true }));
    await expect(page.locator('.summary-line')).toContainText('½ working day'); await plain(page);
    await b.click(page.getByRole('button', { name: 'Send request', exact: true }));
    await page.waitForURL(/\/requests\/\d+$/);
    expect((await apiGet<RequestDetail>(page, `/requests/${requestId(page)}`)).current_revision.total_minutes).toBe(240);
    await b.done(3);
  });
  await goTo(page, '/my');
  await test.step('change dates ≤3', async () => {
    const b = budget(page, 'Employee change dates', 3);
    await b.click(page.locator(`a[href="/requests/${request}"]`).first());
    await b.click(page.getByRole('button', { name: 'Change dates', exact: true }));
    await page.locator('.modal').getByLabel('Last day', { exact: true }).fill('2026-12-01');
    await page.locator('.modal').getByLabel('Why?').fill('Trip shortened'); await plain(page);
    await b.click(page.locator('.modal').getByRole('button', { name: 'Send change', exact: true }));
    await expect(page.locator('.modal')).toHaveCount(0);
    expect((await apiGet<RequestDetail>(page, `/requests/${request}`)).current_revision.end_date).toBe('2026-12-01');
    await b.done(3);
  });
  await setupDecision(page, request, 'Olga', 'recommend_approve');
  await pick(page, 'Maria');
  let d = await apiGet<RequestDetail>(page, `/requests/${request}`);
  expect((await apiPost(page, `/requests/${request}/decide`, { expected_version: d.version, step_id: d.decidable_step!.id, outcome: 'needs_information', reason: 'What is the new travel date?' })).status).toBe(200);
  await pick(page, 'Alexei');
  await test.step('answer HR/reviewer question ≤1 + typing', async () => {
    const b = budget(page, 'Employee answer question', 1);
    await page.getByLabel('Your answer').fill('The trip is on December 1.'); await plain(page);
    await b.click(page.getByRole('button', { name: 'Send answer', exact: true }));
    await expect(page.locator('.action-card')).toHaveCount(0);
    d = await apiGet<RequestDetail>(page, `/requests/${request}`);
    expect(d.status).toBe('under_review'); expect(d.messages.some(m => m.body === 'The trip is on December 1.')).toBe(true);
    await b.done(1);
  });
});

test('click budgets: manager recommendation, refusal, HR certificate and final approval', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Alexei');
  let d = await submitted(page, '2026-12-07'); await pick(page, 'Olga');
  await test.step('manager approve ≤2', async () => {
    const b = budget(page, 'Manager approve', 2); const row = queue(page, String(d.id));
    await b.click(row.locator('.queue-row-toggle')); await b.click(row.getByRole('button', { name: 'Recommend approval', exact: true }));
    await expect(row).toHaveCount(0); await b.done(2);
  });
  d = await submitted(page, '2026-12-08'); await pick(page, 'Olga');
  await test.step('manager refuse ≤3', async () => {
    const b = budget(page, 'Manager refuse', 3); const row = queue(page, String(d.id));
    await b.click(row.getByText('More', { exact: true })); await b.click(row.getByRole('menuitem', { name: 'Recommend refusal…', exact: true }));
    await row.getByRole('textbox').fill('Minimum team coverage needed.'); await plain(page);
    await b.click(row.getByRole('button', { name: 'Recommend refusal', exact: true }));
    await expect(row).toHaveCount(0); await b.done(3);
  });
  d = await submitted(page, '2026-12-09', 'hr', true); await pick(page, 'Maria');
  await test.step('HR check including certificate ≤3', async () => {
    const b = budget(page, 'HR check and certificate', 3); const row = queue(page, String(d.id));
    await b.click(row.locator('.queue-row-toggle'));
    const certificate = row.getByRole('link', { name: /certificate.pdf/ });
    const file = await page.request.get((await certificate.getAttribute('href'))!); expect(file.status()).toBe(200);
    const download = page.waitForEvent('download'); await b.click(certificate); expect(await (await download).failure()).toBeNull();
    await b.click(row.getByRole('button', { name: 'Mark as checked', exact: true }));
    await expect(row).toHaveCount(0); await b.done(3);
  });
  await pick(page, 'Elena');
  await test.step('final approve ≤2', async () => {
    const b = budget(page, 'Final approve', 2); const row = queue(page, String(d.id));
    await b.click(row.locator('.queue-row-toggle')); await b.click(row.getByRole('button', { name: 'Approve', exact: true }));
    await expect(row).toHaveCount(0);
    expect((await apiGet<RequestDetail>(page, `/requests/${d.id}`)).status).toBe('approved'); await b.done(2);
  });
});

test('click budgets: HR correction, holiday, person and unit/month CSV', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Maria');
  const correction = await apiPost(page, '/adjustments', { employee_id: 8, leave_type_id: 1, period_year: 2026, minutes: 480, reason: 'Budget correction', basis_document: 'Attendance sheet' }); expect(correction.status).toBe(200);
  await pick(page, 'David');
  await test.step('second HR approve correction ≤2', async () => {
    const b = budget(page, 'Second HR correction', 2);
    await b.click(nav(page, 'Balances')); await b.click(page.locator('.msg', { hasText: 'Budget correction' }).getByRole('button', { name: 'Approve', exact: true }));
    await expect(page.locator('.msg', { hasText: 'Budget correction' })).toHaveCount(0); await b.done(2);
  });
  await pick(page, 'Maria');
  await test.step('add holiday ≤3', async () => {
    const b = budget(page, 'HR add holiday', 3);
    await b.click(nav(page, 'Settings')); await b.click(page.getByRole('button', { name: 'Add public holiday…' }));
    await page.locator('.modal').getByLabel('Date', { exact: true }).fill('2026-12-15'); await page.locator('.modal').getByLabel('Name', { exact: true }).fill('Service day'); await plain(page);
    await b.click(page.locator('.modal').getByRole('button', { name: 'Add holiday', exact: true })); await expect(page.locator('.modal')).toHaveCount(0); await b.done(3);
  });
  await pick(page, 'Maria');
  await test.step('add person ≤3', async () => {
    const b = budget(page, 'HR add person', 3);
    await b.click(nav(page, 'People')); await b.click(page.getByRole('button', { name: 'Add person', exact: true }));
    const m = page.locator('.modal'); await m.getByLabel('Name', { exact: true }).fill('Budget Person'); await m.getByLabel('Staff number').fill('NPS-9201');
    await m.getByLabel('Start date').fill('2026-10-08'); await m.getByRole('combobox', { name: 'Unit', exact: true }).selectOption('2');
    await m.getByRole('combobox', { name: 'Work pattern', exact: true }).selectOption('1'); await plain(page);
    await b.click(m.getByRole('button', { name: 'Add person', exact: true })); await expect(m).toHaveCount(0); await expect(page.locator('main')).toContainText('Budget Person'); await b.done(3);
  });
  await pick(page, 'Maria');
  await test.step('absences CSV for unit/month ≤3', async () => {
    const b = budget(page, 'HR absences CSV', 3); await b.click(nav(page, 'Reports'));
    await page.getByRole('combobox', { name: 'Unit', exact: true }).selectOption('2'); await page.getByLabel('Month', { exact: true }).fill('2026-11'); await plain(page);
    const download = page.waitForEvent('download'); await b.click(page.getByRole('button', { name: 'Download CSV', exact: true }));
    const result = await download; expect(result.suggestedFilename()).toBe('absences.csv'); expect(await result.failure()).toBeNull(); await b.done(2);
  });
});

test('click budgets: auditor opens request history ≤2', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Alexei'); const d = await submitted(page, '2026-12-10');
  await pick(page, 'Grace');
  const b = budget(page, 'Auditor request history', 2);
  await page.getByLabel('Request number, person or staff number').fill(d.number); await plain(page);
  await b.click(page.getByRole('button', { name: 'Search history', exact: true }));
  await b.click(page.locator(`a[href="/requests/${d.id}?history=open"]`).first());
  await expect(page.locator('details[open]').filter({ has: page.locator('summary', { hasText: /^History/ }) })).toBeVisible();
  await expect(page.locator('.rq-history')).toContainText('Alexei'); await b.done(2);
});

test('HR person shortcuts preserve employee and user context across pages', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Maria');
  const person = await apiGet<any>(page, '/employees/8');
  async function action(name: string) {
    await goTo(page, '/people');
    await page.getByLabel('Search', { exact: true }).fill('NPS-1001');
    const row = page.getByRole('row', { name: /Alexei Novak/ });
    await row.locator('summary').click(); await row.getByRole('menuitem', { name, exact: true }).click();
  }
  await action('Correct balance…');
  await expect(page.locator('.modal')).toContainText('Alexei Novak');
  expect(new URL(page.url()).searchParams.get('employee')).toBe('8');
  await page.locator('.modal').getByRole('button', { name: 'Cancel', exact: true }).click();
  await action('Set stand-in…');
  await expect(page.locator('.modal').getByRole('combobox', { name: /^Who is away/ })).toHaveValue(String(person.user.id));
  await page.locator('.modal').getByRole('button', { name: 'Cancel', exact: true }).click();
  await action('Access…');
  await expect(page.getByRole('dialog', { name: 'Alexei Novak', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('user')).toBe(String(person.user.id));
  await page.getByRole('button', { name: 'Close panel' }).click();
  await action('Enter paper form');
  await expect(page.locator('.picker-selected')).toContainText('Alexei Novak');
  expect(new URL(page.url()).searchParams.get('employee')).toBe('8');
  await goTo(page, '/people');
  await page.locator('.page-header summary').click();
  await page.getByRole('menuitem', { name: 'Import people…' }).click();
  await expect(page.locator('.modal').getByRole('heading', { name: 'Import people' })).toBeVisible();
  await expect(page.locator('.modal').getByRole('radio', { name: /^People —/ })).toBeChecked();
  await page.locator('.modal').getByRole('button', { name: 'Cancel', exact: true }).click();
  await goTo(page, '/operations'); await expect(page).toHaveURL(/\/system$/);
});
