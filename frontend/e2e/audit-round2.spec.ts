import { expect, test } from '@playwright/test';
import { apiGet, apiPost, approveChain, goTo, more, openDetails, pick } from './helpers';

test('F11 round2: edit leave type identity', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Maria'); await goTo(page, '/settings/leave-types');
  await page.getByRole('link', { name: 'Annual leave', exact: true }).click();
  await page.locator('.drawer summary').filter({ hasText: 'More' }).click();
  await page.getByRole('menuitem', { name: /Rename/ }).click();
  const modal = page.locator('.modal'); await modal.getByLabel('Name', { exact: true }).fill('Annual renamed');
  const response = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/leave-types/'));
  await modal.getByRole('button', { name: 'Save', exact: true }).click(); expect((await response).status()).toBe(200);
  await expect(page.getByRole('link', { name: 'Annual renamed', exact: true })).toBeVisible();
});
test('F11 round2: add schedule version', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Maria'); await goTo(page, '/settings/schedules');
  await page.getByRole('button', { name: 'New version from a date…', exact: true }).first().click();
  const modal=page.locator('.modal'); await modal.locator('input[type=date]').fill('2026-11-01');
  const response=page.waitForResponse(r=>r.request().method()==='POST' && r.url().includes('/versions'));
  await modal.getByRole('button',{name:'Save version',exact:true}).click(); expect((await response).status()).toBe(200);
  await expect(modal).toHaveCount(0);
});
test('F11 round2: change employee schedule', async ({ page }) => {
  await page.goto('/'); await pick(page,'Maria'); await goTo(page,'/people/8');
  await page.locator('.kv-row', { hasText: 'Work pattern' }).getByRole('button', { name: 'Change…' }).click(); const modal=page.locator('.modal');
  await modal.locator('select').selectOption('1'); await modal.locator('input[type=date]').fill('2026-11-01');
  const response=page.waitForResponse(r=>r.request().method()==='POST' && r.url().includes('/schedule'));
  await modal.getByRole('button',{name:'Save change',exact:true}).click(); expect((await response).status()).toBe(200);
  await expect(modal).toHaveCount(0);
});
test('F09 round2: unlink inactive user without reactivation', async ({ page }) => {
  await page.goto('/'); await pick(page,'Maria');
  const raw=await apiGet<any>(page,'/users'); const users=Array.isArray(raw)?raw:raw.items; const tom=users.find((u:any)=>u.display_name==='Tom Reed');
  expect((await apiPost(page,`/users/${tom.id}`,{email:tom.email,display_name:tom.display_name,active:false,expected_version:tom.version},'PUT')).status).toBe(200);
  await goTo(page,`/settings/users?user=${tom.id}`);
  await openDetails(page,'User details');
  await page.getByLabel('Linked person').selectOption(''); const response=page.waitForResponse(r=>r.request().method()==='PUT' && r.url().includes('/users/'));
  await page.getByRole('button',{name:'Save access',exact:true}).click(); expect((await response).status()).toBe(200);
  const next=await apiGet<any>(page,'/users');const updated=(Array.isArray(next)?next:next.items).find((u:any)=>u.id===tom.id); expect(updated.active).toBe(false); expect(updated.employee).toBeNull();
});
test('F13 round2: revoked exception displays reason',async ({page})=>{
  await page.goto('/');await pick(page,'Maria'); const raw=await apiGet<any>(page,'/calendar-exceptions');const holidays=Array.isArray(raw)?raw:raw.items;
  expect((await apiPost(page,`/calendar-exceptions/${holidays[0].id}/revoke`,{reason:'round2 calendar correction'})).status).toBe(200);
  await goTo(page,'/settings/holidays'); await openDetails(page,'Removed holidays');
  await expect(page.locator('details').filter({has:page.locator('summary', {hasText:'Removed holidays'})}).getByRole('row',{name:new RegExp(holidays[0].name)}).first()).toContainText('round2 calendar correction');
});
test('F05 round2: actual correction confirms second approval and preserves adjustment identity',async ({page})=>{
  await page.goto('/');await pick(page,'Alexei'); const created=await apiPost(page,'/requests',{leave_type_id:1,start_date:'2026-11-09',end_date:'2026-11-09'});expect(created.status).toBe(200);const req=JSON.parse(created.body);
  expect((await apiPost(page,`/requests/${req.id}/submit`,{expected_version:req.version})).status).toBe(200);await approveChain(page,req.id);await pick(page,'Maria');
  expect((await apiPost(page,'/demo/clock',{date:'2026-11-10'})).status).toBe(200);await goTo(page,`/requests/${req.id}`);
  await page.getByRole('button',{name:'Days actually worked…'}).click();const modal=page.locator('.modal');await modal.locator('input[type=checkbox]').first().check();await modal.locator('textarea').fill('worked');await modal.locator('input[type=text]').fill('attendance');
  const response=page.waitForResponse(r=>r.url().endsWith('/actual') && r.request().method()==='POST');await modal.getByRole('button',{name:'Send for second approval',exact:true}).click();const body=await (await response).json();expect(body.adjustment_ids.length).toBe(1);
  await expect(page.locator('.toast-region')).toContainText('Sent for a second approver.');
  // Correction identity remains checked against the server; the UI uses plain words.
  const rawCorrections=await apiGet<any>(page,'/adjustments'); const corrections=Array.isArray(rawCorrections)?rawCorrections:rawCorrections.items;expect(corrections.find(a=>a.id===body.adjustment_ids[0]).reason).toMatch(/: worked$/); expect(corrections.find(a=>a.id===body.adjustment_ids[0]).minutes).toBe(480);
});
test('F07 round2: export scope and transfer author',async ({page})=>{
  await page.goto('/');await pick(page,'Maria');await goTo(page,'/reports?r=payroll');
  await page.getByRole('combobox', { name: 'Unit', exact: true }).selectOption('2');await page.getByRole('button',{name:'Create payroll file'}).click();await expect(page.locator('.toast-region')).toContainText('Infrastructure');await expect(page.getByRole('row').last()).toContainText('Infrastructure');
  await page.getByRole('button',{name:'Mark as sent'}).click();await expect(page.getByRole('row').last()).toContainText('by Maria Santos');
});
