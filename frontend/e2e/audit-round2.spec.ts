import { expect, test } from '@playwright/test';
import { apiGet, apiPost, approveChain, goTo, pick } from './helpers';

test('F11 round2: edit leave type identity', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Maria'); await goTo(page, '/settings');
  const panel = page.getByRole('heading', { name: /^Annual leave/ }).locator('xpath=..');
  await panel.getByRole('button', { name: 'Edit', exact: true }).click();
  const modal = page.locator('.modal'); await modal.locator('label.field:has-text("Name") input').fill('Annual renamed');
  const response = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/leave-types/'));
  await modal.getByRole('button', { name: 'Save', exact: true }).click(); expect((await response).status()).toBe(200);
  await expect(page.getByRole('heading', { name: /^Annual renamed/ })).toBeVisible();
});
test('F11 round2: add schedule version', async ({ page }) => {
  await page.goto('/'); await pick(page, 'Maria'); await goTo(page, '/settings'); await page.getByRole('tab', { name: 'Schedules' }).click();
  await page.getByRole('button', { name: 'Add version', exact: true }).first().click();
  const modal=page.locator('.modal'); await modal.locator('input[type=date]').fill('2026-11-01');
  const response=page.waitForResponse(r=>r.request().method()==='POST' && r.url().includes('/versions'));
  await modal.getByRole('button',{name:'Add version',exact:true}).click(); expect((await response).status()).toBe(200);
  await expect(modal).toHaveCount(0);
});
test('F11 round2: change employee schedule', async ({ page }) => {
  await page.goto('/'); await pick(page,'Maria'); await goTo(page,'/people/8');
  await page.getByRole('button',{name:'Change schedule',exact:true}).click(); const modal=page.locator('.modal');
  await modal.locator('select').selectOption('1'); await modal.locator('input[type=date]').fill('2026-11-01');
  const response=page.waitForResponse(r=>r.request().method()==='POST' && r.url().includes('/schedule'));
  await modal.getByRole('button',{name:'Change schedule',exact:true}).click(); expect((await response).status()).toBe(200);
  await expect(modal).toHaveCount(0);
});
test('F09 round2: unlink inactive user without reactivation', async ({ page }) => {
  await page.goto('/'); await pick(page,'Maria');
  const raw=await apiGet<any>(page,'/users'); const users=Array.isArray(raw)?raw:raw.items; const tom=users.find((u:any)=>u.display_name==='Tom Reed');
  expect((await apiPost(page,`/users/${tom.id}`,{email:tom.email,display_name:tom.display_name,active:false,expected_version:tom.version},'PUT')).status).toBe(200);
  await goTo(page,'/settings'); await page.getByRole('tab',{name:'Users & roles'}).click();
  await page.getByRole('row',{name:/Tom Reed/}).getByRole('button',{name:'Re-link employee'}).click(); const modal=page.locator('.modal');
  await modal.locator('select').selectOption('0'); const response=page.waitForResponse(r=>r.request().method()==='PUT' && r.url().includes('/users/'));
  await modal.getByRole('button',{name:'Unlink',exact:true}).click(); expect((await response).status()).toBe(200);
  const next=await apiGet<any>(page,'/users');const updated=(Array.isArray(next)?next:next.items).find((u:any)=>u.id===tom.id); expect(updated.active).toBe(false); expect(updated.employee).toBeNull();
});
test('F13 round2: revoked exception displays reason',async ({page})=>{
  await page.goto('/');await pick(page,'Maria'); const raw=await apiGet<any>(page,'/calendar-exceptions');const holidays=Array.isArray(raw)?raw:raw.items;
  expect((await apiPost(page,`/calendar-exceptions/${holidays[0].id}/revoke`,{reason:'round2 calendar correction'})).status).toBe(200);
  await goTo(page,'/settings');await page.getByRole('tab',{name:'Holidays'}).click(); await expect(page.getByRole('row',{name:new RegExp(holidays[0].name)}).first()).toContainText('round2 calendar correction');
});
test('F05 round2: actual correction displays adjustment ids',async ({page})=>{
  await page.goto('/');await pick(page,'Alexei'); const created=await apiPost(page,'/requests',{leave_type_id:1,start_date:'2026-11-09',end_date:'2026-11-09'});expect(created.status).toBe(200);const req=JSON.parse(created.body);
  expect((await apiPost(page,`/requests/${req.id}/submit`,{expected_version:req.version})).status).toBe(200);await approveChain(page,req.id);await pick(page,'Maria');
  expect((await apiPost(page,'/demo/clock',{date:'2026-11-10'})).status).toBe(200);await goTo(page,`/requests/${req.id}`);
  await page.getByRole('button',{name:'Confirm actual / propose adjustment'}).click();const modal=page.locator('.modal');await modal.locator('select').selectOption('propose_adjustment');await modal.locator('input[type=checkbox]').first().check();await modal.locator('textarea').fill('worked');await modal.locator('input[type=text]').fill('attendance');
  const response=page.waitForResponse(r=>r.url().endsWith('/actual') && r.request().method()==='POST');await modal.getByRole('button',{name:'Save',exact:true}).click();const body=await (await response).json();expect(body.adjustment_ids.length).toBe(1);await expect(page.locator('.alert',{hasText:'Proposed'})).toContainText(`#${body.adjustment_ids[0]}`);
});
test('F07 round2: export scope and transfer author',async ({page})=>{
  await page.goto('/');await pick(page,'Maria');await goTo(page,'/reports'); const section=page.locator('section',{has:page.getByRole('heading',{name:'Exports (transfer file)'})});
  await section.locator('label.field:has-text("Scope") select').selectOption('2');await section.getByRole('button',{name:'Create export'}).click();await expect(section.locator('.alert')).toContainText('Infrastructure');await expect(section.getByRole('row').last()).toContainText('Infrastructure');
  await section.getByRole('button',{name:/Mark transferred/}).click();await expect(section.getByRole('row').last()).toContainText('by Maria Santos');
});
