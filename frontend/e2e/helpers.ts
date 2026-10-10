import { expect, type Page } from '@playwright/test';

// Shared helpers for the browser specs. Each test runs in a fresh browser
// context, so the first persona pick creates a brand-new demo sandbox.

// The demo backend rate-limits bursts (login + page fetches). Wait it out.
export async function waitOutRateLimit(page: Page) {
  for (let i = 0; i < 4; i++) {
    if (!(await page.getByText(/rate limited|Too many attempts/i).count())) return;
    await page.waitForTimeout(10_000);
    await page.reload();
    await page.waitForTimeout(800);
  }
}

export async function pick(page: Page, name: string) {
  await page.keyboard.press('Escape');
  const card = page.locator('.persona-card', { hasText: name }).first();
  if (!(await card.isVisible().catch(() => false))) {
    const direct = page.getByRole('button', { name: /^Viewing as/ });
    const viewer = page.locator('.demo-strip summary').filter({ hasText: 'Viewing as' });
    if (await direct.isVisible().catch(() => false)) {
      await direct.click();
    } else if (await viewer.count()) {
      await viewer.click();
      await page.getByRole('menuitem', { name: 'Switch person…' }).click();
    } else {
      await page.getByRole('button', { name: /Start demo|Choose a persona/ }).click();
    }
  }
  await card.click();
  await expect(page.locator('.demo-strip')).toContainText(`Viewing as ${name}`);
  await expect(page.locator('.modal')).toHaveCount(0);
  await page.waitForTimeout(300);
}

export async function openDetails(page: Page, title: string) {
  const details = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: new RegExp(`^${title}(?: \\(|$)`) }) }).first();
  if ((await details.getAttribute('open')) === null) await details.locator(':scope > summary').click();
}

export async function more(page: Page, name: string) {
  await page.locator('.page-header').getByText('More', { exact: true }).click();
  await page.getByRole('menuitem', { name }).click();
}

export async function moveDate(page: Page, date: string) {
  await page.locator('.demo-tools-slot summary').click();
  await page.getByRole('menuitem', { name: 'Move date forward…' }).click();
  await page.getByLabel('New business date').fill(date);
  await page.locator('.modal').getByRole('button', { name: /^Move to/ }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
}

export async function goTo(page: Page, path: string) {
  await page.goto(path);
  await page.waitForTimeout(700);
  await waitOutRateLimit(page);
}

// Records the first (positive) outcome on the pending step: recommend_approve /
// checked_ok / approve.
export async function decide(page: Page) {
  await page.getByRole('button', { name: /^(Recommend approval|Mark as checked|Approve)$/ }).click();
  await page.waitForURL('**/approvals');
}

export async function approveChain(page: Page, requestId: number | string) {
  for (const persona of ['Olga', 'Maria', 'Elena']) {
    await pick(page, persona);
    await goTo(page, `/requests/${requestId}`);
    await decide(page);
  }
}

// A raw POST through the app's session (same-origin cookies + CSRF), for
// "forced API call" checks. Returns { status, body }.
export async function apiPost(
  page: Page,
  path: string,
  body: unknown,
  method = 'POST',
): Promise<{ status: number; body: string }> {
  return page.evaluate(
    async ({ path, body, method }) => {
      const me = (await (await fetch('/api/me')).json()) as { csrf_token: string };
      const res = await fetch(`/api${path}`, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.text() };
    },
    { path, body, method },
  );
}

export async function apiGet<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(
    async (path) => {
      const res = await fetch(`/api${path}`, { credentials: 'same-origin' });
      return (await res.json()) as unknown;
    },
    path,
  ) as Promise<T>;
}

export function requestId(page: Page): number {
  return Number(page.url().match(/requests\/(\d+)/)![1]);
}

export async function paperPerson(page: Page, name: string) {
  const paper = page.getByRole('button', { name: /Enter (?:a )?paper form/ });
  if (await paper.count()) await paper.click();
  await page.locator('input[role=combobox]').fill(name);
  await page.getByRole('option', { name: new RegExp(name) }).click();
}
