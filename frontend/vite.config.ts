/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// vite.config.ts runs in Node; the app code itself is browser-typed, so we
// declare the one Node global we need instead of adding @types/node.
declare const process: { env: Record<string, string | undefined> };

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // NLD_API points the dev proxy at a running backend (default: Docker port 8080).
      '/api': process.env.NLD_API ?? 'http://127.0.0.1:8080',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
