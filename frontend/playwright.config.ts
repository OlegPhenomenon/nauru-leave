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
    // E2E_VIDEO=1 records a walkthrough video (used for docs/media/demo-walkthrough.webm).
    video: process.env.E2E_VIDEO ? { mode: 'on', size: { width: 1280, height: 800 } } : 'off',
    viewport: { width: 1280, height: 800 },
    launchOptions: { slowMo: process.env.E2E_VIDEO ? 250 : 0 },
  },
});
