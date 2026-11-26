import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { openDb } from '../server/db-node'
import { createApp } from '../server/app'

const ORIGIN = 'http://localhost:5173'
const REDIRECT = 'https://client.example/callback'

function setup() {
  return createApp(openDb(':memory:'), { appOrigin: ORIGIN, devLogin: true, secureCookies: false })
}
type App = ReturnType<typeof setup>

async function login(app: App, email: string) {
  const res = await app.request(`/auth/dev-login?email=${encodeURIComponent(email)}`)
  const cookie = res.headers.get('set-cookie')!.split(';')[0]
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await app.request(path, {
      method,
      headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'markdown-wiki' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: r.status, json: (await r.json().catch(() => null)) as any }
  }
  return { call, get: (p: string) => call('GET', p), post: (p: string, b: unknown = {}) => call('POST', p, b) }
}
type User = Awaited<ReturnType<typeof login>>

const verifier = 'v'.repeat(50)
const challenge = createHash('sha256').update(verifier).digest('base64url')

async function register(app: App, name = 'Test Client') {
  const r = await app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }) })
  expect(r.status).toBe(201)
  return ((await r.json()) as { client_id: string }).client_id
}

function authQuery(clientId: string, slug: string | null, scope?: string) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8' })
  if (slug) q.set('resource', `${ORIGIN}/mcp/${slug}`)
  if (scope) q.set('scope', scope)
  return q.toString()
}

async function token(app: App, params: Record<string, string>) {
  const r = await app.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() })
  return { status: r.status, json: (await r.json()) as any }
}

/** The whole flow: register, authorize (approve as `user`), exchange the code. */
async function connect(app: App, user: User, slug: string, access: 'read' | 'write' = 'write') {
  const clientId = await register(app)
  const query = authQuery(clientId, slug)
  const ap = await user.post('/api/oauth/approve', { query, access })
  expect(ap.status).toBe(200)
  const code = new URL(ap.json.redirect).searchParams.get('code')!
  const t = await token(app, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier })
  expect(t.status).toBe(200)
  return { clientId, access: t.json.access_token as string, refresh: t.json.refresh_token as string }
}

let rpcId = 0
async function rpc(app: App, slug: string, tok: string | null, method: string, params?: unknown) {
  const r = await app.request(`/mcp/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  return { status: r.status, headers: r.headers, json: (await r.json().catch(() => null)) as any }
}
const call = async (app: App, slug: string, tok: string, name: string, args: Record<string, unknown>) => {
  const r = await rpc(app, slug, tok, 'tools/call', { name, arguments: args })
  expect(r.status).toBe(200)
  return { text: r.json.result.content[0].text as string, isError: !!r.json.result.isError }
}

async function wikiWithPage(user: User) {
  const w = (await user.post('/api/wikis', { name: 'チーム', slug: 'team' })).json.wiki
  await user.post(`/api/wikis/${w.id}/pages`, { name: '開発/API', content: '# API\n\n認証は OAuth を使う。\n' })
  return w as { id: string; slug: string }
}

describe('MCP server with OAuth', () => {
  it('advertises OAuth: 401 with resource metadata, protected resource and AS metadata', async () => {
    const app = setup()
    const r = await rpc(app, 'team', null, 'initialize')
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/team"`)
    const pr = (await (await app.request('/.well-known/oauth-protected-resource/mcp/team')).json()) as any
    expect(pr).toMatchObject({ resource: `${ORIGIN}/mcp/team`, authorization_servers: [ORIGIN] })
    const as = (await (await app.request('/.well-known/oauth-authorization-server')).json()) as any
    expect(as).toMatchObject({ issuer: ORIGIN, token_endpoint: `${ORIGIN}/oauth/token`, registration_endpoint: `${ORIGIN}/oauth/register`, code_challenge_methods_supported: ['S256'] })
    // CORS preflight for browser-based clients
    const pre = await app.request('/mcp/team', { method: 'OPTIONS' })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization')
  })

  it('registration rejects unsafe redirect URIs', async () => {
    const app = setup()
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'https://x.example/cb#frag']) {
      const r = await app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [uri] }) })
      expect(r.status).toBe(400)
    }
    const ok = await app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:33418/cb'] }) })
    expect(ok.status).toBe(201)
  })

  it('authorize → consent → code → token → tools', async () => {
    const app = setup()
    const alice = await login(app, 'alice@example.com')
    const w = await wikiWithPage(alice)
    const clientId = await register(app, 'Claude')
    const query = authQuery(clientId, 'team')

    // /oauth/authorize hands over to the SPA consent page
    const az = await app.request(`/oauth/authorize?${query}`)
    expect(az.status).toBe(302)
    expect(az.headers.get('location')).toBe(`/connect?${query}`)
    // a wrong redirect_uri is never redirected to
    const bad = await app.request(`/oauth/authorize?${query.replace(encodeURIComponent(REDIRECT), encodeURIComponent('https://evil.example/cb'))}`)
    expect(bad.status).toBe(400)

    const info = await alice.get(`/api/oauth/request?${query}`)
    expect(info.json).toMatchObject({ client: { name: 'Claude', redirectHost: 'client.example' }, wiki: { id: w.id, name: 'チーム', role: 'owner' } })
    expect(info.json.denyUrl).toBe(`${REDIRECT}?error=access_denied&state=st8&iss=${encodeURIComponent(ORIGIN)}`)

    const ap = await alice.post('/api/oauth/approve', { query, access: 'write' })
    const back = new URL(ap.json.redirect)
    expect(back.origin + back.pathname).toBe(REDIRECT)
    expect(back.searchParams.get('state')).toBe('st8')
    const code = back.searchParams.get('code')!

    // PKCE is enforced, and a code is single use
    expect((await token(app, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: 'wrong'.repeat(10) })).json.error).toBe('invalid_grant')
    expect((await token(app, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier })).json.error).toBe('invalid_grant')

    const { access } = await connect(app, alice, 'team')
    const init = await rpc(app, 'team', access, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(init.json.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} } })
    expect(init.json.result.instructions).toContain('チーム')
    // notifications get 202 and no body
    const note = await app.request('/mcp/team', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${access}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    expect(note.status).toBe(202)

    const tools = (await rpc(app, 'team', access, 'tools/list')).json.result.tools.map((t: { name: string }) => t.name)
    expect(tools).toEqual(['list_pages', 'read_page', 'search', 'read_image', 'recent_changes', 'create_page', 'edit_page', 'update_page', 'rename_page', 'delete_page'])

    expect((await call(app, 'team', access, 'list_pages', {})).text).toContain('- 開発/API')
    const read = await call(app, 'team', access, 'read_page', { name: '開発/API' })
    expect(read.text).toContain('version: 1')
    expect(read.text).toContain(`url: ${ORIGIN}/w/team/p/${encodeURIComponent('開発')}/API`)
    expect(read.text).toContain('認証は OAuth を使う。')
    expect((await call(app, 'team', access, 'search', { query: 'OAuth' })).text).toContain('## 開発/API')
    expect((await call(app, 'team', access, 'read_page', { name: 'ない' })).isError).toBe(true)

    // writes
    expect((await call(app, 'team', access, 'create_page', { name: '議事録/11月', content: '# 11月\n' })).text).toContain('作成しました')
    expect((await call(app, 'team', access, 'create_page', { name: '議事録/11月', content: 'x' })).isError).toBe(true)
    const ed = await call(app, 'team', access, 'edit_page', { name: '開発/API', old_text: 'OAuth を使う', new_text: 'OAuth 2.1 を使う' })
    expect(ed.text).toContain('version: 2')
    expect((await call(app, 'team', access, 'edit_page', { name: '開発/API', old_text: 'ないもの', new_text: 'x' })).isError).toBe(true)
    await call(app, 'team', access, 'edit_page', { name: '開発/API', old_text: '', new_text: '## 追記\n\n末尾に足す。' })
    const stale = await call(app, 'team', access, 'update_page', { name: '開発/API', content: '古い版から', base_version: 1 })
    expect(stale.isError).toBe(true)
    expect(stale.text).toContain('現在の版: 3')
    expect((await call(app, 'team', access, 'update_page', { name: '開発/API', content: '# API\n\n全部書き直し\n', base_version: 3 })).text).toContain('version: 4')

    const page = (await alice.get(`/api/wikis/${w.id}/resolve?name=${encodeURIComponent('開発/API')}`)).json.page
    expect(page.content).toBe('# API\n\n全部書き直し\n')
    const revs = (await alice.get(`/api/wikis/${w.id}/pages/${page.id}/revisions`)).json.revisions
    expect(revs.slice(0, 3).map((r: { via: string }) => r.via)).toEqual(['mcp', 'mcp', 'mcp'])
    const hist = (await alice.get(`/api/wikis/${w.id}/pages/${page.id}/revisions/3`)).json.revision.content
    expect(hist).toBe('# API\n\n認証は OAuth 2.1 を使う。\n\n## 追記\n\n末尾に足す。\n')

    // connected apps list
    const grants = (await alice.get(`/api/wikis/${w.id}/mcp/grants`)).json.grants
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ clientName: 'Test Client', access: 'write' })
  })

  it('refresh rotates tokens; revoking, leaving the wiki or using another wiki stops access', async () => {
    const app = setup()
    const alice = await login(app, 'alice@example.com')
    const bob = await login(app, 'bob@example.com')
    const w = await wikiWithPage(alice)
    await alice.post(`/api/wikis/${w.id}/invitations`, { email: 'bob@example.com', role: 'editor' })
    await bob.get('/api/wikis') // accepts the invitation
    const other = (await alice.post('/api/wikis', { name: '別', slug: 'other' })).json.wiki

    const t = await connect(app, bob, 'team')
    const r1 = await token(app, { grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId })
    expect(r1.status).toBe(200)
    expect((await rpc(app, 'team', t.access, 'ping')).status).toBe(401) // old access token replaced
    expect((await rpc(app, 'team', r1.json.access_token, 'ping')).status).toBe(200)
    expect((await token(app, { grant_type: 'refresh_token', refresh_token: t.refresh })).json.error).toBe('invalid_grant') // old refresh token is gone

    // a token is for one wiki only
    expect((await rpc(app, other.slug, r1.json.access_token, 'ping')).status).toBe(401)

    // downgraded to viewer: write tools disappear
    const bobId = (await bob.get('/api/me')).json.user.id
    await alice.call('PATCH', `/api/wikis/${w.id}/members/${bobId}`, { role: 'viewer' })
    const tools = (await rpc(app, 'team', r1.json.access_token, 'tools/list')).json.result.tools.map((x: { name: string }) => x.name)
    expect(tools).not.toContain('edit_page')
    expect((await call(app, 'team', r1.json.access_token, 'create_page', { name: 'x', content: 'y' })).isError).toBe(true)

    // removed from the wiki: no access
    await alice.call('DELETE', `/api/wikis/${w.id}/members/${bobId}`)
    expect((await rpc(app, 'team', r1.json.access_token, 'ping')).status).toBe(401)

    // revoking from settings
    const a = await connect(app, alice, 'team')
    expect((await rpc(app, 'team', a.access, 'ping')).status).toBe(200)
    const g = (await alice.get(`/api/wikis/${w.id}/mcp/grants`)).json.grants[0]
    expect((await alice.call('DELETE', `/api/wikis/${w.id}/mcp/grants/${g.id}`)).status).toBe(200)
    expect((await rpc(app, 'team', a.access, 'ping')).status).toBe(401)
    expect((await token(app, { grant_type: 'refresh_token', refresh_token: a.refresh })).json.error).toBe('invalid_grant')
  })

  it('read-only grants and non-members', async () => {
    const app = setup()
    const alice = await login(app, 'alice@example.com')
    const mallory = await login(app, 'mallory@example.com')
    await wikiWithPage(alice)
    const ro = await connect(app, alice, 'team', 'read')
    const tools = (await rpc(app, 'team', ro.access, 'tools/list')).json.result.tools.map((x: { name: string }) => x.name)
    expect(tools).toEqual(['list_pages', 'read_page', 'search', 'read_image', 'recent_changes'])
    expect((await call(app, 'team', ro.access, 'edit_page', { name: '開発/API', old_text: 'OAuth', new_text: 'x' })).isError).toBe(true)

    // someone outside the wiki cannot approve access to it
    const clientId = await register(app)
    const q = authQuery(clientId, 'team')
    expect((await mallory.get(`/api/oauth/request?${q}`)).status).toBe(403)
    expect((await mallory.post('/api/oauth/approve', { query: q, access: 'write' })).status).toBe(403)
    // without a resource indicator the user picks one of their own wikis
    const q2 = authQuery(clientId, null)
    const info = (await alice.get(`/api/oauth/request?${q2}`)).json
    expect(info.wiki).toBeNull()
    expect(info.wikis.map((x: { slug: string }) => x.slug)).toEqual(['team'])
  })
})

describe('MCP: rename, delete, images, owner switch', () => {
  it('rename_page moves children and rewrites links; delete_page needs the version read', async () => {
    const app = setup()
    const alice = await login(app, 'alice@example.com')
    const w = await wikiWithPage(alice)
    await alice.post(`/api/wikis/${w.id}/pages`, { name: '開発/API/認証', content: 'OAuth' })
    await alice.post(`/api/wikis/${w.id}/pages`, { name: 'Home', content: '[[開発/API]] と [[開発/API/認証]]' })
    const { access } = await connect(app, alice, 'team')
    const tools = (await rpc(app, 'team', access, 'tools/list')).json.result.tools.map((t: { name: string }) => t.name)
    expect(tools).toEqual(expect.arrayContaining(['rename_page', 'delete_page', 'read_image']))

    const rn = await call(app, 'team', access, 'rename_page', { name: '開発/API', new_name: '設計/API' })
    expect(rn.text).toContain('- 開発/API → 設計/API')
    expect(rn.text).toContain('- 開発/API/認証 → 設計/API/認証')
    expect(rn.text).toContain('ほかの 1 ページのリンクを書き換えました')
    expect((await call(app, 'team', access, 'read_page', { name: 'Home' })).text).toContain('[[設計/API]] と [[設計/API/認証]]')
    expect((await call(app, 'team', access, 'read_page', { name: '開発/API' })).text).toContain('name: 設計/API') // old name = alias
    expect((await call(app, 'team', access, 'rename_page', { name: '設計/API', new_name: 'Home' })).text).toContain('すでにあります')

    expect((await call(app, 'team', access, 'delete_page', { name: '設計/API/認証', base_version: 99 })).isError).toBe(true)
    expect((await call(app, 'team', access, 'delete_page', { name: '設計/API/認証', base_version: 1 })).text).toContain('削除しました')
    expect((await call(app, 'team', access, 'read_page', { name: '設計/API/認証' })).isError).toBe(true)
  })

  it('read_image returns the image of this wiki only', async () => {
    const app = setup()
    const alice = await login(app, 'alice@example.com')
    const w = await wikiWithPage(alice)
    const other = (await alice.post('/api/wikis', { name: '別', slug: 'other' })).json.wiki
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    const res = await app.request(`/api/wikis/${other.id}/files?name=x.png`, {
      method: 'POST',
      headers: { cookie: (await app.request('/auth/dev-login?email=alice@example.com')).headers.get('set-cookie')!.split(';')[0], 'x-requested-with': 'markdown-wiki' },
      body: png,
    })
    const otherUrl = ((await res.json()) as any).file.url as string
    const up = await app.request(`/api/wikis/${w.id}/files?name=${encodeURIComponent('図.png')}`, {
      method: 'POST',
      headers: { cookie: (await app.request('/auth/dev-login?email=alice@example.com')).headers.get('set-cookie')!.split(';')[0], 'x-requested-with': 'markdown-wiki' },
      body: png,
    })
    const url = ((await up.json()) as any).file.url as string
    const { access } = await connect(app, alice, 'team')
    const r = await rpc(app, 'team', access, 'tools/call', { name: 'read_image', arguments: { url: `${ORIGIN}${url}` } })
    expect(r.json.result.content[0]).toEqual({ type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' })
    expect(r.json.result.content[1].text).toContain('図.png')
    expect((await call(app, 'team', access, 'read_image', { url: otherUrl })).isError).toBe(true) // another wiki's image
  })

  it('the owner can turn MCP off: requests and new connections are refused until turned on again', async () => {
    const app = setup()
    const alice = await login(app, 'alice@example.com')
    const w = await wikiWithPage(alice)
    const { access } = await connect(app, alice, 'team')
    expect((await alice.get(`/api/wikis/${w.id}`)).json.wiki.mcpEnabled).toBe(true)
    await alice.call('PATCH', `/api/wikis/${w.id}`, { mcpEnabled: false })
    expect((await alice.get(`/api/wikis/${w.id}`)).json.wiki.mcpEnabled).toBe(false)
    const off = await rpc(app, 'team', access, 'ping')
    expect(off.status).toBe(403)
    expect(off.json.error.message).toContain('止めています')
    const clientId = await register(app)
    expect((await alice.get(`/api/oauth/request?${authQuery(clientId, 'team')}`)).json.error).toBe('mcp_disabled')
    expect((await alice.post('/api/oauth/approve', { query: authQuery(clientId, 'team'), access: 'read' })).status).toBe(403)
    expect((await alice.get(`/api/oauth/request?${authQuery(clientId, null)}`)).json.wikis).toEqual([]) // not offered in the picker
    await alice.call('PATCH', `/api/wikis/${w.id}`, { mcpEnabled: true })
    expect((await rpc(app, 'team', access, 'ping')).status).toBe(200)
  })
})
