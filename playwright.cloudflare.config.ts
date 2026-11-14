import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// Same E2E suite against the Cloudflare build (Workers assets + Durable Object SQLite)
// running locally in `wrangler dev`. Run `npm run build` first.
const PORT = 5183

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `npx wrangler dev --port ${PORT} --persist-to .wrangler/e2e-${Date.now()} --var DEV_LOGIN:1 --var AI_FAKE:1 --var APP_ORIGIN:http://localhost:${PORT}`,
    port: PORT,
    reuseExistingServer: false,
  },
})
