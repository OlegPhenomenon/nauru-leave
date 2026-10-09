import { expect, test, type Page } from '@playwright/test';

// Walks scenario steps 1–5 from docs/spec/SPEC_RU.txt §3 against a running
// demo stack. The demo needs a fresh sandbox (balances start at 20 days), so
// run this right after starting the backend, or press "Reset demo" first.

// The demo backend rate-limits bursts (login + page fetches). Wait it out.
async function waitOutRateLimit(page: Page) {
  if (await page.getByText(/rate limited/i).count()) {
    await page.waitForTimeout(10_000);
    await page.reload();
  }
}

async function pick(page: Page, name: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.keyboard.press('Escape');
    const card = page.locator('.persona-card', { hasText: name }).first();
    if (!(await card.isVisible().catch(() => false))) {
      const sw = page.getByRole('button', { name: 'Switch persona' });
      if (await sw.count()) await sw.click();
      else
        await page
          .getByRole('button', { name: /Start your private demo|Choose a persona/ })
          .click();
    }
    await card.click();
    await page.waitForTimeout(1200);
    if (!(await page.getByText(/rate limited/i).count())) break;
    await page.waitForTimeout(10_000);
  }
  await expect(page.locator('.demo-bar')).toContainText('signed in as');
}

async function goTo(page: Page, path: string) {
  await page.goto(path);
  await page.waitForTimeout(700);
  await waitOutRateLimit(page);
}

async function decide(page: Page) {
  await page
    .getByRole('button', { name: /Decide —/ })
    .first()
    .click();
  await page.locator('.modal input[name="outcome"]').first().check();
  await page.getByRole('button', { name: 'Record decision' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
}

async function approveChain(page: Page, requestId: number) {
  for (const persona of ['Olga', 'Maria', 'Elena']) {
    await pick(page, persona);
    await goTo(page, `/requests/${requestId}`);
    await decide(page);
  }
}

test('main scenario steps 1–5: balance, request, approval, amendment, time travel', async ({
  page,
}) => {
  // ---- 1. Alexei sees his Annual balance and the fictional-rule marking ----
  await page.goto('/');
  await pick(page, 'Alexei');
  await page.waitForURL('**/my');
  await expect(page.locator('body')).toContainText('Annual leave');
  await expect(page.locator('body')).toContainText('20 days');
  await expect(page.locator('body')).toContainText('Fictional demo rule — not Nauru law');

  // ---- 2. New request 9–13 Nov 2026: preview, warnings, route, submit ----
  await goTo(page, '/requests/new');
  await page
    .locator('label.field:has-text("Leave type") select')
    .selectOption({ label: 'Annual leave' });
  await page.locator('label.field:has-text("Start date") input').fill('2026-11-09');
  await page.locator('label.field:has-text("End date") input').fill('2026-11-13');
  await expect(page.locator('body')).toContainText('5 days');
  await expect(page.locator('body')).toContainText('40 h');
  await expect(page.locator('body')).toContainText('Olga');
  await expect(page.locator('body')).toContainText('Final decision');
  // team-overlap warning must name the absent teammate (Lina)
  await expect(page.locator('body')).toContainText('Lina');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await page.waitForURL(/\/requests\/\d+$/);
  const reqId = Number(page.url().match(/requests\/(\d+)/)![1]);

  await goTo(page, '/my');
  await expect(page.locator('body')).toContainText('15 days');
  await expect(page.locator('body')).toContainText('Reserved');

  // ---- 3. Olga recommends, Maria checks, Elena approves ----
  await approveChain(page, reqId);
  await pick(page, 'Alexei');
  await goTo(page, '/my');
  await expect(page.locator('body')).toContainText('15 days');

  // ---- 4. Amend to 9–11 Nov, approve again, balance becomes 17 ----
  await goTo(page, `/requests/${reqId}`);
  await page.getByRole('button', { name: 'Request amendment' }).click();
  await expect(
    page.locator('.modal label.field:has-text("Start date") input'),
  ).toHaveValue('2026-11-09');
  await page.locator('.modal label.field:has-text("End date") input').fill('2026-11-11');
  await page
    .locator('.modal label.field:has-text("Change reason") input')
    .fill('Plans changed — shorter trip');
  await page.getByRole('button', { name: 'Create amendment' }).click();
  await page.waitForURL(
    (u) => /\/requests\/\d+$/.test(u.pathname) && u.pathname !== `/requests/${reqId}`,
  );
  const amendId = Number(page.url().match(/requests\/(\d+)/)![1]);
  await approveChain(page, amendId);
  await pick(page, 'Alexei');
  await goTo(page, '/my');
  await expect(page.locator('body')).toContainText('17 days');
  await goTo(page, `/requests/${reqId}`);
  await expect(page.locator('body')).toContainText('amendment');

  // The original request now shows the amended revision as in force:
  // 9–11 Nov / 3 days. The old 9–13 dates appear only as history.
  await expect(page.locator('body')).toContainText('9 Nov');
  await expect(page.locator('body')).toContainText('11 Nov');
  await expect(page.locator('body')).toContainText('3 days');
  await expect(page.locator('body')).toContainText('In force');
  const histRow = page.getByRole('row', { name: /13 Nov/ });
  await expect(histRow).toHaveCount(1);
  await expect(histRow).toContainText('superseded');

  // Same on the printable card: days in force 9–11 Nov, 3 days; the
  // superseded revision is listed in the history section only.
  await goTo(page, `/requests/${reqId}/print`);
  await expect(page.locator('body')).toContainText('Days in force');
  await expect(page.locator('body')).toContainText('9 Nov');
  await expect(page.locator('body')).toContainText('11 Nov');
  await expect(page.locator('body')).toContainText('3 days');
  const printHist = page.locator('.revision-history');
  await expect(page.getByRole('row', { name: /13 Nov/ })).toHaveCount(1);
  await expect(printHist.getByRole('row', { name: /13 Nov/ })).toHaveCount(1);

  // ---- 5. Time travel to 2026-11-12: period ended, balance still 17 ----
  await page.locator('input[aria-label="Time travel to business date"]').fill('2026-11-12');
  await expect(page.locator('.demo-bar')).toContainText('12 Nov 2026');
  await goTo(page, `/requests/${reqId}`);
  await expect(page.locator('body')).toContainText('Period ended');
  await goTo(page, '/my');
  await expect(page.locator('body')).toContainText('17 days');
});
