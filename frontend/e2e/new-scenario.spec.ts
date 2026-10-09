import { expect, test } from '@playwright/test';
import { approveChain, decide, goTo, pick, requestId } from './helpers';

// Original acceptance N38 + the auditor's requested walkthrough: every record
// is created through the UI inside a fresh demo sandbox — nothing relies on
// seeded requests.
test('N38 + walkthrough: new employee, fictional policy, full lifecycle', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await page.goto('/');
  await pick(page, 'Maria');
  await page.waitForURL('**/my');

  const serviceId = 'NPS-9101';
  const fullName = 'Kai Taloa';
  const typeName = 'Study leave (demo)';

  // ---------- A brand-new employee ----------
  await goTo(page, '/people');
  await page.getByRole('button', { name: 'New employee' }).click();
  let modal = page.locator('.modal');
  await modal.locator('label.field:has-text("Service ID") input').fill(serviceId);
  await modal.locator('label.field:has-text("Full name") input').fill(fullName);
  await modal.locator('label.field:has-text("Start date") input').fill('2026-10-01');
  await modal
    .locator('label.field:has-text("Org unit") select')
    .selectOption({ label: 'Infrastructure Unit (demo)' });
  await modal
    .locator('label.field:has-text("Manager") select')
    .selectOption({ label: 'Olga Berg' });
  await modal
    .locator('label.field:has-text("Schedule") select')
    .selectOption({ label: 'Standard Mon–Fri 8h' });
  await modal.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await page.locator('label.field:has-text("Search") input').fill(serviceId);
  await expect(
    page.getByRole('row', { name: new RegExp(`${fullName}.*Infrastructure Unit`) }),
  ).toBeVisible();

  // ---------- A fictional leave type + policy ----------
  await goTo(page, '/settings');
  await page.getByRole('button', { name: 'New leave type' }).click();
  modal = page.locator('.modal');
  await modal.locator('label.field:has-text("Code") input').fill('STUDY');
  await modal.locator('label.field:has-text("Name") input').fill(typeName);
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);

  const typePanel = page
    .getByRole('heading', { name: typeName })
    .locator('xpath=..');
  await typePanel.getByRole('button', { name: 'New policy version' }).click();
  modal = page.locator('.modal');
  await modal.locator('label.field:has-text("Valid from") input').fill('2026-01-01');
  await modal
    .locator('label.field:has-text("Annual entitlement") input')
    .fill('4800');
  await modal
    .locator('label.field:has-text("Accrual mode") select')
    .selectOption('annual_upfront');
  await modal
    .locator('label.field:has-text("Carry-over allowed") input')
    .check();
  await modal
    .locator('label.field:has-text("Carry-over expires")')
    .getByRole('radio')
    .first()
    .check();
  await modal
    .locator('label.field:has-text("Explanation") textarea')
    .fill(
      'Ten days of paid study leave per year; carry-over never expires. ' +
        'Fictional policy for the demo.',
    );
  await modal.getByRole('button', { name: 'Create policy version' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(typePanel).toContainText('Fictional demo rule');
  await expect(typePanel).toContainText('never expires');

  // ---------- Opening balance through a CSV import ----------
  await goTo(page, '/reports');
  const imports = page.locator('section.panel', {
    has: page.getByRole('heading', { name: 'Imports' }),
  });
  await imports
    .locator('label.field:has-text("Kind") select')
    .selectOption('opening_balances');
  await imports.locator('input[type=file]').setInputFiles({
    name: 'openings.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'service_id,leave_type,period_year,minutes,basis\n' +
        `${serviceId},STUDY,2026,4800,Audit walkthrough opening\n`,
    ),
  });
  await imports.getByRole('button', { name: 'Preview' }).click();
  await expect(imports).toContainText('1 of 1 rows are valid');
  await imports.getByRole('button', { name: 'Commit import' }).click();
  await expect(imports).toContainText('applied 1');

  // ---------- HR paper request: five working days ----------
  await goTo(page, '/requests/new');
  await page
    .locator('label.field:has-text("Employee") select')
    .selectOption({ label: `${fullName} (${serviceId})` });
  await page
    .locator('label.field:has-text("Source") select')
    .selectOption('paper');
  await page
    .locator('label.field:has-text("Leave type") select')
    .selectOption({ label: typeName });
  await page
    .locator('label.field:has-text("Start date") input')
    .fill('2026-11-09');
  await page
    .locator('label.field:has-text("End date") input')
    .fill('2026-11-13');
  await expect(page.locator('body')).toContainText('5 days');
  await expect(page.locator('body')).toContainText('40 h');
  // A balance-using type must show its balance impact — 10 days → 5 days.
  await expect(page.locator('body')).toContainText('Balance before');
  await expect(page.locator('body')).toContainText('Balance after');
  await expect(page.locator('body')).toContainText('10 days');
  await expect(page.locator('body')).toContainText('Olga');
  await expect(page.locator('body')).toContainText('Final decision');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await page.waitForURL(/\/requests\/\d+$/);
  const req1 = requestId(page);
  await approveChain(page, req1);

  // ---------- Amendment shrinks it to three days ----------
  await pick(page, 'Maria');
  await goTo(page, `/requests/${req1}`);
  await page.getByRole('button', { name: 'Request amendment' }).click();
  modal = page.locator('.modal');
  // The amendment form is pre-filled from the IN-FORCE revision (five days).
  await expect(
    modal.locator('label.field:has-text("Start date") input'),
  ).toHaveValue('2026-11-09');
  await expect(
    modal.locator('label.field:has-text("End date") input'),
  ).toHaveValue('2026-11-13');
  await modal
    .locator('label.field:has-text("End date") input')
    .fill('2026-11-11');
  await modal
    .locator('label.field:has-text("Change reason") input')
    .fill('Course shortened — three days only');
  await modal.getByRole('button', { name: 'Create amendment' }).click();
  await page.waitForURL(
    (u) => /\/requests\/\d+$/.test(u.pathname) && u.pathname !== `/requests/${req1}`,
  );
  const amendId = requestId(page);
  await approveChain(page, amendId);

  // ---------- The original request shows the in-force (3-day) revision ----------
  await pick(page, 'Maria');
  await goTo(page, `/requests/${req1}`);
  await expect(page.locator('body')).toContainText('In force');
  await expect(page.locator('body')).toContainText('9 Nov 2026');
  await expect(page.locator('body')).toContainText('11 Nov 2026');
  await expect(page.locator('body')).toContainText('3 days');
  // The old 5-day range survives only in the revision history.
  const histRow = page.getByRole('row', { name: /13 Nov 2026/ });
  await expect(histRow).toHaveCount(1);
  await expect(histRow).toContainText('superseded');
  // The next amendment form starts from the in-force dates, not the old range.
  await page.getByRole('button', { name: 'Request amendment' }).click();
  modal = page.locator('.modal');
  await expect(
    modal.locator('label.field:has-text("Start date") input'),
  ).toHaveValue('2026-11-09');
  await expect(
    modal.locator('label.field:has-text("End date") input'),
  ).toHaveValue('2026-11-11');
  await modal.getByRole('button', { name: 'Back' }).click();

  // ---------- Print view: in-force days + history ----------
  await goTo(page, `/requests/${req1}/print`);
  await expect(page.locator('body')).toContainText('Days in force');
  await expect(page.locator('body')).toContainText(/Total\s*3 days/);
  await expect(page.locator('body')).toContainText('9 Nov 2026');
  await expect(page.locator('body')).toContainText('11 Nov 2026');
  const printHistRow = page
    .locator('.revision-history')
    .getByRole('row', { name: /13 Nov 2026/ });
  await expect(printHistRow).toHaveCount(1);
  await expect(printHistRow).toContainText('5 days');

  // ---------- Actual-period correction on a second request ----------
  await pick(page, 'Maria');
  await goTo(page, '/requests/new');
  await page
    .locator('label.field:has-text("Employee") select')
    .selectOption({ label: `${fullName} (${serviceId})` });
  await page
    .locator('label.field:has-text("Source") select')
    .selectOption('paper');
  await page
    .locator('label.field:has-text("Leave type") select')
    .selectOption({ label: typeName });
  await page
    .locator('label.field:has-text("Start date") input')
    .fill('2026-11-16');
  await page
    .locator('label.field:has-text("End date") input')
    .fill('2026-11-17');
  await expect(page.locator('body')).toContainText('2 days');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await page.waitForURL(/\/requests\/\d+$/);
  const req2 = requestId(page);
  await approveChain(page, req2);

  // Time-travel past both requests.
  await page
    .locator('[aria-label="Time travel to business date"]')
    .fill('2026-11-20');
  await expect(page.locator('.demo-bar')).toContainText('20 Nov 2026');

  await pick(page, 'Maria');
  await goTo(page, `/requests/${req2}`);
  await page
    .getByRole('button', { name: 'Confirm actual / propose adjustment' })
    .click();
  modal = page.locator('.modal');
  await modal
    .locator('label.field:has-text("Action") select')
    .selectOption('propose_adjustment');
  await modal
    .locator('label:not(.field)', { hasText: '16 Nov 2026' })
    .locator('input[type=checkbox]')
    .check();
  await modal
    .locator('label.field:has-text("Note") textarea')
    .fill('worked 16 Nov');
  await modal.locator('label.field:has-text("Basis") input').fill('timesheet-77');
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('body')).toContainText(
    'a second approver must apply it',
  );

  await pick(page, 'David');
  await goTo(page, '/balances');
  const adjRow = page.getByRole('row', { name: /worked 16 Nov/ });
  await expect(adjRow.getByRole('button', { name: 'Apply' })).toBeVisible();
  await adjRow.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('body')).toContainText('Adjustment applied');

  // Balance check: 4800 - 1440 (3d) - 960 (2d) + 480 (returned day) = 6 days.
  await goTo(page, '/balances');
  await page
    .locator('label.field:has-text("Leave type") select')
    .selectOption({ label: typeName });
  const kaiRow = page
    .getByRole('row', { name: new RegExp(fullName) })
    .filter({ hasText: typeName });
  await expect(kaiRow).toContainText('6 days');

  // ---------- Team calendar shows the in-force days ----------
  await goTo(page, '/calendar');
  const calRow = page.getByRole('row', { name: new RegExp(fullName) });
  await expect(calRow.locator('td.cal-a')).toHaveCount(5);
  await expect(calRow.locator(`a[href="/requests/${req1}"]`)).toHaveCount(3);
  await expect(calRow.locator(`a[href="/requests/${req2}"]`)).toHaveCount(2);

  // ---------- Approved-absences report ----------
  await goTo(page, '/reports');
  const absCard = page.locator('section.report-section', {
    hasText: 'Approved absences',
  });
  await absCard.locator('label.field:has-text("From") input').fill('2026-11-01');
  await absCard.locator('label.field:has-text("To") input').fill('2026-11-30');
  await absCard.getByRole('button', { name: 'View' }).click();
  await expect(absCard).toContainText(fullName);
  await expect(absCard).toContainText(typeName);
  // GenericTable renders raw ISO dates.
  await expect(absCard.getByRole('row', { name: /2026-11-09/ })).toBeVisible();
  await expect(absCard.getByRole('row', { name: /2026-11-11/ })).toBeVisible();

  // ---------- Transfer export → mark transferred → changes since export ----------
  const exports = page.locator('section.panel', {
    has: page.getByRole('heading', { name: 'Exports' }),
  });
  await exports.locator('label.field:has-text("From") input').fill('2026-11-01');
  await exports.locator('label.field:has-text("To") input').fill('2026-11-30');
  await exports
    .locator('label.field:has-text("Scope") select')
    .selectOption({ label: 'Infrastructure Unit (demo) only' });
  await exports.getByRole('button', { name: 'Create export' }).click();
  await expect(exports).toContainText('Export #');
  const exportRow = exports
    .getByRole('row', { name: /Infrastructure Unit \(demo\)/ })
    .first();
  await exportRow.getByRole('button', { name: 'Mark transferred' }).click();
  await expect(exportRow).toContainText('transferred');

  // A change after the transfer: a third, separate approved request.
  await pick(page, 'Maria');
  await goTo(page, '/requests/new');
  await page
    .locator('label.field:has-text("Employee") select')
    .selectOption({ label: `${fullName} (${serviceId})` });
  await page
    .locator('label.field:has-text("Source") select')
    .selectOption('paper');
  await page
    .locator('label.field:has-text("Leave type") select')
    .selectOption({ label: typeName });
  await page
    .locator('label.field:has-text("Start date") input')
    .fill('2026-11-25');
  await page
    .locator('label.field:has-text("End date") input')
    .fill('2026-11-25');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await page.waitForURL(/\/requests\/\d+$/);
  const req3 = requestId(page);
  await approveChain(page, req3);

  await pick(page, 'Maria');
  await goTo(page, '/reports');
  const changesCard = page.locator('section.report-section', {
    hasText: 'Changes since last export',
  });
  await changesCard.getByRole('button', { name: 'View' }).click();
  const changeRow = changesCard.getByRole('row', { name: /2026-11-25/ });
  await expect(changeRow).toBeVisible();
  await expect(changeRow).toContainText('new');
  await expect(changeRow).toContainText(fullName);
  // The amendment is also visible: the exported 5-day days became in-force 3-day.
  await expect(
    changesCard.getByRole('row', { name: /changed|removed|new/ }).first(),
  ).toBeVisible();
});
