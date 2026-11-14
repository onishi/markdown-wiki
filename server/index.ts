import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFileSync, existsSync } from 'node:fs'
import { openDb } from './db-node.js'
import { createApp } from './app.js'
import { fakeReviser, geminiReviser } from './ai.js'

// Local secrets (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET …) can live in .env (gitignored).
try {
  process.loadEnvFile('.env')
} catch {
  // no .env: use the real environment only
}

const port = Number(process.env.PORT ?? 3000)
const prod = process.env.NODE_ENV === 'production'
const appOrigin = process.env.APP_ORIGIN ?? (prod ? `http://localhost:${port}` : 'http://localhost:5173')
const devLogin = process.env.DEV_LOGIN === '1'

if (prod && devLogin) {
  console.error('DEV_LOGIN must not be enabled in production.')
  process.exit(1)
}

const db = openDb(process.env.DATABASE_PATH ?? 'data/wiki.db')
const google =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }
    : undefined

// AI_FAKE (tests) only works together with dev login, which is refused in production.
const ai = devLogin && process.env.AI_FAKE === '1' ? fakeReviser : process.env.GOOGLE_AI_API_KEY ? geminiReviser(process.env.GOOGLE_AI_API_KEY) : undefined

const app = createApp(db, { appOrigin, google, devLogin, secureCookies: appOrigin.startsWith('https://'), ai })

const clientDir = process.env.CLIENT_DIR ?? 'dist/client'
if (existsSync(clientDir)) {
  app.use('/assets/*', serveStatic({ root: clientDir }))
  const indexHtml = readFileSync(`${clientDir}/index.html`, 'utf8')
  app.get('*', (c) => c.html(indexHtml))
}

serve({ fetch: app.fetch, port }, () => {
  console.log(`Markdown Wiki server on http://localhost:${port} (origin ${appOrigin})`)
  if (!google) console.log('  Google login not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET')
  if (!ai) console.log('  AI suggestions not configured: set GOOGLE_AI_API_KEY')
  if (devLogin) console.log('  DEV_LOGIN enabled: /auth/dev-login?email=you@example.com')
})
