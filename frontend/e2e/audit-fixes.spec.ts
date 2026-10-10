import { expect, test, type Page } from '@playwright/test';
import { apiGet, apiPost, approveChain, decide, goTo, more, openDetails, pick, paperPerson, requestId } from './helpers';

// One self-contained test per audit fix. Each test runs in its own browser
// context, so the first persona pick creates a fresh demo sandbox.

async function newLeaveType(page: Page, _code: string, name: string) {
  await goTo(page, '/settings/leave-types');
  await page.getByRole('button', { name: 'Add leave type…', exact: true }).click();
  const modal = page.locator('.modal');
  await modal.getByLabel('Name', { exact: true }).fill(name);
  await modal.getByLabel('Rules start on').fill('2026-01-01');
  await modal.getByRole('button', { name: 'Add leave type', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await page.getByRole('link', { name, exact: true }).click();
  return page.locator('.drawer');
}
async function openPolicyForm(page: Page, typePanel: ReturnType<Page['locator']>) {
  await typePanel.getByRole('button', { name: 'Change rules…' }).click();
  await openDetails(page, 'More rules');
  return page.locator('.modal');
}
async function fillPolicyBasics(modal: ReturnType<Page['locator']>, validFrom: string, entitlementMin: number, explanation: string) {
  await modal.getByLabel('New rules apply from').fill(validFrom);
  await modal.getByLabel('Days per year').fill(String(entitlementMin / 480));
  await modal.getByLabel('Rule explanation').fill(explanation);
}

test('F02: monthly accrual posts each month once, retry is a no-op', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await pick(page, 'Maria');

  const panel = await newLeaveType(page, 'MACCR', 'Monthly accrual (demo)');
  const modal = await openPolicyForm(page, panel);
  await fillPolicyBasics(
    modal,
    '2026-01-01',
    7200,
    'Monthly accrual of 600 minutes — fictional demo policy.',
  );
  await modal
    .locator('.field:has-text("How the days are added") select')
    .selectOption('monthly');
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(panel).toContainText('added month by month');

  await page.getByRole('button', { name: 'Close panel' }).click();
  await goTo(page, '/balances');
  async function runAccrual(monthLabel: string) {
    await more(page, 'Add entitlement…');
    const m = page.locator('.modal');
    await m.getByRole('button', { name: 'Add', exact: true }).and(m.locator(':enabled')).waitFor();
    for (const box of await m.locator('fieldset label').filter({ hasNotText: 'Monthly accrual (demo)' }).locator('input[type=checkbox]').all()) await box.uncheck();
    await m.getByLabel('Year', { exact: true }).fill('2026');
    await m.getByRole('combobox', { name: 'Month', exact: true }).selectOption({ label: monthLabel });
    const response = page.waitForResponse(r => r.url().endsWith('/accruals/run') && r.request().method() === 'POST');
    await m.getByRole('button', { name: 'Add', exact: true }).click();
    const result = await response; expect(result.status()).toBe(200);
    const data = await result.json();
    await expect(m).toContainText(data.posted === 0 ? 'Everyone already has the' : `${data.skipped_existing} already had it`);
    await m.getByRole('button', { name: 'Done' }).click();
    await expect(m).toHaveCount(0);
    return data;
  }
  const first = await runAccrual('March');
  const posted = first.posted; expect(posted).toBeGreaterThan(0); expect(first.skipped_existing).toBe(0);
  const retry = await runAccrual('March'); expect(retry.posted).toBe(0); expect(retry.skipped_existing).toBe(posted);
  const april = await runAccrual('April'); expect(april.posted).toBe(posted); expect(april.skipped_existing).toBe(0);
  await page.getByRole('button', { name: 'Monthly accrual (demo)', exact: true }).click();
  await expect(page.getByRole('row', { name: /Alexei Novak/ })).toContainText('2½ days');
});

test('F03: policy expiry round-trip — Never vs After 0 months', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await pick(page, 'Maria');

  const panel = await newLeaveType(page, 'EXPC', 'Expiry choice (demo)');

  // Version 1: carry-over allowed, "Never" expires.
  let modal = await openPolicyForm(page, panel);
  await fillPolicyBasics(modal, '2026-01-01', 4800, 'First version — carry-over never expires.');
  await modal.locator('.field:has-text("Days carry over to the next year") input').check();
  await modal.getByLabel('Carried-over days expire').selectOption('never');
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(panel).toContainText("don't expire");

  // Version 2: "After 0 months" — must not collapse back to null/Never.
  modal = await openPolicyForm(page, panel);
  await expect(modal.getByLabel('Carried-over days expire')).toHaveValue('never');
  await modal.getByLabel('Carried-over days expire').selectOption('months');
  await modal.getByLabel('Months until expiry').fill('0');
  await modal.locator('.field:has-text("New rules apply from") input').fill('2027-01-01');
  await modal
    .locator('.field:has-text("Rule explanation") textarea')
    .fill('Second version — carry-over expires at the start of the next year.');
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(panel).toContainText('expire at the start of the next year');

  // Reopening the form shows the saved choice (After + 0), not Never.
  modal = await openPolicyForm(page, panel);
  await expect(modal.getByLabel('Carried-over days expire')).toHaveValue('months');
  await expect(modal.getByLabel('Months until expiry')).toHaveValue('0');
  await modal.getByRole('button', { name: 'Cancel' }).click();
});

test('G01: carry-over limit (days) is saved and shown after reopening', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await pick(page, 'Maria');

  const panel = await newLeaveType(page, 'CLIM', 'Carry-over limit (demo)');
  const modal = await openPolicyForm(page, panel);
  await fillPolicyBasics(modal, '2026-01-01', 4800, 'Carry-over capped at five days.');
  await modal.locator('.field:has-text("Days carry over to the next year") input').check();
  const limit = modal.locator('.field:has-text("Carry-over limit")');
  await limit.locator('select').selectOption('days');
  await modal.getByLabel('Maximum days carried over').fill('5');
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(panel).toContainText('Up to 5 days carry over');

  const modal2 = await openPolicyForm(page, panel);
  const limit2 = modal2.locator('.field:has-text("Carry-over limit")');
  await expect(limit2.locator('select')).toHaveValue('days');
  await expect(modal2.getByLabel('Maximum days carried over')).toHaveValue('5');
  await modal2.getByRole('button', { name: 'Cancel' }).click();
});

test('F08: delegated final decision works, revocation cuts access', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await pick(page, 'Maria');

  // Sam's seeded paper request waits at the HR step — move it to final.
  await goTo(page, '/approvals');
  const samRow = page.locator('.queue-row', { hasText: 'Sam Oduya' });
  await samRow.getByRole('link', { name: 'Open full request' }).click();
  await page.waitForURL(u => /^\/requests\/\d+$/.test(u.pathname));
  const reqId = requestId(page);
  await decide(page);

  // HR creates the delegation Elena → Tom for final decisions.
  await goTo(page, '/settings/delegations');
  await page.getByRole('button', { name: 'Add stand-in' }).click();
  const modal = page.locator('.modal');
  await modal
    .locator('.field:has-text("Who is away?") select')
    .selectOption({ label: 'Elena Ward' });
  await modal
    .locator('.field:has-text("Who stands in?") select')
    .selectOption({ label: 'Tom Reed' });
  await modal
    .locator('.field:has-text("Which approvals?") select')
    .selectOption('final_decision');
  await modal.locator('.field:has-text("From") input').fill('2026-10-08');
  await modal.locator('.field:has-text("To") input').fill('2026-12-31');
  await modal
    .locator('.field:has-text("Reason") textarea')
    .fill('Elena on leave in December');
  await modal.getByRole('button', { name: 'Save stand-in' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(
    page.getByRole('row', { name: /Elena Ward/ }),
  ).toContainText('Active');

  // Tom sees the item, marked as delegated, and can decide.
  await pick(page, 'Tom');
  await goTo(page, '/approvals');
  const tomRow = page.locator('.queue-row', { hasText: 'Sam Oduya' });
  await expect(tomRow).toContainText('Needs your final decision');
  await expect(tomRow).toContainText('for Elena Ward');
  await tomRow.getByRole('link', { name: 'Open full request' }).click();
  await page.waitForURL(u => /^\/requests\/\d+$/.test(u.pathname));
  await expect(page.locator('body')).toContainText('for Elena Ward');
  await decide(page);
  // Tom's delegated access is scoped to the pending step — once he decides,
  // the request may already deny him. Verify the outcome as HR.
  await pick(page, 'Maria');
  await goTo(page, `/requests/${reqId}`);
  await expect(page.locator('body')).toContainText('Approved');

  // Revoke the delegation: Tom loses access to the request.
  await goTo(page, '/settings/delegations');
  await page
    .getByRole('row', { name: /Elena Ward/ })
    .getByRole('button', { name: 'End…' })
    .click();
  await page.locator('.modal').getByRole('button', { name: 'End stand-in', exact: true }).click();
  await openDetails(page, 'Ended stand-ins');
  await expect(
    page.getByRole('row', { name: /Elena Ward/ }),
  ).toContainText('Ended');

  await pick(page, 'Tom');
  await goTo(page, `/requests/${reqId}`);
  await expect(page.locator('body')).toContainText('have access to this request');
});

test('F09: tech_admin has no business-role grant or employee-link controls', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await pick(page, 'Pavel');

  await goTo(page, '/settings/users');

  // No link/re-link controls anywhere.
  await expect(
    page.getByRole('button', { name: /employee$/ }),
  ).toHaveCount(0);

  const mariaRow = page.getByRole('row', { name: /Maria Santos/ });
  await expect(mariaRow).toContainText('HR officer');
  await expect(mariaRow.getByRole('button', { name: 'Edit access…', exact: true })).toBeVisible();
  await expect(mariaRow.locator('button').filter({ hasNotText: /^Edit access…$/ })).toHaveCount(0);
  await mariaRow.click();
  const panel = page.locator('.drawer');
  await expect(panel.getByRole('checkbox', { name: /^HR officer Sets/ })).toBeDisabled();
  await expect(panel.getByRole('checkbox', { name: /^HR officer — medical files/ })).toBeDisabled();
  await expect(panel.getByRole('checkbox', { name: /^Technical administrator/ })).toBeEnabled();
  for (const role of ['Final approver', 'Correction approver', 'Auditor']) await expect(panel.getByRole('checkbox', { name: new RegExp(`^${role}`) })).toBeDisabled();
  await expect(panel.getByLabel('Linked person')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close panel' }).click();

  // Forced API calls are rejected server-side, not just hidden.
  const usersRaw = await apiGet<
    { id: number; display_name: string; version: number }[] | { items: { id: number; display_name: string; version: number }[] }
  >(page, '/users');
  const users = Array.isArray(usersRaw) ? usersRaw : usersRaw.items;
  const maria = users.find((u) => u.display_name === 'Maria Santos')!;
  const pavel = users.find((u) => u.display_name === 'Pavel Grant')!;
  const grant = await apiPost(page, `/users/${maria.id}/roles`, {
    role: 'hr_medical',
  });
  expect(grant.status).toBe(403);
  const link = await apiPost(
    page,
    `/users/${pavel.id}`,
    { employee_id: 1, expected_version: pavel.version },
    'PUT',
  );
  expect(link.status).toBe(403);
});

test('F10: revoking an hr grant removes access mid-session', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await pick(page, 'Maria');

  // HR grants Tom (a plain employee) the hr role.
  await goTo(page, '/settings/users');
  const tomRow = page.getByRole('row', { name: /Tom Reed/ });
  await tomRow.click();
  await page.locator('.drawer').getByRole('checkbox', { name: /^HR officer Sets/ }).check();
  await page.getByRole('button', { name: 'Save access' }).click();
  await expect(page.locator('.drawer')).toHaveCount(0);
  await expect(tomRow).toContainText('HR officer');

  // With hr, Tom authors a paper request for someone else.
  await pick(page, 'Tom');
  await goTo(page, '/requests/new');
  await paperPerson(page, 'Sam Oduya');
  await page
    .locator('.field:has-text("Leave type") select')
    .selectOption({ label: 'Annual leave' });
  await page
    .locator('.field:has-text("Start date") input')
    .fill('2026-12-14');
  await page
    .locator('.field:has-text("End date") input')
    .fill('2026-12-14');
  await page.getByRole('button', { name: 'Send request' }).click();
  await page.waitForURL(u => /^\/requests\/\d+$/.test(u.pathname));
  const reqId = requestId(page);
  await expect(page.locator('body')).toContainText('Sam Oduya');

  // Maria revokes Tom's hr grant.
  await pick(page, 'Maria');
  await goTo(page, '/settings/users');
  await page.getByRole('row', { name: /Tom Reed/ }).click();
  await page.locator('.drawer').getByRole('checkbox', { name: /^HR officer Sets/ }).uncheck();
  await page.getByRole('button', { name: 'Save access' }).click();
  await expect(page.locator('.drawer')).toHaveCount(0);
  await expect(page.getByRole('row', { name: /Tom Reed/ })).toContainText('No extra access');

  // Authorship is history only: Tom can no longer open the request he
  // entered — a friendly page, not a raw error.
  await pick(page, 'Tom');
  await goTo(page, `/requests/${reqId}`);
  await expect(page.locator('body')).toContainText('have access to this request');
});

test('F13: revoking a holiday keeps old requests frozen, new previews recount', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await pick(page, 'Maria');

  await goTo(page, '/settings');
  await page.getByRole('button', { name: 'Add public holiday…' }).click();
  let modal = page.locator('.modal');
  await modal.locator('.field:has-text("Date") input').fill('2026-11-10');
  await modal.locator('.field:has-text("Name") input').fill('Audit demo holiday');
  await modal.getByRole('button', { name: 'Add holiday' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await goTo(page, '/settings/holidays');
  await expect(page.getByRole('row', { name: /Audit demo holiday/ })).toContainText('Audit demo holiday');
  const holidays = await apiGet<{ items: { name: string; minutes: number; revoked_at: string | null }[] }>(page, '/calendar-exceptions');
  expect(holidays.items.find(h => h.name === 'Audit demo holiday')).toMatchObject({ minutes: 0, revoked_at: null });

  // Alexei books around the holiday — 10 Nov is not counted.
  await pick(page, 'Alexei');
  await goTo(page, '/requests/new');
  await page
    .locator('.field:has-text("Leave type") select')
    .selectOption({ label: 'Annual leave' });
  await page.locator('.field:has-text("Start date") input').fill('2026-11-09');
  await page.locator('.field:has-text("End date") input').fill('2026-11-13');
  await expect(page.locator('body')).toContainText(/4 (?:working )?days/);
  if (page.url().includes('/new')) await openDetails(page, 'Show day by day');
  await expect(page.locator('body')).toContainText('Public holiday — Audit demo holiday');
  await page.getByRole('button', { name: 'Send request' }).click();
  await page.waitForURL(u => /^\/requests\/\d+$/.test(u.pathname));
  const reqId = requestId(page);
  await approveChain(page, reqId);

  // Revoke the holiday: succeeds, and the affected request is listed.
  await pick(page, 'Maria');
  await goTo(page, '/settings/holidays');
  await page
    .getByRole('row', { name: /Audit demo holiday/ })
    .getByRole('button', { name: 'Remove Audit demo holiday' })
    .click();
  modal = page.locator('.modal');
  await modal.locator('textarea').fill('gazetted date corrected');
  await modal.getByRole('button', { name: 'Remove holiday' }).click();
  await expect(modal).toContainText('These future requests need to be checked');
  await modal.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('body')).toContainText('These future requests need to be checked');
  await openDetails(page, 'Removed holidays');
  await expect(page.locator('details').filter({ has: page.locator('summary', { hasText: /^Removed holidays/ }) }).getByRole('row', { name: /Audit demo holiday/ })).toContainText('gazetted date corrected');

  // The old, approved request keeps its frozen 4-day calculation.
  await goTo(page, `/requests/${reqId}`);
  await expect(page.locator('body')).toContainText(/4 (?:working )?days/);
  if (page.url().includes('/new')) await openDetails(page, 'Show day by day');

  // A fresh preview counts 10 Nov as a working day now.
  await pick(page, 'Tom');
  await goTo(page, '/requests/new');
  await page
    .locator('.field:has-text("Leave type") select')
    .selectOption({ label: 'Annual leave' });
  await page.locator('.field:has-text("Start date") input').fill('2026-11-09');
  await page.locator('.field:has-text("End date") input').fill('2026-11-13');
  await expect(page.locator('body')).toContainText('5 working days');
});

test('F12: a dropped response retried once creates exactly one adjustment', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await pick(page, 'Maria');
  await goTo(page, '/balances');

  // Simulate a lost response: the server commits the POST, but the reply
  // never reaches the browser — the classic double-submit scenario.
  let dropped = false;
  await page.route('**/api/adjustments**', async (route) => {
    if (route.request().method() === 'POST' && !dropped) {
      dropped = true;
      await route.fetch();
      await route.abort();
      return;
    }
    await route.continue();
  });

  await page.getByRole('button', { name: 'Correct balance…' }).click();
  const modal = page.locator('.modal');
  await modal
    .locator('.field:has-text("Person (required)") select')
    .selectOption({ label: 'Alexei Novak' });
  await modal
    .locator('.field:has-text("Leave type") select')
    .selectOption({ label: 'Annual leave' });
  await modal.locator('.field:has-text("Year") input').fill('2026');
  await openDetails(page, 'Use hours instead');
  await modal.getByLabel('Amount in').selectOption('hours');
  await modal.getByRole('spinbutton', { name: /^Hours/ }).fill('1');
  await modal.locator('.field:has-text("Reason") input').fill('audit-retry-f12');
  await modal
    .locator('.field:has-text("Reference document") input')
    .fill('doc-1');
  await modal.getByRole('button', { name: 'Send for approval' }).click();
  // The lost reply surfaces as a network error; the intent key is kept.
  await expect(modal.locator('.alert-error, [role=alert]')).toBeVisible();

  // Retry — same intent key replays the stored result instead of duplicating.
  await modal.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('body')).toContainText('Correction sent for approval.');

  await openDetails(page, 'Corrections history');
  const rows = page.getByRole('row', { name: /audit-retry-f12/ });
  await expect(rows).toHaveCount(1);

  // Server-side double check: exactly one proposed adjustment exists.
  const raw = await apiGet<
    { reason?: string }[] | { items: { reason?: string }[] }
  >(page, '/adjustments');
  const list = Array.isArray(raw) ? raw : raw.items;
  expect(list.filter((a) => a.reason === 'audit-retry-f12')).toHaveLength(1);
  expect((list.find(a => a.reason === 'audit-retry-f12') as { minutes: number }).minutes).toBe(60);
});

test('P01: EICAR content under a .pdf name is never downloadable', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await pick(page, 'Alexei');
  await goTo(page, '/requests/new');
  await page
    .locator('.field:has-text("Leave type") select')
    .selectOption({ label: 'Annual leave' });
  await page.locator('.field:has-text("Start date") input').fill('2026-11-02');
  await page.locator('.field:has-text("End date") input').fill('2026-11-03');
  await page.getByRole('button', { name: 'Send request' }).click();
  await page.waitForURL(u => /^\/requests\/\d+$/.test(u.pathname));
  const reqId = requestId(page);

  const eicar =
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
  await more(page, 'Add document…');
  const modal = page.locator('.modal');
  await modal.locator('input[type=file]').setInputFiles({
    name: 'scan-test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(eicar),
  });
  await modal.getByRole('button', { name: 'Add document' }).click();

  // Either the upload is refused outright (error stays in the modal), or the
  // modal closes and the file lands quarantined in the list.
  const errBox = page.locator('.modal .alert-error');
  await Promise.race([
    errBox.waitFor({ state: 'visible' }),
    page.locator('.modal').waitFor({ state: 'detached' }),
  ]);
  const refused = await errBox.isVisible().catch(() => false);
  if (!refused) {
    await openDetails(page, 'Documents');
    await expect(page.locator('body')).toContainText('scan-test.pdf');
    await expect(page.locator('body')).toContainText('blocked by the virus check');
    // No download link for the quarantined file.
    await expect(
      page.locator('a[href^="/api/attachments/"]', { hasText: 'scan-test.pdf' }),
    ).toHaveCount(0);
    // And a direct fetch of the stored file is denied.
    const detail = await apiGet<{
      attachments: { id: number; filename: string; scan_status: string }[];
    }>(page, `/requests/${reqId}`);
    const att = detail.attachments.find((a) => a.filename === 'scan-test.pdf');
    expect(att, 'attachment recorded').toBeTruthy();
    const res = await page.evaluate(
      async (id) => (await fetch(`/api/attachments/${id}`)).status,
      att!.id,
    );
    expect(res).toBeGreaterThanOrEqual(400);
  } else {
    await expect(modal.locator('[role=alert], .alert-error')).toBeVisible();
  }
});
