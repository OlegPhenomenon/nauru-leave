import { expect, type Page } from '@playwright/test';

// Shared helpers for the browser specs. Each test runs in a fresh browser
// context, so the first persona pick creates a brand-new demo sandbox.

// The demo backend rate-limits bursts (login + page fetches). Wait it out.
export async function waitOutRateLimit(page: Page) {
  for (let i = 0; i < 4; i++) {
    if (!(await page.getByText(/rate limited/i).count())) return;
    await page.waitForTimeout(10_000);
    await page.reload();
    await page.waitForTimeout(800);
  }
}

export async function pick(page: Page, name: string) {
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

export async function goTo(page: Page, path: string) {
  await page.goto(path);
  await page.waitForTimeout(700);
  await waitOutRateLimit(page);
}

// Records the first (positive) outcome on the pending step: recommend_approve /
// checked_ok / approve.
export async function decide(page: Page) {
  await page
    .getByRole('button', { name: /Decide —/ })
    .first()
    .click();
  await page.locator('.modal input[name="outcome"]').first().check();
  await page.getByRole('button', { name: 'Record decision' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await page.waitForTimeout(400);
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
