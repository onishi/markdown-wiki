import { defineConfig, devices } from '@playwright/test'

// E2E runs its own API server (in-memory DB, dev login) and Vite dev server on
// dedicated ports so it never touches a developer's running instance.
const API_PORT = 3402
const WEB_PORT = 5182

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 860 },
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  webServer: [
    {
      command: `PORT=${API_PORT} APP_ORIGIN=http://localhost:${WEB_PORT} DEV_LOGIN=1 AI_FAKE=1 DATABASE_PATH=:memory: npx tsx server/index.ts`,
      port: API_PORT,
      reuseExistingServer: false,
    },
    {
      command: `PORT=${API_PORT} npx vite --port ${WEB_PORT} --strictPort`,
      port: WEB_PORT,
      reuseExistingServer: false,
    },
  ],
})
