import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 45000, workers: 2,
  outputDir: '/tmp/fortshell-playwright',
  use: { baseURL: 'http://127.0.0.1:4178', headless: true, serviceWorkers: 'block' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'],
      launchOptions: { args: ['--enable-unsafe-webgpu', '--use-angle=metal'] } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'tablet-webkit', use: { ...devices['iPad Pro 11'] } },
  ],
  webServer: { command: 'node tools/serve.mjs', port: 4178, reuseExistingServer: !process.env.CI },
});
