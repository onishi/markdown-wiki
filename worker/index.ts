/**
 * Cloudflare deployment.
 *  - Static client (dist/client) is served by Workers Static Assets with SPA fallback.
 *  - /api/* and /auth/* go to a single Durable Object that runs the same Hono app as the
 *    Node server. Its built-in SQLite (synchronous storage.sql) backs the same schema, so
 *    server/app.ts is shared unchanged.
 */
import { DurableObject } from 'cloudflare:workers'
import { createApp } from '../server/app.js'
import { fakeReviser, geminiReviser } from '../server/ai.js'
import { initSchema, type DB, type SqlParam } from '../server/db.js'

interface Env {
  WIKI: DurableObjectNamespace<WikiServer>
  APP_ORIGIN?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  /** Gemini API key for AI editing suggestions (optional). */
  GOOGLE_AI_API_KEY?: string
  /** Local `wrangler dev` testing only; ignored unless the origin is http://localhost. */
  DEV_LOGIN?: string
  /** Local tests only (with DEV_LOGIN): a deterministic fake instead of Gemini. */
  AI_FAKE?: string
}

function sqlDb(storage: DurableObjectStorage): DB {
  const sql = storage.sql
  // storage.sql binds BLOBs as ArrayBuffer (and returns them as ArrayBuffer).
  const clean = (p: SqlParam[]) => p.map((v) => (v === undefined ? null : v instanceof Uint8Array ? v.slice().buffer : v))
  return {
    prepare(q) {
      return {
        get: (...p) => sql.exec(q, ...clean(p)).toArray()[0],
        all: (...p) => sql.exec(q, ...clean(p)).toArray(),
        run: (...p) => {
          const cur = sql.exec(q, ...clean(p))
          cur.toArray()
          return { changes: cur.rowsWritten }
        },
      }
    },
    exec: (q) => void sql.exec(q).toArray(),
    transaction: (fn) => storage.transactionSync(fn),
  }
}

export class WikiServer extends DurableObject<Env> {
  private app: ReturnType<typeof createApp> | null = null
  private db: DB

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.db = sqlDb(ctx.storage)
    initSchema(this.db)
  }

  async fetch(req: Request): Promise<Response> {
    if (!this.app) {
      const appOrigin = this.env.APP_ORIGIN ?? new URL(req.url).origin
      const google =
        this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET ? { clientId: this.env.GOOGLE_CLIENT_ID, clientSecret: this.env.GOOGLE_CLIENT_SECRET } : undefined
      // DEV_LOGIN never works on a deployed (https) origin.
      const devLogin = this.env.DEV_LOGIN === '1' && /^http:\/\/localhost(:\d+)?$/.test(appOrigin)
      const ai = devLogin && this.env.AI_FAKE === '1' ? fakeReviser : this.env.GOOGLE_AI_API_KEY ? geminiReviser(this.env.GOOGLE_AI_API_KEY) : undefined
      this.app = createApp(this.db, { appOrigin, google, devLogin, secureCookies: appOrigin.startsWith('https://'), ai })
    }
    return this.app.fetch(req)
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Only /api/* and /auth/* reach the Worker (run_worker_first); everything else is static.
    return env.WIKI.get(env.WIKI.idFromName('main')).fetch(req)
  },
}
