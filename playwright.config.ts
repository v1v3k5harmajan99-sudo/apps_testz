import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// the variables the steps read (.env.example lists them); without a .env they come from the environment
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  testDir: '.',
  timeout: 120000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: process.env.MERIDIAN_BASE_URL || undefined,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testMatch: /suite\/.*\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
