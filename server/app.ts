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
import { validatePageName } from '../shared/pageName.js'
import { normalizeSlug, validateSlug } from '../shared/wikiSlug.js'
import { rewriteWikiLinks } from '../shared/markdown/wikilinks.js'

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
}

type Env = { Variables: { user: User } }

const MAX_CONTENT = 2_000_000

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
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
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
    if (!u) return c.json({ error: 'unauthenticated' }, 401)
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
                (SELECT COUNT(*) FROM memberships mm WHERE mm.wiki_id = w.id) AS memberCount
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
      .prepare('SELECT w.id, w.slug, w.name, p.id AS topPageId, p.name AS topPage FROM wikis w LEFT JOIN pages p ON p.id = w.top_page_id WHERE w.id = ?')
      .get(wikiId) as object
    return c.json({ wiki: { ...w, role } })
  })

  app.patch('/api/wikis/:wid', async (c) => {
    const { wikiId } = need(c, 'owner')
    const b = await body<{ name?: string; slug?: string; topPageId?: string | null }>(c)
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
        `SELECT p.id, p.name, p.content, p.version, p.updated_at AS updatedAt, u.name AS updatedByName
         FROM pages p LEFT JOIN users u ON u.id = p.updated_by WHERE p.wiki_id = ? AND p.id = ?`,
      )
      .get(wikiId, pageId) as { id: string; name: string; content: string; version: number; updatedAt: number; updatedByName: string | null } | undefined

  app.get('/api/wikis/:wid/pages', (c) => {
    const { wikiId } = need(c, 'viewer')
    const q = (c.req.query('q') ?? '').trim()
    const pages = q
      ? db
          .prepare("SELECT id, name, updated_at AS updatedAt FROM pages WHERE wiki_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY name")
          .all(wikiId, `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`)
      : db.prepare('SELECT id, name, updated_at AS updatedAt FROM pages WHERE wiki_id = ? ORDER BY name').all(wikiId)
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

  app.get('/api/wikis/:wid/pages/:pid', (c) => {
    const { wikiId } = need(c, 'viewer')
    const p = pageRow(wikiId, c.req.param('pid'))
    if (!p) return c.json({ error: 'not_found' }, 404)
    return c.json({ page: p })
  })

  app.get('/api/wikis/:wid/pages/:pid/revisions/:ver', (c) => {
    const { wikiId } = need(c, 'viewer')
    const r = db
      .prepare('SELECT r.version, r.content FROM page_revisions r JOIN pages p ON p.id = r.page_id WHERE p.wiki_id = ? AND r.page_id = ? AND r.version = ?')
      .get(wikiId, c.req.param('pid'), Number(c.req.param('ver')))
    if (!r) return c.json({ error: 'not_found' }, 404)
    return c.json({ revision: r })
  })

  app.post('/api/wikis/:wid/pages', async (c) => {
    const { wikiId } = need(c, 'editor')
    const b = await body<{ name?: string; content?: string }>(c)
    const name = validatePageName(b.name ?? '')
    if (!name) return c.json({ error: 'invalid_name' }, 400)
    const content = typeof b.content === 'string' ? b.content : ''
    if (content.length > MAX_CONTENT) return c.json({ error: 'too_large' }, 413)
    const id = crypto.randomUUID()
    const now = Date.now()
    const uid = c.get('user').id
    try {
      tx(db, () => {
        db.prepare('INSERT INTO pages (id, wiki_id, name, content, version, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?)').run(id, wikiId, name, content, now, now, uid)
        db.prepare('INSERT INTO page_revisions (page_id, version, content, created_at, created_by) VALUES (?, 1, ?, ?, ?)').run(id, content, now, uid)
        // A real page now owns this name; drop any alias that pointed elsewhere.
        db.prepare('DELETE FROM page_aliases WHERE wiki_id = ? AND name = ?').run(wikiId, name)
      })
    } catch (e) {
      if (String(e).includes('UNIQUE')) return c.json({ error: 'exists' }, 409)
      throw e
    }
    return c.json({ page: pageRow(wikiId, id) }, 201)
  })

  /** Optimistic concurrency: the client sends the version it edited from. */
  app.put('/api/wikis/:wid/pages/:pid', async (c) => {
    const { wikiId } = need(c, 'editor')
    const b = await body<{ content?: string; baseVersion?: number }>(c)
    if (typeof b.content !== 'string' || typeof b.baseVersion !== 'number') return c.json({ error: 'invalid' }, 400)
    if (b.content.length > MAX_CONTENT) return c.json({ error: 'too_large' }, 413)
    const pid = c.req.param('pid')
    const uid = c.get('user').id
    const content = b.content
    const result = tx(db, () => {
      const cur = pageRow(wikiId, pid)
      if (!cur) return { status: 404 as const }
      if (cur.version !== b.baseVersion) {
        if (cur.content === content) return { status: 200 as const, page: cur } // same text: no conflict
        const base = db.prepare('SELECT content FROM page_revisions WHERE page_id = ? AND version = ?').get(pid, b.baseVersion as number) as { content: string } | undefined
        return { status: 409 as const, current: cur, base: base?.content ?? null }
      }
      if (cur.content === content) return { status: 200 as const, page: cur }
      const now = Date.now()
      const v = cur.version + 1
      db.prepare('UPDATE pages SET content = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(content, v, now, uid, pid)
      db.prepare('INSERT INTO page_revisions (page_id, version, content, created_at, created_by) VALUES (?, ?, ?, ?, ?)').run(pid, v, content, now, uid)
      return { status: 200 as const, page: pageRow(wikiId, pid)! }
    })
    if (result.status === 404) return c.json({ error: 'not_found' }, 404)
    if (result.status === 409) return c.json({ error: 'conflict', current: result.current, base: result.base }, 409)
    return c.json({ page: result.page })
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
          db.prepare('INSERT INTO page_revisions (page_id, version, content, created_at, created_by) VALUES (?, ?, ?, ?, ?)').run(p.id, p.version + 1, next, now, uid)
        }
      }
    })
    return c.json({ renamed: [...renames].map(([from, to]) => ({ from, to })), rewritten, page: pageRow(wikiId, pid) })
  })

  app.delete('/api/wikis/:wid/pages/:pid', (c) => {
    const { wikiId } = need(c, 'editor')
    const r = db.prepare('DELETE FROM pages WHERE wiki_id = ? AND id = ?').run(wikiId, c.req.param('pid'))
    if (!r.changes) return c.json({ error: 'not_found' }, 404)
    return c.json({ ok: true })
  })

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404))

  return app
}
