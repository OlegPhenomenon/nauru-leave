import { expect, test, type Page } from '@playwright/test';
import { apiGet, apiPost, approveChain, decide, goTo, pick, requestId } from './helpers';

// One self-contained test per audit fix. Each test runs in its own browser
// context, so the first persona pick creates a fresh demo sandbox.

async function newLeaveType(page: Page, code: string, name: string) {
  await goTo(page, '/settings');
  await page.getByRole('button', { name: 'New leave type' }).click();
  const modal = page.locator('.modal');
  await modal.locator('label.field:has-text("Code") input').fill(code);
  await modal.locator('label.field:has-text("Name") input').fill(name);
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  return page.getByRole('heading', { name }).locator('xpath=..');
}

async function openPolicyForm(page: Page, typePanel: ReturnType<Page['locator']>) {
  await typePanel.getByRole('button', { name: 'New policy version' }).click();
  const modal = page.locator('.modal');
  return modal;
}

async function fillPolicyBasics(
  modal: ReturnType<Page['locator']>,
  validFrom: string,
  entitlementMin: number,
  explanation: string,
) {
  await modal.locator('label.field:has-text("Valid from") input').fill(validFrom);
  await modal
    .locator('label.field:has-text("Annual entitlement") input')
    .fill(String(entitlementMin));
  await modal
    .locator('label.field:has-text("Explanation") textarea')
    .fill(explanation);
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
    .locator('label.field:has-text("Accrual mode") select')
    .selectOption('monthly');
  await modal.getByRole('button', { name: 'Create policy version' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(panel).toContainText('accrual monthly');

  async function runAccrual(monthLabel: string) {
    await page.getByRole('button', { name: 'Run accrual' }).click();
    const m = page.locator('.modal');
    await m
      .locator('label.field:has-text("Leave type") select')
      .selectOption({ label: 'Monthly accrual (demo)' });
    await m.locator('label.field:has-text("Period year") input').fill('2026');
    await m
      .locator('label.field:has(> span.field-label:text-is("Month")) select')
      .selectOption({ label: monthLabel });
    await m.getByRole('button', { name: 'Run accrual' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
  }

  await goTo(page, '/balances');
  await runAccrual('March');
  const msg = page.locator('.alert', { hasText: 'Accrual done' });
  await expect(msg).toBeVisible();
  const posted = Number((await msg.textContent())!.match(/posted (\d+)/)![1]);
  expect(posted).toBeGreaterThan(0);
  await expect(msg).toContainText('skipped existing 0');

  // Repeating the same month posts nothing (600 min per employee, once).
  await runAccrual('March');
  await expect(
    page.locator('.alert', { hasText: 'Accrual done' }),
  ).toContainText(`posted 0, skipped existing ${posted}`);

  // The next month posts another 600 minutes per employee.
  await runAccrual('April');
  await expect(
    page.locator('.alert', { hasText: 'Accrual done' }),
  ).toContainText(`posted ${posted}, skipped existing 0`);

  await page
    .locator('label.field:has-text("Leave type") select')
    .selectOption({ label: 'Monthly accrual (demo)' });
  await expect(
    page
      .getByRole('row', { name: /Alexei Novak/ })
      .filter({ hasText: 'Monthly accrual' }),
  ).toContainText('20 h');
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
  await modal.locator('label.field:has-text("Carry-over allowed") input').check();
  await modal
    .locator('label.field:has-text("Carry-over expires")')
    .getByRole('radio')
    .first()
    .check();
  await modal.getByRole('button', { name: 'Create policy version' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(panel).toContainText('never expires');

  // Version 2: "After 0 months" — must not collapse back to null/Never.
  modal = await openPolicyForm(page, panel);
  const expiry = modal.locator('label.field:has-text("Carry-over expires")');
  await expect(expiry.getByRole('radio').first()).toBeChecked();
  await expiry.getByRole('radio').nth(1).check();
  await expiry.locator('input[type=number]').fill('0');
  await modal.locator('label.field:has-text("Valid from") input').fill('2027-01-01');
  await modal
    .locator('label.field:has-text("Explanation") textarea')
    .fill('Second version — carry-over expires at the start of the next year.');
  await modal.getByRole('button', { name: 'Create policy version' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(panel).toContainText('expires at the start of the next year');

  // Reopening the form shows the saved choice (After + 0), not Never.
  modal = await openPolicyForm(page, panel);
  const expiry2 = modal.locator('label.field:has-text("Carry-over expires")');
  await expect(expiry2.getByRole('radio').nth(1)).toBeChecked();
  await expect(expiry2.locator('input[type=number]')).toHaveValue('0');
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
  await modal.locator('label.field:has-text("Carry-over allowed") input').check();
  const limit = modal.locator('label.field:has-text("Carry-over limit")');
  await limit.getByRole('radio').nth(1).check();
  await limit.locator('input[type=number]').fill('5');
  await modal.getByRole('button', { name: 'Create policy version' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(panel).toContainText('limit 5 days (40 h)');

  const modal2 = await openPolicyForm(page, panel);
  const limit2 = modal2.locator('label.field:has-text("Carry-over limit")');
  await expect(limit2.getByRole('radio').nth(1)).toBeChecked();
  await expect(limit2.locator('input[type=number]')).toHaveValue('5');
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
  const samRow = page.getByRole('row', { name: /Sam Oduya/ });
  await samRow.locator('a').first().click();
  await page.waitForURL(/\/requests\/\d+$/);
  const reqId = requestId(page);
  await decide(page);

  // HR creates the delegation Elena → Tom for final decisions.
  await goTo(page, '/settings');
  await page.getByRole('tab', { name: 'Delegations' }).click();
  await page.getByRole('button', { name: 'New delegation' }).click();
  const modal = page.locator('.modal');
  await modal
    .locator('label.field:has-text("being substituted") select')
    .selectOption({ label: 'Elena Ward' });
  await modal
    .locator('label.field:has-text("who acts") select')
    .selectOption({ label: 'Tom Reed' });
  await modal
    .locator('label.field:has-text("Scope") select')
    .selectOption('final_decision');
  await modal.locator('label.field:has-text("Valid from") input').fill('2026-10-08');
  await modal.locator('label.field:has-text("Valid to") input').fill('2026-12-31');
  await modal
    .locator('label.field:has-text("Reason") input')
    .fill('Elena on leave in December');
  await modal.getByRole('button', { name: 'Create delegation' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(
    page.getByRole('row', { name: /Elena Ward/ }),
  ).toContainText('active');

  // Tom sees the item, marked as delegated, and can decide.
  await pick(page, 'Tom');
  await goTo(page, '/approvals');
  const tomRow = page.getByRole('row', { name: /Sam Oduya/ });
  await expect(tomRow).toContainText('Final decision');
  await expect(tomRow).toContainText('acting for Elena Ward');
  await tomRow.locator('a').first().click();
  await page.waitForURL(/\/requests\/\d+$/);
  await expect(page.locator('body')).toContainText('acting for Elena Ward');
  await decide(page);
  // Tom's delegated access is scoped to the pending step — once he decides,
  // the request may already deny him. Verify the outcome as HR.
  await pick(page, 'Maria');
  await goTo(page, `/requests/${reqId}`);
  await expect(page.locator('body')).toContainText('Approved');

  // Revoke the delegation: Tom loses access to the request.
  await goTo(page, '/settings');
  await page.getByRole('tab', { name: 'Delegations' }).click();
  await page
    .getByRole('row', { name: /Elena Ward/ })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await expect(
    page.getByRole('row', { name: /Elena Ward/ }),
  ).toContainText('revoked');

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

  await goTo(page, '/settings');
  await page.getByRole('tab', { name: 'Users & roles' }).click();

  // No link/re-link controls anywhere.
  await expect(
    page.getByRole('button', { name: /employee$/ }),
  ).toHaveCount(0);

  // No ✕ revoke on business roles (e.g. Maria's hr badge).
  const mariaRow = page.getByRole('row', { name: /Maria Santos/ });
  const hrBadge = mariaRow
    .locator('span.badge', { hasText: 'hr' })
    .filter({ hasNotText: 'medical' });
  await expect(hrBadge).toContainText('hr');
  await expect(hrBadge.locator('button')).toHaveCount(0);

  // "Add role" (if offered) can only grant tech admin — never business roles.
  const addRole = page.getByRole('button', { name: 'Add role' });
  if (await addRole.count()) {
    await addRole.first().click();
    const roleSelect = page.locator(
      '.modal label.field:has-text("Role") select',
    );
    await expect(roleSelect.locator('option')).toHaveCount(1);
    await expect(roleSelect.locator('option').first()).toHaveText('tech admin');
    await page.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
  }

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
  await goTo(page, '/settings');
  await page.getByRole('tab', { name: 'Users & roles' }).click();
  const tomRow = page.getByRole('row', { name: /Tom Reed/ });
  await tomRow.getByRole('button', { name: 'Add role' }).click();
  const roleModal = page.locator('.modal');
  await roleModal
    .locator('label.field:has-text("Role") select')
    .selectOption('hr');
  await roleModal.getByRole('button', { name: 'Grant role' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(tomRow).toContainText('hr');

  // With hr, Tom authors a paper request for someone else.
  await pick(page, 'Tom');
  await goTo(page, '/requests/new');
  await page
    .locator('label.field:has-text("Employee") select')
    .selectOption({ label: 'Sam Oduya (NPS-1005)' });
  await page
    .locator('label.field:has-text("Source") select')
    .selectOption('paper');
  await page
    .locator('label.field:has-text("Leave type") select')
    .selectOption({ label: 'Annual leave' });
  await page
    .locator('label.field:has-text("Start date") input')
    .fill('2026-12-14');
  await page
    .locator('label.field:has-text("End date") input')
    .fill('2026-12-14');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await page.waitForURL(/\/requests\/\d+$/);
  const reqId = requestId(page);
  await expect(page.locator('body')).toContainText('Sam Oduya');

  // Maria revokes Tom's hr grant.
  await pick(page, 'Maria');
  await goTo(page, '/settings');
  await page.getByRole('tab', { name: 'Users & roles' }).click();
  const hrBadge = page
    .getByRole('row', { name: /Tom Reed/ })
    .locator('span.badge', { hasText: 'hr' })
    .filter({ hasNotText: 'medical' });
  await hrBadge.locator('button[title="Revoke role"]').click();
  await expect(
    page.getByRole('row', { name: /Tom Reed/ }).locator('span.badge'),
  ).toHaveCount(0);

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
  await page.getByRole('tab', { name: 'Holidays' }).click();
  await page.getByRole('button', { name: 'Add holiday / exception' }).click();
  let modal = page.locator('.modal');
  await modal.locator('label.field:has-text("Date") input').fill('2026-11-10');
  await modal.locator('label.field:has-text("Name") input').fill('Audit demo holiday');
  await modal
    .locator('label.field:has-text("Working minutes") input')
    .fill('0');
  await modal.getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(
    page.getByRole('row', { name: /Audit demo holiday/ }),
  ).toContainText('active');

  // Alexei books around the holiday — 10 Nov is not counted.
  await pick(page, 'Alexei');
  await goTo(page, '/requests/new');
  await page
    .locator('label.field:has-text("Leave type") select')
    .selectOption({ label: 'Annual leave' });
  await page.locator('label.field:has-text("Start date") input').fill('2026-11-09');
  await page.locator('label.field:has-text("End date") input').fill('2026-11-13');
  await expect(page.locator('body')).toContainText('4 days');
  await expect(page.locator('body')).toContainText('Holiday: Audit demo holiday');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await page.waitForURL(/\/requests\/\d+$/);
  const reqId = requestId(page);
  await approveChain(page, reqId);

  // Revoke the holiday: succeeds, and the affected request is listed.
  await pick(page, 'Maria');
  await goTo(page, '/settings');
  await page.getByRole('tab', { name: 'Holidays' }).click();
  await page
    .getByRole('row', { name: /Audit demo holiday/ })
    .getByRole('button', { name: 'Revoke' })
    .click();
  modal = page.locator('.modal');
  await modal.locator('textarea').fill('gazetted date corrected');
  await modal.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('body')).toContainText('Affected future requests');
  await expect(
    page.getByRole('row', { name: /Audit demo holiday/ }),
  ).toContainText('revoked');

  // The old, approved request keeps its frozen 4-day calculation.
  await goTo(page, `/requests/${reqId}`);
  await expect(page.locator('body')).toContainText('4 days');

  // A fresh preview counts 10 Nov as a working day now.
  await pick(page, 'Tom');
  await goTo(page, '/requests/new');
  await page
    .locator('label.field:has-text("Leave type") select')
    .selectOption({ label: 'Annual leave' });
  await page.locator('label.field:has-text("Start date") input').fill('2026-11-09');
  await page.locator('label.field:has-text("End date") input').fill('2026-11-13');
  await expect(page.locator('body')).toContainText('5 days');
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

  await page.getByRole('button', { name: 'Propose adjustment' }).click();
  const modal = page.locator('.modal');
  await modal
    .locator('label.field:has-text("Employee") select')
    .selectOption({ label: 'Alexei Novak (NPS-1001)' });
  await modal
    .locator('label.field:has-text("Leave type") select')
    .selectOption({ label: 'Annual leave' });
  await modal.locator('label.field:has-text("Period year") input').fill('2026');
  await modal.locator('label.field:has-text("Minutes") input').fill('60');
  await modal.locator('label.field:has-text("Reason") input').fill('audit-retry-f12');
  await modal
    .locator('label.field:has-text("Basis document") input')
    .fill('doc-1');
  await modal.getByRole('button', { name: 'Propose' }).click();
  // The lost reply surfaces as a network error; the intent key is kept.
  await expect(modal.locator('.alert-error, [role=alert]')).toBeVisible();

  // Retry — same intent key replays the stored result instead of duplicating.
  await modal.getByRole('button', { name: 'Propose' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('body')).toContainText('Adjustment proposed');

  const rows = page.getByRole('row', { name: /audit-retry-f12/ });
  await expect(rows).toHaveCount(1);

  // Server-side double check: exactly one proposed adjustment exists.
  const raw = await apiGet<
    { reason?: string }[] | { items: { reason?: string }[] }
  >(page, '/adjustments');
  const list = Array.isArray(raw) ? raw : raw.items;
  expect(list.filter((a) => a.reason === 'audit-retry-f12')).toHaveLength(1);
});

test('P01: EICAR content under a .pdf name is never downloadable', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await pick(page, 'Alexei');
  await goTo(page, '/requests/new');
  await page
    .locator('label.field:has-text("Leave type") select')
    .selectOption({ label: 'Annual leave' });
  await page.locator('label.field:has-text("Start date") input').fill('2026-11-02');
  await page.locator('label.field:has-text("End date") input').fill('2026-11-03');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await page.waitForURL(/\/requests\/\d+$/);
  const reqId = requestId(page);

  const eicar =
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
  await page.getByRole('button', { name: 'Upload attachment' }).click();
  const modal = page.locator('.modal');
  await modal.locator('input[type=file]').setInputFiles({
    name: 'scan-test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(eicar),
  });
  await modal.getByRole('button', { name: 'Upload' }).click();

  // Either the upload is refused outright (error stays in the modal), or the
  // modal closes and the file lands quarantined in the list.
  const errBox = page.locator('.modal .alert-error');
  await Promise.race([
    errBox.waitFor({ state: 'visible' }),
    page.locator('.modal').waitFor({ state: 'detached' }),
  ]);
  const refused = await errBox.isVisible().catch(() => false);
  if (!refused) {
    await expect(page.locator('body')).toContainText('scan-test.pdf');
    await expect(page.locator('body')).toContainText('Quarantined');
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
