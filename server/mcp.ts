/**
 * Per-wiki MCP server (Streamable HTTP, stateless JSON responses) at /mcp/<wiki>, and the
 * OAuth 2.1 authorization server that MCP clients (claude.ai connectors, Claude Code, …)
 * use to get a token for it:
 *
 *  - /.well-known/oauth-protected-resource/mcp/<wiki>  (RFC 9728) → points at this origin
 *  - /.well-known/oauth-authorization-server           (RFC 8414)
 *  - POST /oauth/register   dynamic client registration (RFC 7591; public clients only)
 *  - GET  /oauth/authorize  checks the client, then hands over to the SPA consent page /connect
 *  - POST /api/oauth/approve (logged-in user, from /connect) → authorization code
 *  - POST /oauth/token      code (+ PKCE S256) → access + refresh token; refresh rotates both
 *
 * A grant ties one client to one user and one wiki. Each request re-checks the user's
 * current role, so removing a member (or downgrading to viewer) takes effect at once.
 */
import type { Context, Hono } from 'hono'
import { createHash } from 'node:crypto'
import { type DB, tx } from './db.js'
import { randomToken, sha256, type User } from './auth.js'
import type { Role } from './app.js'

const ACCESS_TTL = 3600 * 1000
const REFRESH_TTL = 60 * 86400 * 1000
const CODE_TTL = 10 * 60 * 1000
/** read_image: larger images are refused (clients cap image size; base64 adds a third). */
const MAX_IMAGE = 5 * 1024 * 1024
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
export const SCOPES = ['wiki:read', 'wiki:write'] as const
export type Access = 'read' | 'write'

export interface PageInfo {
  id: string
  name: string
  content: string
  version: number
  updatedAt: number
  updatedByName: string | null
}
export type SaveResult = { status: 200; page: PageInfo } | { status: 404 } | { status: 409; current: PageInfo }

/** What the MCP tools need from the wiki (implemented in app.ts on top of its queries). */
export interface WikiOps {
  appOrigin: string
  resolveWikiId(param: string): string | null
  roleOf(userId: string, wikiId: string): Role | null
  wiki(wikiId: string): { id: string; name: string; slug: string }
  userWikis(userId: string): { id: string; name: string; slug: string; role: Role }[]
  listPages(wikiId: string): { name: string; updatedAt: number; updatedByName: string | null }[]
  /** By name or by one of its former names. */
  findPage(wikiId: string, name: string): PageInfo | null
  search(wikiId: string, q: string): { name: string; snippet: string; updatedAt: number }[]
  createPage(wikiId: string, userId: string, name: string, content: string): { page: PageInfo } | { error: 'exists' | 'invalid_name' | 'too_large' }
  savePage(wikiId: string, pageId: string, userId: string, content: string, baseVersion: number, via: string | null): SaveResult | { status: 413 }
  renamePage(
    wikiId: string,
    pageId: string,
    userId: string,
    newName: string,
    includeChildren: boolean,
    rewriteLinks: boolean,
  ): { error: string; name?: string } | { renamed: { from: string; to: string }[]; rewritten: number; page: PageInfo }
  deletePage(wikiId: string, pageId: string): boolean
  readFile(wikiId: string, fileId: string): { name: string; type: string; size: number; bytes: Uint8Array } | null
  /** The owner can turn MCP off for a wiki. */
  mcpEnabled(wikiId: string): boolean
  sessionUser(c: Context): User | null
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
  'access-control-max-age': '86400',
}

/** Paths that bearer-token / anonymous OAuth clients call cross-site (no cookies involved). */
export const isOAuthClientPath = (p: string) => p.startsWith('/mcp/') || p === '/oauth/token' || p === '/oauth/register' || p.startsWith('/.well-known/')

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...extra } })

/** Loopback redirect URIs may use any port (RFC 8252 §7.3). */
function redirectMatches(registered: string, given: string): boolean {
  if (registered === given) return true
  try {
    const a = new URL(registered)
    const b = new URL(given)
    const loop = (u: URL) => u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
    return loop(a) && loop(b) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search
  } catch {
    return false
  }
}

function validRedirect(u: string): boolean {
  if (u.length > 2000) return false
  try {
    const url = new URL(u)
    if (url.hash) return false
    if (url.protocol === 'https:') return true
    if (url.protocol === 'http:') return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
    // Native apps (cursor://, vscode://, …); never script or local-file schemes.
    return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(url.protocol)
  } catch {
    return false
  }
}

const accessOf = (scope: string): Access => (scope.split(' ').includes('wiki:write') ? 'write' : 'read')
const scopeOf = (a: Access) => (a === 'write' ? 'wiki:read wiki:write' : 'wiki:read')

interface AuthRequest {
  clientId: string
  clientName: string
  redirectUri: string
  state: string | null
  challenge: string
  /** Wiki named by the resource indicator (null: the user picks one). */
  wikiParam: string | null
  wantsWrite: boolean
}

export function mountMcp(app: Hono<any>, db: DB, ops: WikiOps) {
  const origin = ops.appOrigin
  const issuer = origin

  // ------------------------------------------------------------------ metadata

  const asMeta = () => ({
    issuer,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SCOPES],
  })
  app.get('/.well-known/oauth-authorization-server', () => json(asMeta()))
  app.get('/.well-known/oauth-authorization-server/*', () => json(asMeta()))
  app.get('/.well-known/openid-configuration', () => json(asMeta()))

  const prMeta = (resource: string) => ({
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Markdown Wiki',
  })
  app.get('/.well-known/oauth-protected-resource/mcp/:wid', (c) => json(prMeta(`${origin}/mcp/${c.req.param('wid')}`)))
  app.get('/.well-known/oauth-protected-resource', () => json(prMeta(origin)))
  app.options('*', (c, next) => (isOAuthClientPath(c.req.path) ? new Response(null, { status: 204, headers: CORS }) : next()))

  // ------------------------------------------------------------------ registration

  app.post('/oauth/register', async (c) => {
    let b: { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown }
    try {
      b = await c.req.json()
    } catch {
      return json({ error: 'invalid_client_metadata', error_description: 'JSON body required' }, 400)
    }
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === 'string') : []
    if (!uris.length || uris.length > 10 || uris.length !== (b.redirect_uris as unknown[]).length || !uris.every(validRedirect))
      return json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https, http loopback, or an app scheme' }, 400)
    const name = (typeof b.client_name === 'string' ? b.client_name : '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 100) || new URL(uris[0]).host || 'MCP クライアント'
    const id = crypto.randomUUID()
    const now = Date.now()
    tx(db, () => {
      // Registrations nobody ever completed are dropped after a day.
      db.prepare('DELETE FROM oauth_clients WHERE created_at < ? AND id NOT IN (SELECT client_id FROM oauth_grants)').run(now - 86400_000)
      db.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').run(id, name, JSON.stringify(uris), now)
    })
    return json(
      {
        client_id: id,
        client_id_issued_at: Math.floor(now / 1000),
        client_name: name,
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      201,
    )
  })

  // ------------------------------------------------------------------ authorization

  /** Validate an authorization request (the query of /oauth/authorize). */
  function parseAuthRequest(q: URLSearchParams): { ok: AuthRequest } | { fatal: string } | { redirectError: string; redirectUri: string; state: string | null } {
    const clientId = q.get('client_id') ?? ''
    const client = db.prepare('SELECT name, redirect_uris FROM oauth_clients WHERE id = ?').get(clientId) as { name: string; redirect_uris: string } | undefined
    if (!client) return { fatal: '不明なクライアントです。接続し直してください。' }
    const registered = JSON.parse(client.redirect_uris) as string[]
    const redirectUri = q.get('redirect_uri') ?? (registered.length === 1 ? registered[0] : '')
    if (!registered.some((r) => redirectMatches(r, redirectUri))) return { fatal: 'リダイレクト先がクライアントの登録と一致しません。' }
    const state = q.get('state')
    const err = (e: string) => ({ redirectError: e, redirectUri, state })
    if (q.get('response_type') !== 'code') return err('unsupported_response_type')
    const challenge = q.get('code_challenge') ?? ''
    if (!challenge || (q.get('code_challenge_method') ?? 'plain') !== 'S256') return err('invalid_request')
    let wikiParam: string | null = null
    const resource = q.get('resource')
    if (resource && resource !== origin && resource !== `${origin}/`) {
      const m = resource.startsWith(`${origin}/mcp/`) ? resource.slice(`${origin}/mcp/`.length).replace(/\/$/, '') : null
      if (!m || m.includes('/')) return err('invalid_target')
      wikiParam = decodeURIComponent(m)
    }
    const scope = q.get('scope')
    return { ok: { clientId, clientName: client.name, redirectUri, state, challenge, wikiParam, wantsWrite: !scope || scope.split(' ').includes('wiki:write') } }
  }

  const withParams = (uri: string, params: Record<string, string | null>) => {
    const u = new URL(uri)
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v)
    return u.toString()
  }

  app.get('/oauth/authorize', (c) => {
    const q = new URL(c.req.url).searchParams
    const r = parseAuthRequest(q)
    if ('fatal' in r) return c.text(r.fatal, 400)
    if ('redirectError' in r) return c.redirect(withParams(r.redirectUri, { error: r.redirectError, state: r.state, iss: issuer }))
    // The consent page is part of the SPA (it handles login first, with returnTo).
    return c.redirect(`/connect?${q.toString()}`)
  })

  /** For the consent page: who is asking, for which wiki. */
  app.get('/api/oauth/request', (c) => {
    const u = c.get('user') as User
    const r = parseAuthRequest(new URL(c.req.url).searchParams)
    if ('fatal' in r) return c.json({ error: 'invalid_request', message: r.fatal }, 400)
    if ('redirectError' in r) return c.json({ error: 'invalid_request', message: `要求が正しくありません（${r.redirectError}）。` }, 400)
    const a = r.ok
    const wikis = ops.userWikis(u.id)
    let wiki: (typeof wikis)[number] | null = null
    if (a.wikiParam) {
      const id = ops.resolveWikiId(a.wikiParam)
      wiki = wikis.find((w) => w.id === id) ?? null
      if (!wiki) return c.json({ error: 'not_member', message: 'この wiki のメンバーではないため接続できません。' }, 403)
      if (!ops.mcpEnabled(wiki.id)) return c.json({ error: 'mcp_disabled', message: 'この wiki では、オーナーが AI アプリからの接続（MCP）を止めています。' }, 403)
    }
    return c.json({
      client: { name: a.clientName, redirectHost: redirectLabel(a.redirectUri) },
      wiki,
      wikis: wiki ? [] : wikis.filter((w) => ops.mcpEnabled(w.id)),
      wantsWrite: a.wantsWrite,
      denyUrl: withParams(a.redirectUri, { error: 'access_denied', state: a.state, iss: issuer }),
    })
  })

  app.post('/api/oauth/approve', async (c) => {
    const u = c.get('user') as User
    const b = (await c.req.json().catch(() => ({}))) as { query?: string; wikiId?: string; access?: string }
    const r = parseAuthRequest(new URLSearchParams(b.query ?? ''))
    if (!('ok' in r)) return c.json({ error: 'invalid_request' }, 400)
    const a = r.ok
    const wikiId = a.wikiParam ? ops.resolveWikiId(a.wikiParam) : (b.wikiId ?? null)
    const role = wikiId ? ops.roleOf(u.id, wikiId) : null
    if (!wikiId || !role) return c.json({ error: 'not_member' }, 403)
    if (!ops.mcpEnabled(wikiId)) return c.json({ error: 'mcp_disabled' }, 403)
    const access: Access = b.access === 'write' && role !== 'viewer' ? 'write' : 'read'
    const code = randomToken()
    db.prepare(
      'INSERT INTO oauth_codes (code_hash, client_id, user_id, wiki_id, redirect_uri, challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(sha256(code), a.clientId, u.id, wikiId, a.redirectUri, a.challenge, scopeOf(access), Date.now() + CODE_TTL)
    return c.json({ redirect: withParams(a.redirectUri, { code, state: a.state, iss: issuer }) })
  })

  // ------------------------------------------------------------------ tokens

  function issueTokens(grantId: string) {
    const access = randomToken()
    const refresh = randomToken()
    const now = Date.now()
    db.prepare('UPDATE oauth_grants SET access_hash = ?, access_expires = ?, refresh_hash = ?, refresh_expires = ? WHERE id = ?').run(
      sha256(access),
      now + ACCESS_TTL,
      sha256(refresh),
      now + REFRESH_TTL,
      grantId,
    )
    return { access, refresh }
  }

  app.post('/oauth/token', async (c) => {
    const ct = c.req.header('content-type') ?? ''
    let p: Record<string, string>
    try {
      p = ct.includes('application/json') ? await c.req.json() : (Object.fromEntries(new URLSearchParams(await c.req.text())) as Record<string, string>)
    } catch {
      return json({ error: 'invalid_request' }, 400)
    }
    const bad = (error: string, description?: string) => json({ error, ...(description ? { error_description: description } : {}) }, 400)
    const now = Date.now()
    if (p.grant_type === 'authorization_code') {
      const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(sha256(p.code ?? '')) as
        | { client_id: string; user_id: string; wiki_id: string; redirect_uri: string; challenge: string; scope: string; expires_at: number }
        | undefined
      // Single use, whatever happens next.
      if (row) db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(sha256(p.code ?? ''))
      db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now)
      if (!row || row.expires_at < now) return bad('invalid_grant', 'code is invalid or expired')
      if (p.client_id && p.client_id !== row.client_id) return bad('invalid_grant', 'client mismatch')
      if (p.redirect_uri && p.redirect_uri !== row.redirect_uri) return bad('invalid_grant', 'redirect_uri mismatch')
      const verifier = p.code_verifier ?? ''
      if (createHash('sha256').update(verifier).digest('base64url') !== row.challenge) return bad('invalid_grant', 'PKCE verification failed')
      const id = crypto.randomUUID()
      db.prepare('INSERT INTO oauth_grants (id, client_id, user_id, wiki_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, row.client_id, row.user_id, row.wiki_id, row.scope, now)
      const t = issueTokens(id)
      return json({ access_token: t.access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: t.refresh, scope: row.scope })
    }
    if (p.grant_type === 'refresh_token') {
      const g = db.prepare('SELECT id, client_id, scope, refresh_expires FROM oauth_grants WHERE refresh_hash = ?').get(sha256(p.refresh_token ?? '')) as
        | { id: string; client_id: string; scope: string; refresh_expires: number }
        | undefined
      if (!g || g.refresh_expires < now || (p.client_id && p.client_id !== g.client_id)) return bad('invalid_grant', 'refresh token is invalid or expired')
      const t = issueTokens(g.id)
      return json({ access_token: t.access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: t.refresh, scope: g.scope })
    }
    return bad('unsupported_grant_type')
  })

  // ------------------------------------------------------------------ connected apps (settings)

  app.get('/api/wikis/:wid/mcp/grants', (c) => {
    const u = c.get('user') as User
    const wikiId = ops.resolveWikiId(c.req.param('wid')) ?? ''
    if (!ops.roleOf(u.id, wikiId)) return c.json({ error: 'not_found' }, 404)
    const grants = db
      .prepare(
        `SELECT g.id, c.name AS clientName, g.scope, g.created_at AS createdAt, g.last_used_at AS lastUsedAt
         FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id WHERE g.wiki_id = ? AND g.user_id = ? ORDER BY g.created_at DESC`,
      )
      .all(wikiId, u.id) as { id: string; clientName: string; scope: string; createdAt: number; lastUsedAt: number | null }[]
    return c.json({ grants: grants.map((g) => ({ ...g, access: accessOf(g.scope) })) })
  })

  app.delete('/api/wikis/:wid/mcp/grants/:gid', (c) => {
    const u = c.get('user') as User
    const wikiId = ops.resolveWikiId(c.req.param('wid')) ?? ''
    const r = db.prepare('DELETE FROM oauth_grants WHERE id = ? AND wiki_id = ? AND user_id = ?').run(c.req.param('gid'), wikiId, u.id)
    if (!r.changes) return c.json({ error: 'not_found' }, 404)
    return c.json({ ok: true })
  })

  // ------------------------------------------------------------------ MCP endpoint

  app.all('/mcp/:wid', async (c) => {
    const wid = c.req.param('wid')
    const challenge = (error?: string) =>
      json({ error: error ?? 'unauthorized' }, 401, {
        'www-authenticate': `Bearer realm="mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp/${encodeURIComponent(wid)}"${error ? `, error="${error}"` : ''}`,
      })
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1]
    if (!token) return challenge()
    const g = db.prepare('SELECT id, user_id, wiki_id, scope, access_expires, last_used_at FROM oauth_grants WHERE access_hash = ?').get(sha256(token)) as
      | { id: string; user_id: string; wiki_id: string; scope: string; access_expires: number; last_used_at: number | null }
      | undefined
    if (!g || g.access_expires < Date.now()) return challenge('invalid_token')
    if (ops.resolveWikiId(wid) !== g.wiki_id) return challenge('invalid_token') // a token is for one wiki
    const role = ops.roleOf(g.user_id, g.wiki_id)
    if (!role) return challenge('invalid_token') // no longer a member
    if (!g.last_used_at || Date.now() - g.last_used_at > 60_000) db.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(Date.now(), g.id)

    if (c.req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' })
    if (!ops.mcpEnabled(g.wiki_id))
      return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'この wiki では、オーナーが AI アプリからの接続（MCP）を止めています。' } }, 403)
    let msg: unknown
    try {
      msg = await c.req.json()
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
    }
    const canWrite = accessOf(g.scope) === 'write' && role !== 'viewer'
    const ctx: ToolCtx = { ops, wikiId: g.wiki_id, userId: g.user_id, canWrite }
    const batch = Array.isArray(msg)
    const replies = (batch ? (msg as unknown[]) : [msg]).map((m) => handleRpc(m, ctx)).filter((r): r is object => r !== null)
    if (!replies.length) return new Response(null, { status: 202, headers: CORS })
    return json(batch ? replies : replies[0])
  })
}

function redirectLabel(uri: string) {
  try {
    const u = new URL(uri)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.host : u.protocol.replace(/:$/, '')
  } catch {
    return uri
  }
}

// ==================================================================== JSON-RPC + tools

interface ToolCtx {
  ops: WikiOps
  wikiId: string
  userId: string
  canWrite: boolean
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

function handleRpc(raw: unknown, ctx: ToolCtx): object | null {
  const m = raw as Rpc
  if (!m || typeof m !== 'object' || typeof m.method !== 'string') {
    // A response from the client (we never send requests) or garbage.
    return m && typeof m === 'object' && 'id' in m && !('method' in m) ? null : { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }
  }
  const isNotification = !('id' in m)
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id ?? null, result })
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: m.id ?? null, error: { code, message } })
  if (isNotification) return null
  switch (m.method) {
    case 'initialize': {
      const asked = typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : ''
      const w = ctx.ops.wiki(ctx.wikiId)
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `markdown-wiki: ${w.name}`, title: `Markdown Wiki「${w.name}」`, version: '1.0.0' },
        instructions: instructions(w.name, ctx.canWrite),
      })
    }
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: TOOLS.filter((t) => ctx.canWrite || !t.write).map(({ write: _w, run: _r, ...t }) => t) })
    case 'tools/call': {
      const name = String(m.params?.name ?? '')
      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) return fail(-32602, `Unknown tool: ${name}`)
      if (tool.write && !ctx.canWrite) return ok(toolError('この接続は読み取り専用です（または wiki の閲覧者です）。書き込みには編集者として「読み書き」で接続し直してください。'))
      try {
        return ok(tool.run((m.params?.arguments ?? {}) as Record<string, unknown>, ctx))
      } catch (e) {
        if (e instanceof ToolError) return ok(toolError(e.message))
        console.error('mcp tool failed', e)
        return ok(toolError('内部エラーが発生しました。'))
      }
    }
    case 'resources/list':
      return ok({ resources: [] })
    case 'prompts/list':
      return ok({ prompts: [] })
    default:
      return fail(-32601, `Method not found: ${m.method}`)
  }
}

function instructions(wikiName: string, canWrite: boolean) {
  return [
    `This server is the Markdown Wiki "${wikiName}". Pages are Markdown documents, mostly written in Japanese.`,
    'Page names may contain "/" to form a hierarchy (e.g. "開発/API/認証"); a parent need not exist as a page.',
    'Link to other pages with [[ページ名]] or [[ページ名|表示テキスト]]. Use search to find pages before creating new ones, to avoid duplicates.',
    'Images in pages look like ![説明](/api/wikis/…/files/…); use read_image with that URL to see one.',
    canWrite
      ? 'To change a page, read it first, then use edit_page for targeted replacements or update_page with the base_version you read to rewrite it. Every change is kept in the page history.'
      : 'This connection is read-only.',
  ].join('\n')
}

class ToolError extends Error {}
const toolError = (text: string) => ({ content: [{ type: 'text', text }], isError: true })
const text = (t: string) => ({ content: [{ type: 'text', text: t }] })

const str = (a: Record<string, unknown>, k: string, required = true): string => {
  const v = a[k]
  if (typeof v === 'string') return v
  if (v == null && !required) return ''
  throw new ToolError(`引数 ${k} （文字列）が必要です。`)
}

const fmtTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
const encodePath = (name: string) => name.split('/').map(encodeURIComponent).join('/')
const pageUrl = (ctx: ToolCtx, name: string) => `${ctx.ops.appOrigin}/w/${ctx.ops.wiki(ctx.wikiId).slug}/p/${encodePath(name)}`

function mustFind(ctx: ToolCtx, name: string): PageInfo {
  const p = ctx.ops.findPage(ctx.wikiId, name.trim())
  if (!p) throw new ToolError(`ページ「${name}」はありません。search や list_pages で名前を確かめてください。`)
  return p
}

function pageHeader(ctx: ToolCtx, p: PageInfo) {
  return [`name: ${p.name}`, `version: ${p.version}`, `updated: ${fmtTime(p.updatedAt)}${p.updatedByName ? ` by ${p.updatedByName}` : ''}`, `url: ${pageUrl(ctx, p.name)}`].join('\n')
}

function saved(ctx: ToolCtx, r: SaveResult | { status: 413 }, what: string) {
  if (r.status === 404) throw new ToolError('ページが見つかりません（削除された可能性があります）。')
  if (r.status === 413) throw new ToolError('ページが大きすぎます。')
  if (r.status === 409)
    throw new ToolError(`ページはその間に更新されています（現在の版: ${r.current.version}）。read_page で最新の内容を読み直してから、もう一度変更してください。`)
  return text(`${what}\n${pageHeader(ctx, r.page)}`)
}

interface Tool {
  name: string
  title: string
  description: string
  inputSchema: object
  annotations: object
  write: boolean
  run(args: Record<string, unknown>, ctx: ToolCtx): object
}

const READ = { readOnlyHint: true, openWorldHint: false }

const TOOLS: Tool[] = [
  {
    name: 'list_pages',
    title: 'ページ一覧',
    description: 'List the pages of the wiki (name and last update), optionally only those under a prefix such as "開発/".',
    inputSchema: { type: 'object', properties: { prefix: { type: 'string', description: 'Only pages whose name starts with this' } } },
    annotations: READ,
    write: false,
    run(a, ctx) {
      const prefix = str(a, 'prefix', false)
      const pages = ctx.ops.listPages(ctx.wikiId).filter((p) => p.name.startsWith(prefix))
      if (!pages.length) return text(prefix ? `「${prefix}」で始まるページはありません。` : 'ページはまだありません。')
      return text(`${pages.length} pages\n` + pages.map((p) => `- ${p.name}  (updated ${fmtTime(p.updatedAt)}${p.updatedByName ? ` by ${p.updatedByName}` : ''})`).join('\n'))
    },
  },
  {
    name: 'read_page',
    title: 'ページを読む',
    description: 'Read a page: its Markdown source with its current version (needed for update_page).',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Page name, e.g. "開発/API"' } }, required: ['name'] },
    annotations: READ,
    write: false,
    run(a, ctx) {
      const p = mustFind(ctx, str(a, 'name'))
      return text(`${pageHeader(ctx, p)}\n---\n${p.content}`)
    },
  },
  {
    name: 'search',
    title: '全文検索',
    description: 'Full-text search over page names and bodies. Space-separated terms must all match. Returns up to 50 pages with a snippet, newest first.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    annotations: READ,
    write: false,
    run(a, ctx) {
      const hits = ctx.ops.search(ctx.wikiId, str(a, 'query')).slice(0, 50)
      if (!hits.length) return text('一致するページはありません。')
      return text(hits.map((h) => `## ${h.name}\n(updated ${fmtTime(h.updatedAt)})\n${h.snippet}`).join('\n\n'))
    },
  },
  {
    name: 'read_image',
    title: '画像を見る',
    description: 'Fetch an image uploaded to this wiki, given its URL as written in a page (e.g. "/api/wikis/<id>/files/<id>"), so you can look at it.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The image URL from the page Markdown' } }, required: ['url'] },
    annotations: READ,
    write: false,
    run(a, ctx) {
      const fid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?(?:[?#].*)?$/i.exec(str(a, 'url').trim())?.[1]
      const f = fid ? ctx.ops.readFile(ctx.wikiId, fid.toLowerCase()) : null
      if (!f) throw new ToolError('この wiki の画像が見つかりません。ページに書かれている画像の URL（/api/wikis/…/files/…）を指定してください。')
      if (f.size > MAX_IMAGE) throw new ToolError(`画像が大きすぎます（${(f.size / 1024 / 1024).toFixed(1)} MB、上限 ${MAX_IMAGE / 1024 / 1024} MB）。`)
      return {
        content: [
          { type: 'image', data: Buffer.from(f.bytes).toString('base64'), mimeType: f.type },
          { type: 'text', text: `${f.name}（${f.type}、${Math.max(1, Math.round(f.size / 1024))} KB）` },
        ],
      }
    },
  },
  {
    name: 'recent_changes',
    title: '最近の更新',
    description: 'Pages most recently updated, newest first.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '1–100, default 20' } } },
    annotations: READ,
    write: false,
    run(a, ctx) {
      const n = Math.max(1, Math.min(100, Math.floor(Number(a.limit ?? 20)) || 20))
      const pages = [...ctx.ops.listPages(ctx.wikiId)].sort((x, y) => y.updatedAt - x.updatedAt).slice(0, n)
      if (!pages.length) return text('ページはまだありません。')
      return text(pages.map((p) => `- ${fmtTime(p.updatedAt)}  ${p.name}${p.updatedByName ? `  (${p.updatedByName})` : ''}`).join('\n'))
    },
  },
  {
    name: 'create_page',
    title: 'ページを作る',
    description: 'Create a new page. Fails if a page with that name already exists.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Page name; "/" makes a hierarchy' }, content: { type: 'string', description: 'Markdown' } },
      required: ['name', 'content'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    write: true,
    run(a, ctx) {
      const r = ctx.ops.createPage(ctx.wikiId, ctx.userId, str(a, 'name'), str(a, 'content'))
      if ('error' in r) {
        throw new ToolError(
          r.error === 'exists' ? 'その名前のページはすでにあります。read_page で読んでから edit_page / update_page で変更してください。' : r.error === 'too_large' ? 'ページが大きすぎます。' : 'ページ名が正しくありません。',
        )
      }
      return text(`作成しました。\n${pageHeader(ctx, r.page)}`)
    },
  },
  {
    name: 'edit_page',
    title: 'ページの一部を書き換える',
    description:
      'Replace an exact piece of text in a page. old_text must appear exactly once (include surrounding text to make it unique) unless replace_all is true. An empty old_text appends new_text at the end of the page.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        old_text: { type: 'string', description: 'Exact text to replace (copy it from read_page)' },
        new_text: { type: 'string' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence' },
      },
      required: ['name', 'old_text', 'new_text'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    write: true,
    run(a, ctx) {
      const p = mustFind(ctx, str(a, 'name'))
      const oldText = str(a, 'old_text')
      const newText = str(a, 'new_text')
      let next: string
      if (!oldText) {
        next = p.content.replace(/\s*$/, '') + (p.content.trim() ? '\n\n' : '') + newText.replace(/^\n+/, '')
        if (!next.endsWith('\n')) next += '\n'
      } else {
        const count = p.content.split(oldText).length - 1
        if (count === 0) throw new ToolError('old_text がページの中に見つかりません。read_page で今の内容を確かめてください（空白や改行も一致させる必要があります）。')
        if (count > 1 && a.replace_all !== true) throw new ToolError(`old_text がページの中に ${count} か所あります。前後の文章を含めて 1 か所に絞るか、replace_all を true にしてください。`)
        next = a.replace_all === true ? p.content.split(oldText).join(newText) : p.content.replace(oldText, () => newText)
      }
      return saved(ctx, ctx.ops.savePage(ctx.wikiId, p.id, ctx.userId, next, p.version, 'mcp'), '更新しました。')
    },
  },
  {
    name: 'update_page',
    title: 'ページ全体を書き換える',
    description: 'Replace the whole content of a page. base_version must be the version you read (from read_page); if the page changed since, nothing is saved.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, content: { type: 'string', description: 'The new Markdown, in full' }, base_version: { type: 'number' } },
      required: ['name', 'content', 'base_version'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    write: true,
    run(a, ctx) {
      const p = mustFind(ctx, str(a, 'name'))
      const base = Number(a.base_version)
      if (!Number.isInteger(base)) throw new ToolError('base_version（read_page で得た版番号）が必要です。')
      return saved(ctx, ctx.ops.savePage(ctx.wikiId, p.id, ctx.userId, str(a, 'content'), base, 'mcp'), '更新しました。')
    },
  },
  {
    name: 'rename_page',
    title: 'ページの名前を変える',
    description:
      'Rename (or move, by changing the "/" path) a page. Its child pages move with it unless include_children is false. The old names keep working as aliases. With rewrite_links (default true), [[links]] to the old names in other pages are rewritten to the new names.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Current page name' },
        new_name: { type: 'string' },
        include_children: { type: 'boolean', description: 'Move child pages too (default true)' },
        rewrite_links: { type: 'boolean', description: 'Rewrite [[links]] in other pages (default true)' },
      },
      required: ['name', 'new_name'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    write: true,
    run(a, ctx) {
      const p = mustFind(ctx, str(a, 'name'))
      const r = ctx.ops.renamePage(ctx.wikiId, p.id, ctx.userId, str(a, 'new_name'), a.include_children !== false, a.rewrite_links !== false)
      if ('error' in r) {
        const msg: Record<string, string> = {
          exists: `「${r.name}」という名前のページがすでにあります。`,
          into_self: '自分の下の階層には移動できません。',
          invalid_name: '新しいページ名が正しくありません。',
          not_found: 'ページが見つかりません。',
        }
        throw new ToolError(msg[r.error] ?? '名前を変えられませんでした。')
      }
      if (!r.renamed.length) return text('名前は変わっていません（同じ名前です）。')
      return text(
        `名前を変えました。\n${r.renamed.map((x) => `- ${x.from} → ${x.to}`).join('\n')}\n` +
          (r.rewritten ? `ほかの ${r.rewritten} ページのリンクを書き換えました。\n` : '') +
          pageHeader(ctx, r.page),
      )
    },
  },
  {
    name: 'delete_page',
    title: 'ページを削除する',
    description:
      'Delete a page permanently, together with its history (this cannot be undone). Child pages are kept. base_version must be the version you read, so you only delete what you have seen. Ask the user before deleting.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, base_version: { type: 'number', description: 'The version from read_page' } },
      required: ['name', 'base_version'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    write: true,
    run(a, ctx) {
      const p = mustFind(ctx, str(a, 'name'))
      const base = Number(a.base_version)
      if (!Number.isInteger(base)) throw new ToolError('base_version（read_page で得た版番号）が必要です。')
      if (base !== p.version) throw new ToolError(`ページはその間に更新されています（現在の版: ${p.version}）。read_page で読み直してから判断してください。`)
      if (!ctx.ops.deletePage(ctx.wikiId, p.id)) throw new ToolError('ページが見つかりません。')
      return text(`「${p.name}」を削除しました（履歴も含めて元に戻せません）。`)
    },
  },
]
