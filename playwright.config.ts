/**
 * Playwright configuration for AI SDK Chat Kernel integration tests.
 * 
 * These tests run against a built JupyterLite site with the kernel installed.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/integration',
  
  // Run tests in files in parallel
  fullyParallel: true,
  
  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,
  
  // Retry on CI only
  retries: process.env.CI ? 2 : 0,
  
  // Opt out of parallel tests on CI
  workers: process.env.CI ? 1 : undefined,
  
  // Reporter to use
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
  
  // Shared settings for all the projects below
  use: {
    // Base URL to use in actions like `await page.goto('/')`
    baseURL: process.env.JUPYTERLITE_URL || 'http://localhost:8000',
    
    // Collect trace when retrying the failed test
    trace: 'on-first-retry',
    
    // Take screenshot on failure
    screenshot: 'only-on-failure',
    
    // Video recording
    video: 'on-first-retry',
  },

  // Configure projects for major browsers
  projects: [
    {
      name: 'chromium',
      use: { 
        ...devices['Desktop Chrome'],
        // Use headless mode for CI
        headless: true,
      },
    },
  ],

  // Timeout for each test
  timeout: 60000,
  
  // Timeout for expect() assertions
  expect: {
    timeout: 10000,
  },

  // Run local dev server before starting the tests (optional)
  // Uncomment if you want to auto-start JupyterLite
  // webServer: {
  //   command: 'cd ../docs && python -m http.server 8000',
  //   url: 'http://localhost:8000',
  //   reuseExistingServer: !process.env.CI,
  //   timeout: 120000,
  // },
});
