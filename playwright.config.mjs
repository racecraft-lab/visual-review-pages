import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './test/playwright',
  outputDir: './test-results',
  fullyParallel: false,
  reporter: process.env.CI ? [['dot']] : [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
