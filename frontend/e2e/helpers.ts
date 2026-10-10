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

const DEMO_NAMES: Record<string, string> = {
  Alexei: 'Alexei Novak', Nia: 'Nia Fox', Olga: 'Olga Berg', Maria: 'Maria Santos',
  Elena: 'Elena Ward', David: 'David Hale', Tom: 'Tom Reed', Pavel: 'Pavel Grant', Grace: 'Grace Lin',
};

export async function pick(page: Page, name: string) {
  name = DEMO_NAMES[name] ?? name;
  await page.keyboard.press('Escape');
  const strip = page.locator('.demo-strip');
  if (await strip.count() && (await strip.locator('.demo-viewing strong').textContent().catch(() => null)) === name) {
    await page.getByRole('banner').getByRole('link', { name: 'Nauru Leave Desk', exact: true }).click();
    await expect(page.locator('.demo-viewing strong')).toHaveText(name);
    await expect(page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'My leave', exact: true })).toBeVisible();
    await expect(page.locator('.modal')).toHaveCount(0);
    await page.waitForTimeout(300);
    return;
  }
  const card = page.locator('.persona-card', { hasText: name }).first();
  if (!(await card.isVisible().catch(() => false))) {
    const direct = page.locator('.demo-strip').getByRole('button', { name: 'Switch user' });
    if (await direct.isVisible().catch(() => false)) {
      await direct.click();
    } else {
      await page.getByRole('button', { name: /Start demo|Choose a persona/ }).click();
    }
  }
  await card.click();
  await expect(page.locator('.demo-viewing strong')).toHaveText(name);
  await expect(page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'My leave', exact: true })).toBeVisible();
  await expect(page.locator('.modal')).toHaveCount(0);
  await page.waitForTimeout(300);
}

export async function openDetails(page: Page, title: string) {
  const details = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: new RegExp(`^${title}(?: [(]|$)`) }) }).first();
  await expect(details.locator(':scope > summary').or(page.getByRole('heading', { name: title, exact: true })).first()).toBeVisible();
  if (!(await details.count())) {
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    return;
  }
  if ((await details.getAttribute('open')) === null) await details.locator(':scope > summary').click();
}

export async function clickAction(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click();
}

export async function moveDate(page: Page, date: string) {
  await page.locator('.demo-strip').getByRole('button', { name: 'Change date…', exact: true }).click();
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
