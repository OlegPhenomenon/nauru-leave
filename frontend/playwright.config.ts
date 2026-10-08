import { defineConfig } from '@playwright/test';

// Runs against an already-running stack: the Vite dev server (baseURL below)
// with its /api proxy pointed at the backend. See docs/FRONTEND_NOTES.md.
export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE ?? 'http://127.0.0.1:5173',
    headless: true,
  },
});
