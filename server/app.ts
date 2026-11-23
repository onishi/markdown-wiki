import { Hono, type Context, type Next } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { type DB, tx } from './db.js'
import {
  type User,
  type GoogleConfig,
  createSession,
  destroySession,
  exchangeCode,
  googleAuthUrl,
  pkceChallenge,
  randomToken,
  sessionUser,
  upsertGoogleUser,
} from './auth.js'
import { normalizePageName, parentName, validatePageName } from '../shared/pageName.js'
import { matchesAll, searchTerms, snippet } from '../shared/search.js'
import { AI_NEEDS_WEB, AI_NO_WEB, excerptAround, isAiPreset, isAiVolume, type LinkCandidate, type RelatedPage, type Reviser } from './ai.js'
import { normalizeSlug, validateSlug } from '../shared/wikiSlug.js'
import { applyLinks, suggestedLinks, extractWikiTargets, rewriteWikiLinks, unwrapWikiLinks, type SuggestedLink } from '../shared/markdown/wikilinks.js'
import { diffHunks, groupChanges } from '../shared/diff.js'
import { isOAuthClientPath, mountMcp, type PageInfo, type SaveResult } from './mcp.js'

export type Role = 'owner' | 'editor' | 'viewer'
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 }
const isRole = (r: unknown): r is Role => r === 'owner' || r === 'editor' || r === 'viewer'

export interface AppConfig {
  appOrigin: string
  google?: { clientId: string; clientSecret: string }
  /** Enables /auth/dev-login (local development and automated tests only). */
  devLogin: boolean
  secureCookies: boolean
  fetchImpl?: typeof fetch
  /** AI editing suggestions (unset: the feature is unavailable). */
  ai?: Reviser
}

type Env = { Variables: { user: User } }

// A page (and each revision) is one SQLite row; Durable Object rows are capped at 2 MB,
// so keep the UTF-8 size below that (≤ 3 bytes per UTF-16 unit).
const MAX_CONTENT = 600_000
const MAX_FILE = 10 * 1024 * 1024
/** AI suggestions: target size (the model returns it whole) and requests per user per day. */
const AI_MAX_TARGET = 30_000
const AI_DAILY_LIMIT = 100
/** Related pages sent as background: how many, and characters each / in total. */
const AI_RELATED_PAGES = 10
const AI_RELATED_EACH = 4000
const AI_RELATED_TOTAL = 24_000
/** The wiki's page names sent as background (most recently updated first). */
const AI_PAGE_LIST = 400
const AI_PAGE_LIST_CHARS = 8000
const AI_LINK_CANDIDATES = 40
/** Rows are capped at 2 MB on Durable Objects: files are stored in 1 MB chunks. */
const CHUNK = 1024 * 1024

/** Image type from magic bytes (the client's Content-Type is not trusted). SVG is refused (script). */
function sniffImage(b: Uint8Array): string | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  if (at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73))) return 'image/avif'
  return null
}

export function createApp(db: DB, cfg: AppConfig) {
  const app = new Hono<Env>()

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
    console.error(err)
    return c.json({ error: 'internal_error' }, 500)
  })

  // CSRF: state-changing requests must carry a custom header (forces a CORS preflight
  // cross-origin, which we never allow) and, if present, a same-origin Origin header.
  app.use('*', async (c, next) => {
    // MCP / OAuth client endpoints use bearer tokens or no credentials at all (never cookies).
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !isOAuthClientPath(c.req.path)) {
      if (c.req.header('x-requested-with') !== 'markdown-wiki') return c.json({ error: 'csrf' }, 403)
      const origin = c.req.header('origin')
      if (origin && origin !== cfg.appOrigin && origin !== new URL(c.req.url).origin) return c.json({ error: 'csrf' }, 403)
    }
    await next()
  })

  const googleCfg = (): GoogleConfig | null =>
    cfg.google ? { clientId: cfg.google.clientId, clientSecret: cfg.google.clientSecret, redirectUri: `${cfg.appOrigin}/auth/google/callback` } : null

  const safeReturnTo = (r: string | undefined) => (r && r.startsWith('/') && !r.startsWith('//') ? r : '/')

  // ------------------------------------------------------------ auth routes

  app.get('/auth/config', (c) => c.json({ google: !!cfg.google, devLogin: cfg.devLogin }))

  app.get('/auth/google', (c) => {
    const g = googleCfg()
    if (!g) return c.text('Google login is not configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).', 503)
    const state = randomToken()
    const nonce = randomToken()
    const verifier = randomToken(48)
    const returnTo = safeReturnTo(c.req.query('returnTo'))
    setCookie(c, 'mw_oauth', JSON.stringify({ state, nonce, verifier, returnTo }), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: cfg.secureCookies,
      path: '/auth',
      maxAge: 600,
    })
    return c.redirect(googleAuthUrl(g, state, nonce, pkceChallenge(verifier)))
  })

  app.get('/auth/google/callback', async (c) => {
    const g = googleCfg()
    if (!g) return c.text('not configured', 503)
    const raw = getCookie(c, 'mw_oauth')
    deleteCookie(c, 'mw_oauth', { path: '/auth' })
    let saved: { state: string; nonce: string; verifier: string; returnTo: string }
    try {
      saved = JSON.parse(raw ?? '')
    } catch {
      return c.text('ログインセッションが見つかりません。もう一度お試しください。', 400)
    }
    const code = c.req.query('code')
    if (!code || c.req.query('state') !== saved.state) return c.text('state mismatch', 400)
    try {
      const claims = await exchangeCode(g, code, saved.verifier, saved.nonce, cfg.fetchImpl)
      const userId = upsertGoogleUser(db, { sub: claims.sub, email: claims.email, name: claims.name ?? claims.email, picture: claims.picture ?? '' })
      createSession(db, c, userId, cfg.secureCookies)
      return c.redirect(safeReturnTo(saved.returnTo))
    } catch (e) {
      console.error('google login failed', e)
      return c.text('Google ログインに失敗しました。', 400)
    }
  })

  if (cfg.devLogin) {
    // Development/test only: log in as an arbitrary email without Google.
    app.get('/auth/dev-login', (c) => {
      const email = (c.req.query('email') ?? '').trim().toLowerCase()
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) return c.text('email required', 400)
      const userId = upsertGoogleUser(db, { sub: `dev:${email}`, email, name: c.req.query('name') || email.split('@')[0], picture: '' })
      createSession(db, c, userId, cfg.secureCookies)
      return c.redirect(safeReturnTo(c.req.query('returnTo')))
    })
  }

  app.post('/auth/logout', (c) => {
    destroySession(db, c)
    return c.json({ ok: true })
  })

  // ------------------------------------------------------------ API (auth required)

  const requireUser = async (c: Context<Env>, next: Next) => {
    const u = sessionUser(db, c)
    if (!u) {
      // Published pages (and the images on them) can be read without logging in.
      if (c.req.method === 'GET' && (c.req.path.startsWith('/api/public/') || /^\/api\/wikis\/[^/]+\/files\/[^/]+$/.test(c.req.path))) return next()
      return c.json({ error: 'unauthenticated' }, 401)
    }
    c.set('user', u)
    acceptInvitations(u)
    await next()
  }
  app.use('/api/*', requireUser)

  function acceptInvitations(u: User) {
    const invs = db.prepare('SELECT wiki_id, role FROM invitations WHERE email = ?').all(u.email) as { wiki_id: string; role: Role }[]
    if (!invs.length) return
    tx(db, () => {
      for (const inv of invs) {
        db.prepare('INSERT OR IGNORE INTO memberships (wiki_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(inv.wiki_id, u.id, inv.role, Date.now())
        db.prepare('DELETE FROM invitations WHERE wiki_id = ? AND email = ?').run(inv.wiki_id, u.email)
      }
    })
  }

  function roleOf(userId: string, wikiId: string): Role | null {
    const m = db.prepare('SELECT role FROM memberships WHERE wiki_id = ? AND user_id = ?').get(wikiId, userId) as { role: Role } | undefined
    return m?.role ?? null
  }

  /** Server-side authorisation for every wiki-scoped request. 404 hides existence. */
  /**
   * "name is under prefix" with exact matching. (LIKE would ignore ASCII case, so `LISA`
   * would pick up `lisa/…`; page names distinguish case and full/half width.) Binds prefix twice.
   */
  const UNDER = 'substr(name, 1, length(?)) = ?'

  /** :wid may be the wiki id, its slug, or a former slug. Unknown and non-member look the same (404). */
  function resolveWikiId(param: string): string | null {
    const w = db.prepare('SELECT id FROM wikis WHERE id = ? OR slug = ?').get(param, param) as { id: string } | undefined
    if (w) return w.id
    const a = db.prepare('SELECT wiki_id FROM wiki_slug_aliases WHERE slug = ?').get(param) as { wiki_id: string } | undefined
    return a?.wiki_id ?? null
  }

  /** Error code if `slug` can't be used by wiki `wikiId` (null: new wiki). */
  function slugProblem(slug: string, wikiId: string | null): 'invalid_slug' | 'slug_taken' | null {
    if (validateSlug(slug)) return 'invalid_slug'
    const owner = resolveWikiId(slug)
    return owner && owner !== wikiId ? 'slug_taken' : null
  }

  function randomSlug(): string {
    for (;;) {
      const s = `w-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
      if (!resolveWikiId(s)) return s
    }
  }

  function need(c: Context<Env>, min: Role): { wikiId: string; role: Role } {
    const wikiId = resolveWikiId(c.req.param('wid')!) ?? ''
    const role = roleOf(c.get('user').id, wikiId)
    if (!role) throw new HTTPException(404, { message: 'not_found' })
    if (RANK[role] < RANK[min]) throw new HTTPException(403, { message: 'forbidden' })
    return { wikiId, role }
  }

  async function body<T>(c: Context): Promise<T> {
    try {
      return (await c.req.json()) as T
    } catch {
      throw new HTTPException(400, { message: 'bad_json' })
    }
  }

  app.get('/api/me', (c) => {
    const u = c.get('user')
    return c.json({ user: { id: u.id, email: u.email, name: u.name, picture: u.picture }, settings: JSON.parse(u.settings || '{}') })
  })

  app.put('/api/me/settings', async (c) => {
    const b = await body<{ listMode?: string; softBreak?: string }>(c)
    const u = c.get('user')
    const s = JSON.parse(u.settings || '{}')
    if (b.listMode === 'list' || b.listMode === 'item') s.listMode = b.listMode
    if (b.softBreak === 'break' || b.softBreak === 'join') s.softBreak = b.softBreak
    db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(s), u.id)
    return c.json({ settings: s })
  })

  // ---- wikis

  app.get('/api/wikis', (c) => {
    const rows = db
      .prepare(
        `SELECT w.id, w.slug, w.name, m.role, (SELECT COUNT(*) FROM pages p WHERE p.wiki_id = w.id) AS pageCount,
                (SELECT COUNT(*) FROM memberships mm WHERE mm.wiki_id = w.id) AS memberCount,
                (SELECT MAX(updated_at) FROM pages p WHERE p.wiki_id = w.id) AS updatedAt
         FROM wikis w JOIN memberships m ON m.wiki_id = w.id WHERE m.user_id = ? ORDER BY w.created_at`,
      )
      .all(c.get('user').id)
    return c.json({ wikis: rows })
  })

  app.post('/api/wikis', async (c) => {
    const b = await body<{ name?: string; slug?: string }>(c)
    const name = (b.name ?? '').trim()
    if (!name || name.length > 100) return c.json({ error: 'invalid_name' }, 400)
    const slug = b.slug?.trim() ? normalizeSlug(b.slug) : randomSlug()
    const bad = slugProblem(slug, null)
    if (bad) return c.json({ error: bad }, bad === 'slug_taken' ? 409 : 400)
    const id = crypto.randomUUID()
    const now = Date.now()
    tx(db, () => {
      db.prepare('INSERT INTO wikis (id, slug, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, slug, name, c.get('user').id, now)
      db.prepare('INSERT INTO memberships (wiki_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(id, c.get('user').id, 'owner', now)
    })
    return c.json({ wiki: { id, slug, name, role: 'owner' } }, 201)
  })

  app.get('/api/wikis/:wid', (c) => {
    const { wikiId, role } = need(c, 'viewer')
    const w = db
      .prepare('SELECT w.id, w.slug, w.name, w.ai_enabled AS aiEnabled, p.id AS topPageId, p.name AS topPage FROM wikis w LEFT JOIN pages p ON p.id = w.top_page_id WHERE w.id = ?')
      .get(wikiId) as { aiEnabled: number }
    return c.json({ wiki: { ...w, aiEnabled: !!w.aiEnabled, aiAvailable: !!cfg.ai, role } })
  })

  app.patch('/api/wikis/:wid', async (c) => {
    const { wikiId } = need(c, 'owner')
    const b = await body<{ name?: string; slug?: string; topPageId?: string | null; aiEnabled?: boolean }>(c)
    // Validate everything first so a rejected request changes nothing.
    const name = b.name?.trim()
    if (name !== undefined && (!name || name.length > 100)) return c.json({ error: 'invalid_name' }, 400)
    const slug = b.slug !== undefined ? normalizeSlug(b.slug) : undefined
    if (slug !== undefined) {
      const bad = slugProblem(slug, wikiId)
      if (bad) return c.json({ error: bad }, bad === 'slug_taken' ? 409 : 400)
    }
    if (b.topPageId && !db.prepare('SELECT 1 FROM pages WHERE wiki_id = ? AND id = ?').get(wikiId, b.topPageId)) return c.json({ error: 'not_found' }, 404)
    tx(db, () => {
      if (name !== undefined) db.prepare('UPDATE wikis SET name = ? WHERE id = ?').run(name, wikiId)
      if (b.topPageId !== undefined) db.prepare('UPDATE wikis SET top_page_id = ? WHERE id = ?').run(b.topPageId, wikiId)
      if (typeof b.aiEnabled === 'boolean') db.prepare('UPDATE wikis SET ai_enabled = ? WHERE id = ?').run(b.aiEnabled ? 1 : 0, wikiId)
      const old = (db.prepare('SELECT slug FROM wikis WHERE id = ?').get(wikiId) as { slug: string }).slug
      if (slug !== undefined && slug !== old) {
        // The old slug keeps redirecting; reclaiming one of this wiki's former slugs is allowed.
        db.prepare('DELETE FROM wiki_slug_aliases WHERE slug = ?').run(slug)
        db.prepare('UPDATE wikis SET slug = ? WHERE id = ?').run(slug, wikiId)
        db.prepare('INSERT INTO wiki_slug_aliases (slug, wiki_id) VALUES (?, ?)').run(old, wikiId)
      }
    })
    return c.json({ ok: true })
  })

  app.delete('/api/wikis/:wid', (c) => {
    const { wikiId } = need(c, 'owner')
    db.prepare('DELETE FROM wikis WHERE id = ?').run(wikiId)
    return c.json({ ok: true })
  })

  // ---- members

  app.get('/api/wikis/:wid/members', (c) => {
    const { wikiId } = need(c, 'viewer')
    const members = db
      .prepare('SELECT u.id AS userId, u.email, u.name, u.picture, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.wiki_id = ? ORDER BY m.created_at')
      .all(wikiId)
    const invitations = db.prepare('SELECT email, role, created_at AS createdAt FROM invitations WHERE wiki_id = ? ORDER BY created_at').all(wikiId)
    return c.json({ members, invitations })
  })

  app.post('/api/wikis/:wid/invitations', async (c) => {
    const { wikiId } = need(c, 'owner')
    const b = await body<{ email?: string; role?: string }>(c)
    const email = (b.email ?? '').trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'invalid_email' }, 400)
    if (!isRole(b.role)) return c.json({ error: 'invalid_role' }, 400)
    const already = db.prepare('SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.wiki_id = ? AND u.email = ?').get(wikiId, email)
    if (already) return c.json({ error: 'already_member' }, 409)
    db.prepare(
      'INSERT INTO invitations (wiki_id, email, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(wiki_id, email) DO UPDATE SET role = excluded.role',
    ).run(wikiId, email, b.role, c.get('user').id, Date.now())
    return c.json({ ok: true }, 201)
  })

  app.delete('/api/wikis/:wid/invitations/:email', (c) => {
    const { wikiId } = need(c, 'owner')
    db.prepare('DELETE FROM invitations WHERE wiki_id = ? AND email = ?').run(wikiId, decodeURIComponent(c.req.param('email')).toLowerCase())
    return c.json({ ok: true })
  })

  const ownerCount = (wikiId: string) => (db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE wiki_id = ? AND role = 'owner'").get(wikiId) as { n: number }).n

  app.patch('/api/wikis/:wid/members/:uid', async (c) => {
    const { wikiId } = need(c, 'owner')
    const b = await body<{ role?: string }>(c)
    if (!isRole(b.role)) return c.json({ error: 'invalid_role' }, 400)
    const uid = c.req.param('uid')
    const cur = roleOf(uid, wikiId)
    if (!cur) return c.json({ error: 'not_found' }, 404)
    if (cur === 'owner' && b.role !== 'owner' && ownerCount(wikiId) <= 1) return c.json({ error: 'last_owner' }, 409)
    db.prepare('UPDATE memberships SET role = ? WHERE wiki_id = ? AND user_id = ?').run(b.role, wikiId, uid)
    return c.json({ ok: true })
  })

  app.delete('/api/wikis/:wid/members/:uid', (c) => {
    const uid = c.req.param('uid')
    const self = uid === c.get('user').id
    const { wikiId } = need(c, self ? 'viewer' : 'owner') // anyone may leave
    const cur = roleOf(uid, wikiId)
    if (!cur) return c.json({ error: 'not_found' }, 404)
    if (cur === 'owner' && ownerCount(wikiId) <= 1) return c.json({ error: 'last_owner' }, 409)
    db.prepare('DELETE FROM memberships WHERE wiki_id = ? AND user_id = ?').run(wikiId, uid)
    return c.json({ ok: true })
  })

  // ---- pages

  const pageRow = (wikiId: string, pageId: string) =>
    db
      .prepare(
        `SELECT p.id, p.name, p.content, p.version, p.updated_at AS updatedAt, u.name AS updatedByName, p.published_at AS publishedAt
         FROM pages p LEFT JOIN users u ON u.id = p.updated_by WHERE p.wiki_id = ? AND p.id = ?`,
      )
      .get(wikiId, pageId) as { id: string; name: string; content: string; version: number; updatedAt: number; updatedByName: string | null; publishedAt: number | null } | undefined

  app.get('/api/wikis/:wid/pages', (c) => {
    const { wikiId } = need(c, 'viewer')
    const q = (c.req.query('q') ?? '').trim()
    const cols = 'p.id, p.name, p.updated_at AS updatedAt, u.name AS updatedByName, p.published_at AS publishedAt FROM pages p LEFT JOIN users u ON u.id = p.updated_by'
    const pages = q
      ? db
          .prepare(`SELECT ${cols} WHERE p.wiki_id = ? AND p.name LIKE ? ESCAPE '\\' ORDER BY p.name`)
          .all(wikiId, `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`)
      : db.prepare(`SELECT ${cols} WHERE p.wiki_id = ? ORDER BY p.name`).all(wikiId)
    const aliases = db.prepare('SELECT name, page_id AS pageId FROM page_aliases WHERE wiki_id = ?').all(wikiId)
    return c.json({ pages, aliases })
  })

  app.get('/api/wikis/:wid/resolve', (c) => {
    const { wikiId } = need(c, 'viewer')
    const name = validatePageName(c.req.query('name') ?? '')
    if (!name) return c.json({ error: 'invalid_name' }, 400)
    const direct = db.prepare('SELECT id FROM pages WHERE wiki_id = ? AND name = ?').get(wikiId, name) as { id: string } | undefined
    if (direct) return c.json({ page: pageRow(wikiId, direct.id), via: 'name' })
    const alias = db.prepare('SELECT page_id FROM page_aliases WHERE wiki_id = ? AND name = ?').get(wikiId, name) as { page_id: string } | undefined
    if (alias) return c.json({ page: pageRow(wikiId, alias.page_id), via: 'alias' })
    const children = db.prepare(`SELECT id, name FROM pages WHERE wiki_id = ? AND ${UNDER} ORDER BY name`).all(wikiId, `${name}/`, `${name}/`)
    return c.json({ page: null, name, children }, 404)
  })

  /** Full-text search over page names and bodies: every term must match (AND). */
  function searchPages(wikiId: string, q: string) {
    const terms = searchTerms(q)
    if (terms.length === 0) return { results: [], more: false }
    const like = (t: string) => `%${t.replace(/[\\%_]/g, (m) => '\\' + m)}%`
    // LIKE narrows (ASCII case-insensitive); matchesAll confirms with the same rule.
    const where = terms.map(() => "(name LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')").join(' AND ')
    const rows = db
      .prepare(`SELECT id, name, content, updated_at AS updatedAt FROM pages WHERE wiki_id = ? AND ${where} ORDER BY updated_at DESC LIMIT 101`)
      .all(wikiId, ...terms.flatMap((t) => [like(t), like(t)])) as { id: string; name: string; content: string; updatedAt: number }[]
    const hits = rows.filter((r) => matchesAll(r.name, r.content, terms))
    const results = hits.slice(0, 100).map((r) => ({
      id: r.id,
      name: r.name,
      updatedAt: r.updatedAt,
      nameMatch: terms.every((t) => r.name.toLowerCase().includes(t)),
      snippet: snippet(r.content, terms),
    }))
    return { results, more: rows.length > 100 }
  }
  app.get('/api/wikis/:wid/search', (c) => {
    const { wikiId } = need(c, 'viewer')
    return c.json(searchPages(wikiId, c.req.query('q') ?? ''))
  })

  /** Pages whose [[links]] point at this page (by its name or one of its old names). */
  app.get('/api/wikis/:wid/pages/:pid/backlinks', (c) => {
    const { wikiId } = need(c, 'viewer')
    const pid = c.req.param('pid')
    const page = db.prepare('SELECT name FROM pages WHERE wiki_id = ? AND id = ?').get(wikiId, pid) as { name: string } | undefined
    if (!page) return c.json({ error: 'not_found' }, 404)
    const pages = backlinkRows(wikiId, pid, page.name)
      .map((r) => ({ id: r.id, name: r.name, updatedAt: r.updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    return c.json({ pages })
  })

  function backlinkRows(wikiId: string, pid: string, pageName: string) {
    const aliases = (db.prepare('SELECT name FROM page_aliases WHERE wiki_id = ? AND page_id = ?').all(wikiId, pid) as { name: string }[]).map((a) => a.name)
    const names = new Set([pageName, ...aliases])
    const rows = db
      .prepare("SELECT id, name, content, updated_at AS updatedAt FROM pages WHERE wiki_id = ? AND id != ? AND instr(content, '[[') > 0")
      .all(wikiId, pid) as { id: string; name: string; content: string; updatedAt: number }[]
    return rows
      .filter((r) => [...names].some((n) => r.content.includes(n.split('/').pop()!)))
      .filter((r) => extractWikiTargets(r.content).some((t) => names.has(normalizePageName(t))))
  }

  /**
   * "links" task: pages (other than this one) whose full name or last part occurs in the
   * target text outside existing links and code, longest first.
   */
  function linkCandidates(wikiId: string, pid: string, target: string): LinkCandidate[] {
    const linked = new Set(extractWikiTargets(target))
    const plain = target.replace(/```[\s\S]*?```|`[^`\n]*`|\[\[[^\]\n]*\]\]|https?:\/\/\S+/g, ' ')
    const out: LinkCandidate[] = []
    for (const p of db.prepare('SELECT id, name FROM pages WHERE wiki_id = ?').all(wikiId) as { id: string; name: string }[]) {
      if (p.id === pid || linked.has(p.name)) continue
      const words = [...new Set([p.name, p.name.split('/').pop()!])].filter((w) => w.length >= 2 && plain.includes(w))
      if (words.length) out.push({ name: p.name, words })
    }
    return out.sort((a, b) => b.words[0].length - a.words[0].length).slice(0, AI_LINK_CANDIDATES)
  }

  /**
   * Background for AI suggestions: pages this one links to (from the text being edited),
   * pages linking here, and the parent page.  Capped in count and size.
   */
  function relatedPages(wikiId: string, pid: string, pageName: string, content: string): RelatedPage[] {
    const out: RelatedPage[] = []
    const seen = new Set([pid])
    let budget = AI_RELATED_TOTAL
    const add = (row: { id: string; name: string; content: string } | undefined, relation: string) => {
      if (!row || seen.has(row.id) || out.length >= AI_RELATED_PAGES || budget <= 0 || !row.content.trim()) return
      seen.add(row.id)
      let text = row.content.slice(0, Math.min(AI_RELATED_EACH, budget))
      if (text.length < row.content.length) text += '\n…（以下省略）'
      budget -= text.length
      out.push({ name: row.name, relation, content: text })
    }
    const byName = (name: string) =>
      (db.prepare('SELECT id, name, content FROM pages WHERE wiki_id = ? AND name = ?').get(wikiId, name) ??
        db.prepare('SELECT p.id, p.name, p.content FROM page_aliases a JOIN pages p ON p.id = a.page_id WHERE a.wiki_id = ? AND a.name = ?').get(wikiId, name)) as
        | { id: string; name: string; content: string }
        | undefined
    for (const t of extractWikiTargets(content).slice(0, 20)) if (out.length < 4) add(byName(normalizePageName(t)), 'このページからのリンク先')
    const parent = parentName(pageName)
    if (parent) add(byName(parent), '親ページ')
    for (const r of backlinkRows(wikiId, pid, pageName).sort((a, b) => b.updatedAt - a.updatedAt)) add(r, 'このページへリンクしているページ')
    // Pages that talk about this page's subject without linking to it: only the paragraphs that do.
    const leaf = pageName.split('/').pop()!
    if (leaf.length >= 2) {
      const rows = db
        .prepare('SELECT id, name, content FROM pages WHERE wiki_id = ? AND id != ? AND instr(content, ?) > 0 ORDER BY updated_at DESC LIMIT 8')
        .all(wikiId, pid, leaf) as { id: string; name: string; content: string }[]
      for (const r of rows) add({ ...r, content: excerptAround(r.content, leaf) }, 'このページの主題に触れているページ（該当する段落の抜粋）')
    }
    // The wiki's top page: what the wiki is about.
    const top = db.prepare('SELECT p.id, p.name, p.content FROM wikis w JOIN pages p ON p.id = w.top_page_id WHERE w.id = ?').get(wikiId) as
      | { id: string; name: string; content: string }
      | undefined
    add(top, 'wiki のトップページ')
    return out
  }

  /** Names of the wiki's pages (other than this one), most recently updated first, within a size budget. */
  function wikiPageNames(wikiId: string, pid: string): string[] {
    const rows = db.prepare('SELECT name FROM pages WHERE wiki_id = ? AND id != ? ORDER BY updated_at DESC LIMIT ?').all(wikiId, pid, AI_PAGE_LIST) as { name: string }[]
    const out: string[] = []
    let used = 0
    for (const r of rows) {
      used += r.name.length + 3
      if (used > AI_PAGE_LIST_CHARS) break
      out.push(r.name)
    }
    return out
  }

  app.get('/api/wikis/:wid/pages/:pid', (c) => {
    const { wikiId } = need(c, 'viewer')
    const p = pageRow(wikiId, c.req.param('pid'))
    if (!p) return c.json({ error: 'not_found' }, 404)
    return c.json({ page: p })
  })

  /**
   * Recent changes across the wiki: revisions grouped into edit sessions (per page and
   * person), newest first, each with its line counts.  `before` (ms) pages further back.
   */
  app.get('/api/wikis/:wid/changes', (c) => {
    const { wikiId } = need(c, 'viewer')
    const before = Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER)
    const LIMIT = 500
    type Row = { pageId: string; name: string; version: number; createdAt: number; length: number; byName: string | null; byEmail: string | null; via: string | null }
    let rows = db
      .prepare(
        `SELECT r.page_id AS pageId, p.name, r.version, r.created_at AS createdAt, length(r.content) AS length, u.name AS byName, u.email AS byEmail, r.via
         FROM page_revisions r JOIN pages p ON p.id = r.page_id LEFT JOIN users u ON u.id = r.created_by
         WHERE p.wiki_id = ? AND r.created_at < ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`,
      )
      .all(wikiId, before, LIMIT + 1) as Row[]
    let next: number | null = null
    if (rows.length > LIMIT) {
      // Cut at a timestamp boundary so the next request (created_at < next) misses nothing.
      const cut = rows[LIMIT - 1].createdAt
      const kept = rows.filter((r) => r.createdAt > cut)
      if (kept.length) {
        rows = kept
        next = cut + 1
      } else {
        rows = rows.slice(0, LIMIT)
        next = cut
      }
    }
    const groups = groupChanges(rows)
    const content = db.prepare('SELECT content FROM page_revisions WHERE page_id = ? AND version = ?')
    const text = (pid: string, v: number) => (content.get(pid, v) as { content: string } | undefined)?.content ?? ''
    const changes = groups.map((g) => {
      let added = 0
      let removed = 0
      for (const s of diffHunks(g.first.version > 1 ? text(g.first.pageId, g.first.version - 1) : '', text(g.last.pageId, g.last.version))) {
        if ('id' in s) (added += s.add.length), (removed += s.del.length)
      }
      return {
        pageId: g.last.pageId,
        name: g.last.name,
        from: g.first.version,
        to: g.last.version,
        count: g.count,
        at: g.last.createdAt,
        byName: g.last.byName,
        byEmail: g.last.byEmail,
        via: g.via,
        created: g.first.version === 1,
        added,
        removed,
      }
    })
    return c.json({ changes, next })
  })

  /** Revision metadata, newest first (content is fetched per version). */
  app.get('/api/wikis/:wid/pages/:pid/revisions', (c) => {
    const { wikiId } = need(c, 'viewer')
    const pid = c.req.param('pid')
    if (!db.prepare('SELECT 1 FROM pages WHERE wiki_id = ? AND id = ?').get(wikiId, pid)) return c.json({ error: 'not_found' }, 404)
    const before = Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER)
    const rows = db
      .prepare(
        `SELECT r.version, r.created_at AS createdAt, length(r.content) AS length, u.name AS byName, u.email AS byEmail, r.via
         FROM page_revisions r LEFT JOIN users u ON u.id = r.created_by
         WHERE r.page_id = ? AND r.version < ? ORDER BY r.version DESC LIMIT 501`,
      )
      .all(pid, before) as unknown[]
    return c.json({ revisions: rows.slice(0, 500), more: rows.length > 500 })
  })

  app.get('/api/wikis/:wid/pages/:pid/revisions/:ver', (c) => {
    const { wikiId } = need(c, 'viewer')
    const r = db
      .prepare('SELECT r.version, r.content FROM page_revisions r JOIN pages p ON p.id = r.page_id WHERE p.wiki_id = ? AND r.page_id = ? AND r.version = ?')
      .get(wikiId, c.req.param('pid'), Number(c.req.param('ver')))
    if (!r) return c.json({ error: 'not_found' }, 404)
    return c.json({ revision: r })
  })

  function createPage(wikiId: string, uid: string, rawName: string, content: string, via: string | null = null) {
    const name = validatePageName(rawName)
    if (!name) return { error: 'invalid_name' as const }
    if (content.length > MAX_CONTENT) return { error: 'too_large' as const }
    const id = crypto.randomUUID()
    const now = Date.now()
    try {
      tx(db, () => {
        db.prepare('INSERT INTO pages (id, wiki_id, name, content, version, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?)').run(id, wikiId, name, content, now, now, uid)
        db.prepare('INSERT INTO page_revisions (page_id, version, content, created_at, created_by, via) VALUES (?, 1, ?, ?, ?, ?)').run(id, content, now, uid, via)
        // A real page now owns this name; drop any alias that pointed elsewhere.
        db.prepare('DELETE FROM page_aliases WHERE wiki_id = ? AND name = ?').run(wikiId, name)
      })
    } catch (e) {
      if (String(e).includes('UNIQUE')) return { error: 'exists' as const }
      throw e
    }
    return { page: pageRow(wikiId, id)! }
  }
  app.post('/api/wikis/:wid/pages', async (c) => {
    const { wikiId } = need(c, 'editor')
    const b = await body<{ name?: string; content?: string }>(c)
    const r = createPage(wikiId, c.get('user').id, b.name ?? '', typeof b.content === 'string' ? b.content : '')
    if ('error' in r) return c.json({ error: r.error }, r.error === 'exists' ? 409 : r.error === 'too_large' ? 413 : 400)
    return c.json({ page: r.page }, 201)
  })

  /** Optimistic concurrency: the client sends the version it edited from. */
  app.put('/api/wikis/:wid/pages/:pid', async (c) => {
    const { wikiId } = need(c, 'editor')
    const b = await body<{ content?: string; baseVersion?: number; via?: string }>(c)
    if (typeof b.content !== 'string' || typeof b.baseVersion !== 'number') return c.json({ error: 'invalid' }, 400)
    // Shown in the history ("AI の提案を採用", "復元"); anything else is ordinary typing.
    const via = b.via === 'ai' || b.via === 'restore' ? b.via : null
    const result = savePage(wikiId, c.req.param('pid'), c.get('user').id, b.content, b.baseVersion, via)
    if (result.status === 413) return c.json({ error: 'too_large' }, 413)
    if (result.status === 404) return c.json({ error: 'not_found' }, 404)
    if (result.status === 409) return c.json({ error: 'conflict', current: result.current, base: result.base }, 409)
    return c.json({ page: result.page })
  })

  function savePage(wikiId: string, pid: string, uid: string, content: string, baseVersion: number, via: string | null) {
    if (content.length > MAX_CONTENT) return { status: 413 as const }
    return tx(db, () => {
      const cur = pageRow(wikiId, pid)
      if (!cur) return { status: 404 as const }
      if (cur.version !== baseVersion) {
        if (cur.content === content) return { status: 200 as const, page: cur } // same text: no conflict
        const base = db.prepare('SELECT content FROM page_revisions WHERE page_id = ? AND version = ?').get(pid, baseVersion) as { content: string } | undefined
        return { status: 409 as const, current: cur, base: base?.content ?? null }
      }
      if (cur.content === content) return { status: 200 as const, page: cur }
      const now = Date.now()
      const v = cur.version + 1
      db.prepare('UPDATE pages SET content = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(content, v, now, uid, pid)
      db.prepare('INSERT INTO page_revisions (page_id, version, content, created_at, created_by, via) VALUES (?, ?, ?, ?, ?, ?)').run(pid, v, content, now, uid, via)
      return { status: 200 as const, page: pageRow(wikiId, pid)! }
    })
  }

  /**
   * AI suggestion for part of a page.  The client sends its current text (it may hold
   * unsaved edits); nothing is stored: accepting the suggestion is an ordinary edit.
   */
  app.post('/api/wikis/:wid/pages/:pid/ai/revise', async (c) => {
    const { wikiId } = need(c, 'editor')
    if (!cfg.ai) return c.json({ error: 'ai_unavailable' }, 503)
    const w = db.prepare('SELECT name, ai_enabled FROM wikis WHERE id = ?').get(wikiId) as { name: string; ai_enabled: number }
    if (!w.ai_enabled) return c.json({ error: 'ai_disabled' }, 403)
    const page = db.prepare('SELECT name FROM pages WHERE wiki_id = ? AND id = ?').get(wikiId, c.req.param('pid')) as { name: string } | undefined
    if (!page) return c.json({ error: 'not_found' }, 404)
    const b = await body<{ content?: string; start?: number; end?: number; preset?: string; volume?: string; instruction?: string; web?: boolean; wiki?: boolean; stream?: boolean }>(c)
    const content = b.content
    if (typeof content !== 'string' || content.length > MAX_CONTENT) return c.json({ error: 'invalid' }, 400)
    const start = b.start ?? 0
    const end = b.end ?? content.length
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > content.length || start > end || (start === end && content.trim() !== '')) return c.json({ error: 'invalid_range' }, 400)
    if (end - start > AI_MAX_TARGET) return c.json({ error: 'too_large' }, 413)
    const preset = b.preset ?? 'auto'
    if (!isAiPreset(preset)) return c.json({ error: 'invalid_preset' }, 400)
    const volume = b.volume ?? 'auto'
    if (!isAiVolume(volume)) return c.json({ error: 'invalid_volume' }, 400)
    const instruction = typeof b.instruction === 'string' ? b.instruction.slice(0, 2000) : ''

    const target = content.slice(start, end)
    const pid = c.req.param('pid')!
    const linking = preset === 'links' || preset === 'keywords'
    const candidates = linking ? linkCandidates(wikiId, pid, target) : []
    // Nothing to link: answer without asking the model (and without counting a use).
    if (preset === 'links' && candidates.length === 0) {
      const none = { revised: target, summary: 'リンクにできるページ名は見つかりませんでした。', sources: [], related: [], remaining: null, links: [] }
      return b.stream === true ? new Response(JSON.stringify({ done: none }) + '\n', { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } }) : c.json(none)
    }

    const uid = c.get('user').id
    const day = new Date().toISOString().slice(0, 10)
    const used = (db.prepare('SELECT count FROM ai_usage WHERE user_id = ? AND day = ?').get(uid, day) as { count: number } | undefined)?.count ?? 0
    if (used >= AI_DAILY_LIMIT) return c.json({ error: 'rate_limited', limit: AI_DAILY_LIMIT }, 429)
    db.prepare('INSERT INTO ai_usage (user_id, day, count) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1').run(uid, day)
    db.prepare('DELETE FROM ai_usage WHERE day < ?').run(new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10))

    const related = b.wiki === true ? relatedPages(wikiId, pid, page.name, content) : []
    const wikiPages = b.wiki === true && !linking ? wikiPageNames(wikiId, pid) : []
    const req = { wikiName: w.name, pageName: page.name, page: content, start, end, preset, volume, instruction, web: !AI_NO_WEB.has(preset) && (b.web === true || AI_NEEDS_WEB.has(preset)), related, wikiPages, linkCandidates: candidates }
    // New [[links]] must point at pages that exist (the model may invent some).
    const exists = (name: string) =>
      !!(db.prepare('SELECT 1 FROM pages WHERE wiki_id = ? AND name = ?').get(wikiId, name) ?? db.prepare('SELECT 1 FROM page_aliases WHERE wiki_id = ? AND name = ?').get(wikiId, name))
    const before = new Set(extractWikiTargets(target))
    const remaining = AI_DAILY_LIMIT - used - 1
    const finish = (r: Awaited<ReturnType<Reviser>>) => {
      // Keep the target's trailing-newline shape so the splice stays clean.
      let revised = r.revised.replace(/\r\n?/g, '\n')
      const trail = (t: string) => /\n*$/.exec(t)![0]
      revised = revised.replace(/\n*$/, '') + trail(target)
      // (Except for key terms, where pages to be written are the point.)
      if (preset !== 'keywords' && revised.includes('[[')) revised = unwrapWikiLinks(revised, (t) => !before.has(t) && !exists(t))
      // Linking only adds links: rebuild from the original so nothing else changes; each
      // link is listed so that the client can adopt them one by one.
      let links: (SuggestedLink & { exists: boolean })[] | undefined
      if (linking) {
        links = suggestedLinks(target, revised).filter((l) => validatePageName(l.target)).map((l) => ({ ...l, exists: exists(normalizePageName(l.target)) }))
        revised = applyLinks(target, links)
      }
      // Only plain web links reach the client (they may be pasted into the page).
      const sources = (r.sources ?? []).filter((s) => /^https?:\/\//.test(s.uri)).map((s) => ({ uri: s.uri, title: s.title?.slice(0, 200) }))
      return { revised, summary: r.summary, sources, related: related.map((p) => p.name), remaining, links }
    }
    const ai = cfg.ai

    if (b.stream === true) {
      // NDJSON: {"text": answer so far} lines while the model writes (throttled), then {"done": result} or {"error": code}.
      const enc = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        async start(ctl) {
          const send = (o: unknown) => {
            try {
              ctl.enqueue(enc.encode(JSON.stringify(o) + '\n'))
            } catch {
              // client went away
            }
          }
          let last = 0
          let pending: string | null = null
          try {
            const r = await ai(req, (soFar) => {
              pending = soFar
              if (Date.now() - last < 150) return
              last = Date.now()
              send({ text: soFar })
              pending = null
            })
            if (pending !== null) send({ text: pending })
            send({ done: finish(r) })
          } catch (e) {
            console.error('ai revise failed', e)
            send({ error: 'ai_failed' })
          }
          try {
            ctl.close()
          } catch {}
        },
      })
      return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
    }

    try {
      return c.json(finish(await ai(req)))
    } catch (e) {
      console.error('ai revise failed', e)
      return c.json({ error: 'ai_failed' }, 502)
    }
  })

  app.post('/api/wikis/:wid/pages/:pid/rename', async (c) => {
    const { wikiId } = need(c, 'editor')
    const b = await body<{ name?: string; includeChildren?: boolean; rewriteLinks?: boolean }>(c)
    const newName = validatePageName(b.name ?? '')
    if (!newName) return c.json({ error: 'invalid_name' }, 400)
    const pid = c.req.param('pid')
    const uid = c.get('user').id
    const page = pageRow(wikiId, pid)
    if (!page) return c.json({ error: 'not_found' }, 404)
    const oldName = page.name
    if (newName === oldName) return c.json({ renamed: [], rewritten: 0 })
    if (newName.startsWith(oldName + '/')) return c.json({ error: 'into_self' }, 400)

    const targets: { id: string; name: string }[] = [{ id: pid, name: oldName }]
    if (b.includeChildren !== false) {
      targets.push(
        ...(db.prepare(`SELECT id, name FROM pages WHERE wiki_id = ? AND ${UNDER}`).all(wikiId, `${oldName}/`, `${oldName}/`) as {
          id: string
          name: string
        }[]),
      )
    }
    const renames = new Map(targets.map((t) => [t.name, newName + t.name.slice(oldName.length)]))
    const movingIds = new Set(targets.map((t) => t.id))
    for (const to of renames.values()) {
      const clash = db.prepare('SELECT id FROM pages WHERE wiki_id = ? AND name = ?').get(wikiId, to) as { id: string } | undefined
      if (clash && !movingIds.has(clash.id)) return c.json({ error: 'exists', name: to }, 409)
    }
    let rewritten = 0
    tx(db, () => {
      const now = Date.now()
      for (const t of targets) db.prepare('UPDATE pages SET name = ? WHERE id = ?').run(`\u0000${t.id}`, t.id)
      for (const t of targets) {
        const to = renames.get(t.name)!
        db.prepare('UPDATE pages SET name = ?, updated_at = ? WHERE id = ?').run(to, now, t.id)
        // Old name keeps resolving to the page, so existing [[links]] never break.
        db.prepare('INSERT INTO page_aliases (wiki_id, name, page_id) VALUES (?, ?, ?) ON CONFLICT(wiki_id, name) DO UPDATE SET page_id = excluded.page_id').run(wikiId, t.name, t.id)
        db.prepare('DELETE FROM page_aliases WHERE wiki_id = ? AND name = ?').run(wikiId, to)
      }
      if (b.rewriteLinks) {
        const all = db.prepare('SELECT id, content, version FROM pages WHERE wiki_id = ?').all(wikiId) as { id: string; content: string; version: number }[]
        for (const p of all) {
          const next = rewriteWikiLinks(p.content, renames)
          if (next === p.content) continue
          rewritten++
          db.prepare('UPDATE pages SET content = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(next, p.version + 1, now, uid, p.id)
          db.prepare("INSERT INTO page_revisions (page_id, version, content, created_at, created_by, via) VALUES (?, ?, ?, ?, ?, 'rename')").run(p.id, p.version + 1, next, now, uid)
        }
      }
    })
    return c.json({ renamed: [...renames].map(([from, to]) => ({ from, to })), rewritten, page: pageRow(wikiId, pid) })
  })

  // ---- files (images)

  app.post('/api/wikis/:wid/files', async (c) => {
    const { wikiId } = need(c, 'editor')
    const len = Number(c.req.header('content-length') ?? 0)
    if (len > MAX_FILE) return c.json({ error: 'too_large' }, 413)
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.length > MAX_FILE) return c.json({ error: 'too_large' }, 413)
    const type = sniffImage(bytes)
    if (!type) return c.json({ error: 'unsupported_type' }, 415)
    const name = (c.req.query('name') ?? 'image').replace(/[\u0000-\u001f\\/]/g, '').slice(0, 200) || 'image'
    const id = crypto.randomUUID()
    tx(db, () => {
      db.prepare('INSERT INTO files (id, wiki_id, name, type, size, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, wikiId, name, type, bytes.length, Date.now(), c.get('user').id)
      for (let i = 0, seq = 0; i < bytes.length; i += CHUNK, seq++) db.prepare('INSERT INTO file_chunks (file_id, seq, data) VALUES (?, ?, ?)').run(id, seq, bytes.subarray(i, i + CHUNK))
    })
    return c.json({ file: { id, name, type, size: bytes.length, url: `/api/wikis/${wikiId}/files/${id}` } }, 201)
  })

  /** Every uploaded file in the wiki, newest first, with the pages that show it. */
  app.get('/api/wikis/:wid/files', (c) => {
    const { wikiId } = need(c, 'viewer')
    const files = db
      .prepare(
        `SELECT f.id, f.name, f.type, f.size, f.created_at AS createdAt, u.name AS byName
         FROM files f LEFT JOIN users u ON u.id = f.created_by WHERE f.wiki_id = ? ORDER BY f.created_at DESC, f.rowid DESC`,
      )
      .all(wikiId) as { id: string; name: string; type: string; size: number; createdAt: number; byName: string | null }[]
    const refs = new Map<string, { id: string; name: string }[]>()
    for (const r of db
      .prepare(
        `SELECT f.id AS fid, p.id, p.name FROM files f JOIN pages p ON p.wiki_id = f.wiki_id AND instr(p.content, '/files/' || f.id) > 0
         WHERE f.wiki_id = ? ORDER BY p.name`,
      )
      .all(wikiId) as { fid: string; id: string; name: string }[]) {
      const list = refs.get(r.fid) ?? []
      list.push({ id: r.id, name: r.name })
      refs.set(r.fid, list)
    }
    return c.json({ files: files.map((f) => ({ ...f, url: `/api/wikis/${wikiId}/files/${f.id}`, pages: refs.get(f.id) ?? [] })) })
  })

  app.get('/api/wikis/:wid/files/:fid', (c) => {
    const fid = c.req.param('fid')
    const u = c.get('user') as User | undefined
    const wikiId = resolveWikiId(c.req.param('wid')!) ?? ''
    // Members see every file; others only the images on a published page.
    const member = !!u && !!roleOf(u.id, wikiId)
    if (!member && !db.prepare('SELECT 1 FROM pages WHERE wiki_id = ? AND published_at IS NOT NULL AND instr(content, ?) > 0').get(wikiId, `/files/${fid}`))
      return c.json({ error: 'not_found' }, 404)
    const f = db.prepare('SELECT id, name, type, size FROM files WHERE wiki_id = ? AND id = ?').get(wikiId, fid) as
      | { id: string; name: string; type: string; size: number }
      | undefined
    if (!f) return c.json({ error: 'not_found' }, 404)
    const out = new Uint8Array(f.size)
    let at = 0
    for (const ch of db.prepare('SELECT data FROM file_chunks WHERE file_id = ? ORDER BY seq').all(f.id) as { data: Uint8Array | ArrayBuffer }[]) {
      const d = ch.data instanceof Uint8Array ? ch.data : new Uint8Array(ch.data)
      out.set(d, at)
      at += d.length
    }
    return new Response(out, {
      headers: {
        'content-type': f.type,
        'content-length': String(f.size),
        // Files never change (new upload = new id), but they are members-only (and an image
        // of a published page stops being public when the page is unpublished).
        'cache-control': member ? 'private, max-age=31536000, immutable' : 'private, no-cache',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      },
    })
  })

  /** Publish / unpublish a page (owner): published pages are readable without logging in. */
  app.post('/api/wikis/:wid/pages/:pid/publish', async (c) => {
    const { wikiId } = need(c, 'owner')
    const b = await body<{ published?: boolean }>(c)
    if (typeof b.published !== 'boolean') return c.json({ error: 'invalid' }, 400)
    const pid = c.req.param('pid')
    const r = db.prepare('UPDATE pages SET published_at = ? WHERE wiki_id = ? AND id = ?').run(b.published ? Date.now() : null, wikiId, pid)
    if (!r.changes) return c.json({ error: 'not_found' }, 404)
    return c.json({ page: pageRow(wikiId, pid) })
  })

  /**
   * A published page for anyone (no login): its text, and which other pages of the wiki
   * are published (links to the rest are shown as plain text).  Unpublished looks like
   * missing (404).
   */
  app.get('/api/public/wikis/:wid/page', (c) => {
    const wikiId = resolveWikiId(c.req.param('wid')!)
    const name = validatePageName(c.req.query('name') ?? '')
    if (!wikiId || !name) return c.json({ error: 'not_found' }, 404)
    const p = (db.prepare('SELECT id, name, content, updated_at AS updatedAt, published_at AS publishedAt FROM pages WHERE wiki_id = ? AND name = ?').get(wikiId, name) ??
      db.prepare('SELECT p.id, p.name, p.content, p.updated_at AS updatedAt, p.published_at AS publishedAt FROM page_aliases a JOIN pages p ON p.id = a.page_id WHERE a.wiki_id = ? AND a.name = ?').get(wikiId, name)) as
      | { id: string; name: string; content: string; updatedAt: number; publishedAt: number | null }
      | undefined
    if (!p || p.publishedAt === null) return c.json({ error: 'not_found' }, 404)
    const w = db.prepare('SELECT name, slug FROM wikis WHERE id = ?').get(wikiId) as { name: string; slug: string }
    const pub = db.prepare('SELECT id, name FROM pages WHERE wiki_id = ? AND published_at IS NOT NULL').all(wikiId) as { id: string; name: string }[]
    const ids = new Set(pub.map((r) => r.id))
    const aliases = (db.prepare('SELECT name, page_id FROM page_aliases WHERE wiki_id = ?').all(wikiId) as { name: string; page_id: string }[]).filter((a) => ids.has(a.page_id))
    return c.json(
      { wiki: { name: w.name, slug: w.slug }, page: { name: p.name, content: p.content, updatedAt: p.updatedAt }, published: [...pub.map((r) => r.name), ...aliases.map((a) => a.name)] },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  app.delete('/api/wikis/:wid/pages/:pid', (c) => {
    const { wikiId } = need(c, 'editor')
    const r = db.prepare('DELETE FROM pages WHERE wiki_id = ? AND id = ?').run(wikiId, c.req.param('pid'))
    if (!r.changes) return c.json({ error: 'not_found' }, 404)
    return c.json({ ok: true })
  })

  // ---- MCP server per wiki (+ the OAuth authorization server its clients use)

  mountMcp(app, db, {
    appOrigin: cfg.appOrigin,
    resolveWikiId,
    roleOf,
    wiki: (id) => db.prepare('SELECT id, name, slug FROM wikis WHERE id = ?').get(id) as { id: string; name: string; slug: string },
    userWikis: (uid) =>
      db.prepare('SELECT w.id, w.name, w.slug, m.role FROM wikis w JOIN memberships m ON m.wiki_id = w.id WHERE m.user_id = ? ORDER BY w.created_at').all(uid) as {
        id: string
        name: string
        slug: string
        role: Role
      }[],
    listPages: (wikiId) =>
      db
        .prepare('SELECT p.name, p.updated_at AS updatedAt, u.name AS updatedByName FROM pages p LEFT JOIN users u ON u.id = p.updated_by WHERE p.wiki_id = ? ORDER BY p.name')
        .all(wikiId) as { name: string; updatedAt: number; updatedByName: string | null }[],
    findPage: (wikiId, raw) => {
      const name = normalizePageName(raw)
      const id =
        (db.prepare('SELECT id FROM pages WHERE wiki_id = ? AND name = ?').get(wikiId, name) as { id: string } | undefined)?.id ??
        (db.prepare('SELECT page_id AS id FROM page_aliases WHERE wiki_id = ? AND name = ?').get(wikiId, name) as { id: string } | undefined)?.id
      return (id && (pageRow(wikiId, id) as PageInfo | undefined)) || null
    },
    search: (wikiId, q) => searchPages(wikiId, q).results.map((r) => ({ name: r.name, snippet: r.snippet ?? '', updatedAt: r.updatedAt })),
    createPage: (wikiId, uid, name, content) => createPage(wikiId, uid, name, content, 'mcp'),
    savePage: (wikiId, pid, uid, content, base, via) => savePage(wikiId, pid, uid, content, base, via) as SaveResult | { status: 413 },
    sessionUser: (c) => sessionUser(db, c),
  })

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404))

  return app
}

