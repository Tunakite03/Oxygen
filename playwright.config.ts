import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: true,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:42817',
    browserName: 'chromium',
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run build:examples && npx vite preview --config vite.examples.config.ts --host 127.0.0.1 --port 42817 --strictPort',
    url: 'http://127.0.0.1:42817',
    reuseExistingServer: false,
  },
});
