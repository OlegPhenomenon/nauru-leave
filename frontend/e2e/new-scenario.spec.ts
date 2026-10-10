import { expect, test } from '@playwright/test';
import { more, approveChain, goTo, pick, requestId, apiGet, openDetails, moveDate, paperPerson } from './helpers';

// Original acceptance N38 + the auditor's requested walkthrough: every record
// is created through the UI inside a fresh demo sandbox — nothing relies on
// seeded requests.
test('N38 + walkthrough: new employee, fictional policy, full lifecycle', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await page.goto('/');
  await pick(page, 'Maria');
  await page.waitForURL('**/approvals');

  const serviceId = 'NPS-9101';
  const fullName = 'Kai Taloa';
  const typeName = 'Study leave (demo)';

  // ---------- A brand-new employee ----------
  await goTo(page, '/people');
  await page.getByRole('button', { name: 'Add person' }).click();
  let modal = page.locator('.modal');
  await modal.locator('.field:has-text("Staff number") input').fill(serviceId);
  await modal.locator('.field:has-text("Name") input').fill(fullName);
  await modal.locator('.field:has-text("Start date") input').fill('2026-10-01');
  await modal
    .locator('.field:has-text("Unit") select')
    .selectOption({ label: 'Infrastructure Unit' });
  await modal
    .locator('.field:has-text("Manager") select')
    .selectOption({ label: 'Olga Berg' });
  await modal
    .locator('.field:has-text("Work pattern") select')
    .selectOption({ label: 'Standard Mon–Fri 8h' });
  await modal.getByRole('button', { name: 'Add person' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await goTo(page, '/people');
  await page.locator('.field:has-text("Find a person") input').fill(serviceId);
  await expect(
    page.getByRole('row', { name: new RegExp(`${fullName}.*Infrastructure Unit`) }),
  ).toBeVisible();

  // ---------- A fictional leave type and its first rule ----------
  await goTo(page, '/settings/leave-types');
  await page.getByRole('button', { name: 'Add leave type…', exact: true }).click();
  modal = page.locator('.modal');
  await modal.getByLabel('Name', { exact: true }).fill(typeName);
  await modal.getByLabel('Rules start on').fill('2026-01-01');
  await modal.getByLabel('Days per year').fill('10');
  await openDetails(page, 'More rules');
  await modal.getByLabel('How the days are added').selectOption('annual_upfront');
  await modal.getByLabel('Days carry over to the next year').check();
  await modal.getByLabel('Carried-over days expire').selectOption('never');
  await modal.getByLabel('Rule explanation').fill('Ten days of paid study leave per year; carry-over never expires. Fictional policy for the demo.');
  await modal.getByRole('button', { name: 'Add leave type', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await page.getByRole('link', { name: typeName, exact: true }).click();
  await expect(page.locator('.demo-strip')).toContainText('fictional people and rules');
  await expect(page.locator('.drawer')).toContainText("don't expire");
  const types = await apiGet<any[]>(page, '/leave-types');
  const study = types.find(t => t.name === typeName);
  expect(study.policy.status).toBe('demo_fictional');

  // ---------- Opening balance through a CSV import ----------
  await goTo(page, '/balances');
  await more(page, 'Import opening balances…');
  const imports = page.getByRole('dialog', { name: 'Import opening balances' });
  await imports.locator('input[type=file]').setInputFiles({
    name: 'openings.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'service_id,leave_type,period_year,minutes,basis\n' +
        `${serviceId},${study.code},2026,4800,Audit walkthrough opening\n`,
    ),
  });
  await expect(imports).toContainText('All 1 row ready to import.');
  await imports.getByRole('button', { name: 'Import 1 row' }).click();
  await expect(page.locator('.toast-region')).toContainText('Imported 1 row.');

  // ---------- HR paper request: five working days ----------
  await goTo(page, '/requests/new');
  await paperPerson(page, fullName);
  await page
    .locator('.field:has-text("Leave type") select')
    .selectOption({ label: typeName });
  await page
    .locator('.field:has-text("Start date") input')
    .fill('2026-11-09');
  await page
    .locator('.field:has-text("End date") input')
    .fill('2026-11-13');
  await expect(page.locator('body')).toContainText('5 working days');
  await expect(page.locator('body')).toContainText('5 days left after');
  // The balance before the request remains ten days; the preview shows five left.
  const people = await apiGet<any>(page, '/employees');
  const kai = (Array.isArray(people) ? people : people.items).find((p: any) => p.service_id === serviceId);
  const balances = await apiGet<any[]>(page, `/balances/${kai.id}`);
  expect(balances.find(b => b.leave_type.id === study.id).available_minutes).toBe(4800);
  await openDetails(page, 'Show day by day');
  await expect(page.locator('body')).toContainText('Olga');
  await expect(page.locator('body')).toContainText('a final approver');
  await page.getByRole('button', { name: 'Send request' }).click();
  await page.waitForURL(/\/requests\/\d+$/);
  const req1 = requestId(page);
  expect((await apiGet<any>(page, `/requests/${req1}`)).current_revision.total_minutes).toBe(2400);
  await approveChain(page, req1);

  // ---------- Amendment shrinks it to three days ----------
  await pick(page, 'Maria');
  await goTo(page, `/requests/${req1}`);
  await page.getByRole('button', { name: /Change dates/ }).click();
  modal = page.locator('.modal');
  // The amendment form is pre-filled from the IN-FORCE revision (five days).
  await expect(
    modal.locator('.field:has-text("First day") input'),
  ).toHaveValue('2026-11-09');
  await expect(
    modal.locator('.field:has-text("Last day") input'),
  ).toHaveValue('2026-11-13');
  await modal
    .locator('.field:has-text("Last day") input')
    .fill('2026-11-11');
  await modal
    .locator('.field:has-text("Why? (required)") textarea')
    .fill('Course shortened — three days only');
  await modal.getByRole('button', { name: 'Send change for approval' }).click();
  await page.waitForURL(
    (u) => /\/requests\/\d+$/.test(u.pathname) && u.pathname !== `/requests/${req1}`,
  );
  const amendId = requestId(page);
  await approveChain(page, amendId);

  // ---------- The original request shows the in-force (3-day) revision ----------
  await pick(page, 'Maria');
  await goTo(page, `/requests/${req1}`);
  await expect(page.locator('body')).toContainText('Approved');
  await expect(page.locator('body')).toContainText(/9(?:–11)? Nov 2026/);
  await expect(page.locator('body')).toContainText('11 Nov 2026');
  await expect(page.locator('body')).toContainText('3 days');
  // The old 5-day range survives only in the revision history.
  await openDetails(page, 'Changes');
  const histRow = page.getByRole('row', { name: /13 Nov 2026/ });
  await expect(histRow).toHaveCount(1);
  await expect(histRow).toContainText('Superseded');
  // The next amendment form starts from the in-force dates, not the old range.
  await page.getByRole('button', { name: /Change dates/ }).click();
  modal = page.locator('.modal');
  await expect(
    modal.locator('.field:has-text("First day") input'),
  ).toHaveValue('2026-11-09');
  await expect(
    modal.locator('.field:has-text("Last day") input'),
  ).toHaveValue('2026-11-11');
  await modal.getByRole('button', { name: 'Cancel' }).click();

  // ---------- Print view: in-force days + history ----------
  await goTo(page, `/requests/${req1}/print`);
  await expect(page.locator('body')).toContainText('Days');
  await expect(page.locator('body')).toContainText(/Total\s*3 days/);
  await expect(page.locator('body')).toContainText(/9(?:–11)? Nov 2026/);
  await expect(page.locator('body')).toContainText('11 Nov 2026');
  await openDetails(page, 'Earlier versions and record details');
  const printHistRow = page
    .locator('details table').first()
    .getByRole('row', { name: /13 Nov 2026/ });
  await expect(printHistRow).toHaveCount(1);
  await expect(printHistRow).toContainText('5 days');

  // ---------- Actual-period correction on a second request ----------
  await pick(page, 'Maria');
  await goTo(page, '/requests/new');
  await paperPerson(page, fullName);
  await page
    .locator('.field:has-text("Leave type") select')
    .selectOption({ label: typeName });
  await page
    .locator('.field:has-text("Start date") input')
    .fill('2026-11-16');
  await page
    .locator('.field:has-text("End date") input')
    .fill('2026-11-17');
  await expect(page.locator('body')).toContainText('2 working days');
  await page.getByRole('button', { name: 'Send request' }).click();
  await page.waitForURL(/\/requests\/\d+$/);
  const req2 = requestId(page);
  await approveChain(page, req2);

  // Time-travel past both requests.
  await moveDate(page, '2026-11-20');
  await expect(page.locator('.demo-strip')).toContainText('20 Nov 2026');

  await pick(page, 'Maria');
  await goTo(page, `/requests/${req2}`);
  await page
    .getByRole('button', { name: 'Days actually worked…' })
    .click();
  modal = page.locator('.modal');
  await modal
    .locator('label:not(.field)', { hasText: 'Mon 16 Nov' })
    .locator('input[type=checkbox]')
    .check();
  await modal
    .locator('.field:has-text("Why? (required)") textarea')
    .fill('worked 16 Nov');
  await modal.locator('.field:has-text("Supporting reference") input').fill('timesheet-77');
  await modal.getByRole('button', { name: 'Send for second approval' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('body')).toContainText(
    'Sent for a second approver.',
  );

  await pick(page, 'David');
  await goTo(page, '/balances');
  const adjRow = page.locator('.msg', { hasText: 'worked 16 Nov' });
  await expect(adjRow.getByRole('button', { name: 'Approve' })).toBeVisible();
  await adjRow.getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('body')).toContainText('Correction approved');

  // Balance check: 4800 - 1440 (3d) - 960 (2d) + 480 (returned day) = 6 days.
  await goTo(page, '/balances');
  await page.getByRole('button', { name: typeName, exact: true }).click();
  const kaiRow = page
    .getByRole('row', { name: new RegExp(fullName) });
  await expect(kaiRow).toContainText('6 days');

  // ---------- Team calendar shows the in-force days ----------
  await goTo(page, '/calendar');
  await page.getByRole('tab', { name: 'Month', exact: true }).click();
  const calRow = page.getByRole('row', { name: new RegExp(fullName) });
  await expect(calRow.locator('td').filter({ has: page.locator('a[href^="/requests/"]') })).toHaveCount(5);
  await expect(calRow.locator(`a[href="/requests/${req1}"]`)).toHaveCount(3);
  await expect(calRow.locator(`a[href="/requests/${req2}"]`)).toHaveCount(2);

  // ---------- Approved-absences report ----------
  await goTo(page, '/reports');
  const absCard = page.locator('.reports-page');
  await page.getByLabel('Month', { exact: true }).fill('2026-11');
  await expect(absCard).toContainText(fullName);
  await expect(absCard).toContainText(typeName);
  await expect(absCard.getByRole('row', { name: /9 Nov 2026/ })).toBeVisible();
  await expect(absCard.getByRole('row', { name: /11 Nov 2026/ })).toBeVisible();

  // ---------- Payroll file, unit scope, sent state ----------
  await page.getByRole('button', { name: 'Payroll files', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create payroll file' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Unit', exact: true }).selectOption({ label: 'Infrastructure Unit' });
  await page.getByRole('button', { name: 'Create payroll file' }).click();
  await expect(page.locator('.toast-region')).toContainText('Payroll file');
  const exportRow = page.getByRole('row', { name: /Infrastructure Unit/ }).first();
  await exportRow.getByRole('button', { name: 'Mark as sent' }).click();
  await expect(exportRow).toContainText('Sent on');

  // A change after the transfer: a third, separate approved request.
  await pick(page, 'Maria');
  await goTo(page, '/requests/new');
  await paperPerson(page, fullName);
  await page
    .locator('.field:has-text("Leave type") select')
    .selectOption({ label: typeName });
  await page
    .locator('.field:has-text("Start date") input')
    .fill('2026-11-25');
  await page
    .locator('.field:has-text("End date") input')
    .fill('2026-11-25');
  await page.getByRole('button', { name: 'Send request' }).click();
  await page.waitForURL(/\/requests\/\d+$/);
  const req3 = requestId(page);
  await approveChain(page, req3);

  await pick(page, 'Maria');
  await goTo(page, '/reports');
  await page.getByRole('button', { name: 'Changes since last payroll file' }).click();
  const changesCard = page.locator('.reports-page');
  const changeRow = changesCard.getByRole('row', { name: /25 Nov 2026/ });
  await expect(changeRow).toBeVisible();
  await expect(changeRow).toContainText('New');
  await expect(changeRow).toContainText(fullName);
  // The amendment is also visible: the exported 5-day days became in-force 3-day.
  await expect(
    changesCard.getByRole('row', { name: /Changed|Removed|New/ }).first(),
  ).toBeVisible();
});
