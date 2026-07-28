import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests-browser',
  testMatch: 'training-*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:41739',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'pnpm dev --port 41739 --strictPort',
    url: 'http://127.0.0.1:41739',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
