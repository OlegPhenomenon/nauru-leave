import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { RequestDetail } from '../src/api/types';
import { apiGet, apiPost, approveChain, goTo, moveDate, pick } from './helpers';

async function makeRequest(page: Page, day: string) {
  await pick(page, 'Alexei');
  const made = await apiPost(page, '/requests', {
    leave_type_id: 1, start_date: day, end_date: day,
  });
  expect(made.status).toBe(200);
  const d = JSON.parse(made.body) as RequestDetail;
  expect((await apiPost(page, `/requests/${d.id}/submit`, {
    expected_version: d.version,
  })).status).toBe(200);
  return d;
}

test('U01 change demo date refreshes the open request without navigating', async ({ page }) => {
  await page.goto('/');
  const d = await makeRequest(page, '2026-11-09');
  await approveChain(page, d.id);
  await pick(page, 'Maria');
  await goTo(page, `/requests/${d.id}`);
  await expect(page.locator('.rq-status-text')).toContainText('starts');
  await moveDate(page, '2026-11-12');
  // Crucial: no goTo, reload, switch user or re-opening the request after moveDate.
  await expect(page.locator('.rq-status-text')).toContainText('ended');
  await expect(page.getByRole('button', { name: /^Days actually worked/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Change dates/ })).toHaveCount(0);
});

test('U02 opening Emails fetches newly delivered messages on the same page', async ({ page }) => {
  await page.goto('/');
  const d = await makeRequest(page, '2026-12-07');
  await pick(page, 'Olga');
  await goTo(page, '/approvals');
  const button = page.locator('.demo-strip').getByRole('button', { name: /^Emails \(/ });
  await button.click();
  const drawer = page.getByRole('dialog', { name: 'Emails', exact: true });
  await drawer.getByRole('tab', { name: /^Everyone/ }).click();
  await drawer.getByRole('button', { name: '✕ Close', exact: true }).click();

  const before = await apiGet<{items:any[]}>(page, '/demo/mailbox');
  const row = page.locator('.queue-row').filter({has: page.locator(`button[aria-controls="request-${d.id}"]`)});
  await row.locator('.queue-row-toggle').click();
  await row.getByRole('button', { name: 'Recommend approval', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page).toHaveURL(/\/approvals$/);

  let delivered:any[]=[];
  await expect.poll(async()=> {
    delivered=(await apiGet<{items:any[]}>(page,'/demo/mailbox')).items;
    return delivered.filter(m=>!before.items.some(old=>old.id===m.id)).length;
  },{timeout:20_000}).toBeGreaterThan(0);
  // The server has delivered the messages. No navigation or persona change.
  await button.click();
  await drawer.getByRole('tab', { name: /^Everyone/ }).click();
  await expect(drawer.locator('.mail-item')).toHaveCount(delivered.length);
  const me = await apiGet<{user:{email:string}}>(page, '/me');
  const assertCounts = async (items: {to_email:string}[]) => {
    const mine = items.filter(m => m.to_email === me.user.email).length;
    expect(mine).toBeLessThan(items.length);
    await expect(drawer.getByRole('tab', {name:/^To /})).toContainText(`(${mine})`);
    await expect(drawer.getByRole('tab', {name:/^Everyone/})).toContainText(`(${items.length})`);
    await expect(button).toHaveText(`Emails (${mine})`);
  };
  await assertCounts(delivered);
  const latest = await apiGet<RequestDetail>(page, `/requests/${d.id}`);
  expect((await apiPost(page, `/requests/${d.id}/messages`, {body:'Fictional follow-up', expected_version:latest.version})).status).toBe(200);
  await expect.poll(async () => (await apiGet<{items:any[]}>(page, '/demo/mailbox')).items.length, {timeout:20_000}).toBeGreaterThan(delivered.length);
  const after = (await apiGet<{items:any[]}>(page, '/demo/mailbox')).items;
  // Drawer stays open while the worker delivers; the personal strip count follows too.
  await expect(drawer.locator('.mail-item')).toHaveCount(after.length, {timeout:10_000});
  await assertCounts(after);
  const refresh = page.waitForResponse(r => r.url().endsWith('/api/demo/mailbox'));
  await drawer.getByRole('button', {name:'Refresh',exact:true}).click();
  await refresh;

});

test('U03 interrupted attachment must not silently submit the previous employee', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Maria');
  await goTo(page, '/requests/new?paper=1');
  await page.getByRole('combobox', {name:'Employee',exact:true}).fill('Alexei Novak');
  await page.getByRole('option', {name:/Alexei Novak/}).click();
  await page.getByLabel('Leave type',{exact:true}).selectOption({label:'Annual leave'});
  await page.getByLabel('Start date',{exact:true}).fill('2026-12-14');
  await page.getByLabel('End date',{exact:true}).fill('2026-12-14');
  const uploadDetails=page.locator('details').filter({has:page.locator('summary',{hasText:/^Add a document/})});
  await uploadDetails.locator(':scope > summary').click();
  await page.locator('input[type=file]').setInputFiles({
    name:'ordinary_demo.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nFictional interrupted upload'),
  });
  let interrupted=false;
  await page.route('**/api/requests/*/attachments',async route=> {
    if(!interrupted){interrupted=true;await route.abort('failed');}else await route.continue();
  });
  await expect(page.locator('.summary-line')).toContainText('1 working day');
  const created=page.waitForResponse(r=>r.url().endsWith('/api/requests')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Send request',exact:true}).click();
  const first=await (await created).json() as RequestDetail;
  await expect.poll(()=>interrupted).toBe(true);
  await expect(page.getByRole('button',{name:'Send request',exact:true})).toBeEnabled();
  await expect(page).toHaveURL(/\/requests\/new\?paper=1$/);

  await expect(page.locator('.picker-selected')).toContainText('Alexei Novak');
  await page.getByRole('button', {name:'Start a new request',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'New request started'})).toContainText('Alexei Novak');
  await expect(page.getByRole('button',{name:'Remove',exact:true})).toHaveCount(0);
  await page.getByRole('combobox',{name:'Employee',exact:true}).fill('Nia Fox');
  await page.getByRole('option',{name:/Nia Fox/}).click();
  await expect(page.locator('.picker-selected')).toContainText('Nia Fox');
  const sent=page.waitForResponse(r=>/\/api\/requests\/\d+\/submit$/.test(r.url())&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Send request',exact:true}).click();
  const submitted=await (await sent).json() as RequestDetail;
  expect(submitted.employee.full_name).toBe('Nia Fox');
  expect(submitted.employee.id).not.toBe(first.employee.id);
  expect(submitted.id).not.toBe(first.id);
  expect(submitted.attachments).toHaveLength(0);
  const old = await apiGet<RequestDetail>(page, `/requests/${first.id}`);
  expect(old.employee.id).toBe(first.employee.id);
  expect(old.status).toBe('draft');
  expect(old.attachments).toHaveLength(0);
  await expect(page.locator('.toast-region')).toContainText('Paper request sent for Nia Fox');
});

async function interruptedPaper(page: Page) {
  await page.goto('/');
  await pick(page, 'Maria');
  await goTo(page, '/requests/new?paper=1');
  await page.getByRole('combobox', {name:'Employee', exact:true}).fill('Alexei Novak');
  await page.getByRole('option', {name:/Alexei Novak/}).click();
  await page.getByLabel('Paper form received on').fill('2026-10-05');
  await page.getByLabel('Leave type', {exact:true}).selectOption({label:'Annual leave'});
  await page.getByLabel('Start date', {exact:true}).fill('2026-12-14');
  await page.getByLabel('End date', {exact:true}).fill('2026-12-14');
  await page.locator('summary').filter({hasText:/^Add a document/}).click();
  await page.locator('input[type=file]').setInputFiles({
    name:'retry.pdf', mimeType:'application/pdf', buffer:Buffer.from('%PDF-1.4\nFictional retry document'),
  });
  let failed = false;
  await page.route('**/api/requests/*/attachments', async route => {
    if (!failed) { failed = true; await route.abort('failed'); }
    else await route.continue();
  });
  await expect(page.locator('.summary-line')).toContainText('1 working day');
  const created = page.waitForResponse(r => r.url().endsWith('/api/requests') && r.request().method() === 'POST');
  await page.getByRole('button', {name:'Send request', exact:true}).click();
  const draft = await (await created).json() as RequestDetail;
  await expect.poll(() => failed).toBe(true);
  await expect(page.getByRole('button', {name:'Send request', exact:true})).toBeEnabled();
  expect((await apiGet<RequestDetail>(page, `/requests/${draft.id}`)).status).toBe('draft');
  return draft;
}

test('U03 same-person upload retry reuses one draft and preserves paper received date', async ({page}) => {
  const first = await interruptedPaper(page);
  await expect(page.getByRole('button', {name:'Request for myself instead'})).toBeDisabled();
  await page.getByLabel('Paper form received on').fill('2026-10-06');
  const sent = page.waitForResponse(r => /\/api\/requests\/\d+\/submit$/.test(r.url()));
  await page.getByRole('button', {name:'Send request', exact:true}).click();
  const submitted = await (await sent).json() as RequestDetail;
  expect(submitted.id).toBe(first.id);
  expect(submitted.employee.full_name).toBe('Alexei Novak');
  expect(submitted.source).toBe('paper');
  expect(submitted.paper_received_date).toBe('2026-10-06');
  expect(submitted.attachments).toHaveLength(1);
  const requests = await apiGet<{items:RequestDetail[]}>(page, `/requests?scope=all&employee_id=${first.employee.id}`);
  expect(requests.items.filter(r => r.start_date === '2026-12-14')).toHaveLength(1);
});

test('U03 paper to self explicitly starts a separate request without its document', async ({page}) => {
  const first = await interruptedPaper(page);
  await page.getByRole('button', {name:'Start a new request', exact:true}).click();
  await page.getByRole('button', {name:'Request for myself instead'}).click();
  const sent = page.waitForResponse(r => /\/api\/requests\/\d+\/submit$/.test(r.url()));
  await page.getByRole('button', {name:'Send request', exact:true}).click();
  const submitted = await (await sent).json() as RequestDetail;
  expect(submitted.employee.full_name).toBe('Maria Santos');
  expect(submitted.source).toBe('self');
  expect(submitted.id).not.toBe(first.id);
  expect(submitted.attachments).toHaveLength(0);
  expect(submitted.paper_received_date).toBeNull();
  const old = await apiGet<RequestDetail>(page, `/requests/${first.id}`);
  expect(old.status).toBe('draft');
  expect(old.paper_received_date).toBe('2026-10-05');
  expect(old.employee.id).toBe(first.employee.id);
});

test('U01 date refresh updates an open balance summary and preserves unsaved request input', async ({page}) => {
  await page.goto('/');
  const d = await makeRequest(page, '2026-11-09');
  await approveChain(page, d.id);
  await pick(page, 'Alexei');
  await goTo(page, '/my');
  const annual = page.locator('.day-row').filter({hasText:'Annual leave'});
  await expect(annual).toContainText('1 day booked');
  await moveDate(page, '2026-11-12');
  await expect(annual).not.toContainText('booked');
  await expect(annual).toContainText('19 days left');
  await goTo(page, '/requests/new');
  await page.getByLabel('Start date', {exact:true}).fill('2026-12-14');
  await page.getByLabel('End date', {exact:true}).fill('2026-12-14');
  await page.locator('summary').filter({hasText:/^Add a note/}).click();
  await page.getByLabel('Note (optional)').fill('Keep this unsaved note');
  const refreshed = page.waitForResponse(r => r.url().endsWith('/api/requests/preview'));
  await moveDate(page, '2026-11-13');
  await refreshed;
  await expect(page.getByLabel('Note (optional)')).toHaveValue('Keep this unsaved note');
  await expect(page.getByLabel('Start date', {exact:true})).toHaveValue('2026-12-14');
  await expect(page.getByLabel('End date', {exact:true})).toHaveValue('2026-12-14');
});
