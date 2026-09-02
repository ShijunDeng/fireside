import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'NODE_ENV=test PORT=3100 HOST=127.0.0.1 DATABASE_PATH=:memory: FIRESIDE_WRITE_KEY=松风明月共围炉 FIRESIDE_AUTH_RATE_WINDOW_MS=6000 FIRESIDE_AUTH_PER_SOURCE_LIMIT=2 npm start',
    url: 'http://127.0.0.1:3100/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
