import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../server/db-node'
import { createApp } from '../server/app'

const ORIGIN = 'http://localhost:5173'

function setup(extra: Partial<Parameters<typeof createApp>[1]> = {}) {
  const db = openDb(':memory:')
  const app = createApp(db, { appOrigin: ORIGIN, devLogin: true, secureCookies: false, ...extra })
  return { db, app }
}

type App = ReturnType<typeof setup>['app']

async function login(app: App, email: string) {
  const res = await app.request(`/auth/dev-login?email=${encodeURIComponent(email)}`)
  const cookie = res.headers.get('set-cookie')!.split(';')[0]
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await app.request(path, {
      method,
      headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'markdown-wiki', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: r.status, json: (await r.json().catch(() => null)) as any }
  }
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b ?? {}),
    put: (p: string, b: unknown) => call('PUT', p, b),
    patch: (p: string, b: unknown) => call('PATCH', p, b),
    del: (p: string) => call('DELETE', p),
    raw: call,
  }
}

describe('auth & permissions', () => {
  let app: App
  beforeEach(() => {
    app = setup().app
  })

  it('rejects unauthenticated API access', async () => {
    const r = await app.request('/api/wikis')
    expect(r.status).toBe(401)
  })

  it('new wiki is private; outsiders cannot read or write pages', async () => {
    const alice = await login(app, 'alice@example.com')
    const mallory = await login(app, 'mallory@example.com')
    const w = (await alice.post('/api/wikis', { name: 'Alice wiki' })).json.wiki
    expect(w.role).toBe('owner')
    const p = (await alice.post(`/api/wikis/${w.id}/pages`, { name: '秘密', content: 'secret' })).json.page

    expect((await mallory.get('/api/wikis')).json.wikis).toEqual([])
    expect((await mallory.get(`/api/wikis/${w.id}`)).status).toBe(404)
    expect((await mallory.get(`/api/wikis/${w.id}/pages`)).status).toBe(404)
    expect((await mallory.get(`/api/wikis/${w.id}/pages/${p.id}`)).status).toBe(404)
    expect((await mallory.put(`/api/wikis/${w.id}/pages/${p.id}`, { content: 'pwned', baseVersion: 1 })).status).toBe(404)
    expect((await mallory.del(`/api/wikis/${w.id}/pages/${p.id}`)).status).toBe(404)
    expect((await mallory.post(`/api/wikis/${w.id}/invitations`, { email: 'mallory@example.com', role: 'owner' })).status).toBe(404)
    expect((await alice.get(`/api/wikis/${w.id}/pages/${p.id}`)).json.page.content).toBe('secret')
  })

  it('a page id from another wiki cannot be accessed through my wiki', async () => {
    const alice = await login(app, 'alice@example.com')
    const bob = await login(app, 'bob@example.com')
    const wa = (await alice.post('/api/wikis', { name: 'A' })).json.wiki
    const wb = (await bob.post('/api/wikis', { name: 'B' })).json.wiki
    const pa = (await alice.post(`/api/wikis/${wa.id}/pages`, { name: 'x', content: 'alice' })).json.page
    expect((await bob.get(`/api/wikis/${wb.id}/pages/${pa.id}`)).status).toBe(404)
    expect((await bob.put(`/api/wikis/${wb.id}/pages/${pa.id}`, { content: 'z', baseVersion: 1 })).status).toBe(404)
  })

  it('invitation by email: joins on login, roles enforced', async () => {
    const owner = await login(app, 'owner@example.com')
    const w = (await owner.post('/api/wikis', { name: 'Team' })).json.wiki
    const p = (await owner.post(`/api/wikis/${w.id}/pages`, { name: 'Doc', content: 'v1' })).json.page
    expect((await owner.post(`/api/wikis/${w.id}/invitations`, { email: 'Viewer@Example.com', role: 'viewer' })).status).toBe(201)
    expect((await owner.post(`/api/wikis/${w.id}/invitations`, { email: 'editor@example.com', role: 'editor' })).status).toBe(201)

    const viewer = await login(app, 'viewer@example.com')
    const vw = (await viewer.get('/api/wikis')).json.wikis
    expect(vw.map((x: any) => [x.id, x.role])).toEqual([[w.id, 'viewer']])
    expect((await viewer.get(`/api/wikis/${w.id}/pages/${p.id}`)).json.page.content).toBe('v1')
    expect((await viewer.put(`/api/wikis/${w.id}/pages/${p.id}`, { content: 'v2', baseVersion: 1 })).status).toBe(403)
    expect((await viewer.post(`/api/wikis/${w.id}/pages`, { name: 'new' })).status).toBe(403)
    expect((await viewer.del(`/api/wikis/${w.id}/pages/${p.id}`)).status).toBe(403)
    expect((await viewer.post(`/api/wikis/${w.id}/pages/${p.id}/rename`, { name: 'x' })).status).toBe(403)

    const editor = await login(app, 'editor@example.com')
    expect((await editor.put(`/api/wikis/${w.id}/pages/${p.id}`, { content: 'v2', baseVersion: 1 })).status).toBe(200)
    expect((await editor.post(`/api/wikis/${w.id}/invitations`, { email: 'x@example.com', role: 'viewer' })).status).toBe(403)
    const members = (await editor.get(`/api/wikis/${w.id}/members`)).json.members
    expect((await editor.patch(`/api/wikis/${w.id}/members/${members[0].userId}`, { role: 'viewer' })).status).toBe(403)
    expect((await editor.del(`/api/wikis/${w.id}`)).status).toBe(403)
  })

  it('owner manages roles; last owner is protected', async () => {
    const owner = await login(app, 'owner@example.com')
    const w = (await owner.post('/api/wikis', { name: 'Team' })).json.wiki
    await owner.post(`/api/wikis/${w.id}/invitations`, { email: 'b@example.com', role: 'viewer' })
    const b = await login(app, 'b@example.com')
    await b.get('/api/wikis')
    const ms = (await owner.get(`/api/wikis/${w.id}/members`)).json.members
    const me = ms.find((m: any) => m.email === 'owner@example.com')
    const bm = ms.find((m: any) => m.email === 'b@example.com')
    expect((await owner.patch(`/api/wikis/${w.id}/members/${me.userId}`, { role: 'editor' })).status).toBe(409)
    expect((await owner.patch(`/api/wikis/${w.id}/members/${bm.userId}`, { role: 'editor' })).status).toBe(200)
    expect((await b.post(`/api/wikis/${w.id}/pages`, { name: 'by-b' })).status).toBe(201)
    expect((await owner.del(`/api/wikis/${w.id}/members/${bm.userId}`)).status).toBe(200)
    expect((await b.get(`/api/wikis/${w.id}/pages`)).status).toBe(404)
  })

  it('rejects state-changing requests without the CSRF header or from another origin', async () => {
    const alice = await login(app, 'alice@example.com')
    expect((await alice.raw('POST', '/api/wikis', { name: 'x' }, { 'x-requested-with': '' })).status).toBe(403)
    expect((await alice.raw('POST', '/api/wikis', { name: 'x' }, { origin: 'https://evil.example' })).status).toBe(403)
  })
})

describe('pages: save conflicts, rename, hierarchy', () => {
  let app: App
  beforeEach(() => {
    app = setup().app
  })

  it('detects conflicting saves and returns both versions', async () => {
    const a = await login(app, 'a@example.com')
    const w = (await a.post('/api/wikis', { name: 'W' })).json.wiki
    await a.post(`/api/wikis/${w.id}/invitations`, { email: 'b@example.com', role: 'editor' })
    const b = await login(app, 'b@example.com')
    const p = (await a.post(`/api/wikis/${w.id}/pages`, { name: 'P', content: 'base\n' })).json.page
    expect((await a.put(`/api/wikis/${w.id}/pages/${p.id}`, { content: 'base\nA\n', baseVersion: 1 })).json.page.version).toBe(2)
    const r = await b.put(`/api/wikis/${w.id}/pages/${p.id}`, { content: 'base\nB\n', baseVersion: 1 })
    expect(r.status).toBe(409)
    expect(r.json.current.content).toBe('base\nA\n')
    expect(r.json.current.version).toBe(2)
    expect(r.json.base).toBe('base\n')
    // Nothing was overwritten.
    expect((await a.get(`/api/wikis/${w.id}/pages/${p.id}`)).json.page.content).toBe('base\nA\n')
    // Resolving against the current version succeeds.
    expect((await b.put(`/api/wikis/${w.id}/pages/${p.id}`, { content: 'base\nA\nB\n', baseVersion: 2 })).status).toBe(200)
  })

  it('wiki slug: unique, usable in place of the id, old slugs keep resolving', async () => {
    const a = await login(app, 'a@example.com')
    const out = await login(app, 'out@example.com')
    const w = (await a.post('/api/wikis', { name: 'W', slug: 'Team-Notes' })).json.wiki
    expect(w.slug).toBe('team-notes')
    expect((await a.post('/api/wikis', { name: 'X', slug: 'team-notes' })).status).toBe(409)
    expect((await a.post('/api/wikis', { name: 'X', slug: 'bad_slug' })).status).toBe(400)
    expect((await a.post('/api/wikis', { name: 'X' })).json.wiki.slug).toMatch(/^w-[0-9a-f]{8}$/)
    expect((await a.get('/api/wikis/team-notes')).json.wiki.id).toBe(w.id)
    expect((await a.post('/api/wikis/team-notes/pages', { name: 'P' })).status).toBe(201)
    // Outsiders can't tell an existing slug from a missing one.
    expect((await out.get('/api/wikis/team-notes')).status).toBe(404)
    expect((await out.get('/api/wikis/nothing-here')).status).toBe(404)
    // Rename: old slug still resolves, and can't be taken by another wiki.
    expect((await a.patch('/api/wikis/team-notes', { slug: 'notes' })).status).toBe(200)
    expect((await a.get('/api/wikis/team-notes')).json.wiki.slug).toBe('notes')
    expect((await out.post('/api/wikis', { name: 'Y', slug: 'team-notes' })).status).toBe(409)
    // A rejected PATCH changes nothing.
    expect((await a.patch(`/api/wikis/${w.id}`, { slug: 'n2', name: '' })).status).toBe(400)
    expect((await a.get(`/api/wikis/${w.id}`)).json.wiki.slug).toBe('notes')
    // Taking back a former slug works.
    expect((await a.patch(`/api/wikis/${w.id}`, { slug: 'team-notes' })).status).toBe(200)
    expect((await a.get('/api/wikis/notes')).json.wiki.slug).toBe('team-notes')
  })

  it('top page: owner sets it by id, survives rename, cleared on delete', async () => {
    const a = await login(app, 'a@example.com')
    const w = (await a.post('/api/wikis', { name: 'W' })).json.wiki
    await a.post(`/api/wikis/${w.id}/invitations`, { email: 'b@example.com', role: 'editor' })
    const b = await login(app, 'b@example.com')
    const p = (await a.post(`/api/wikis/${w.id}/pages`, { name: 'Home' })).json.page
    expect((await a.get(`/api/wikis/${w.id}`)).json.wiki.topPageId).toBeNull()
    expect((await b.patch(`/api/wikis/${w.id}`, { topPageId: p.id })).status).toBe(403)
    expect((await a.patch(`/api/wikis/${w.id}`, { topPageId: 'nope' })).status).toBe(404)
    expect((await a.patch(`/api/wikis/${w.id}`, { topPageId: p.id })).status).toBe(200)
    expect((await a.get(`/api/wikis/${w.id}`)).json.wiki).toMatchObject({ name: 'W', topPageId: p.id, topPage: 'Home' })
    await a.post(`/api/wikis/${w.id}/pages/${p.id}/rename`, { name: 'トップ' })
    expect((await b.get(`/api/wikis/${w.id}`)).json.wiki.topPage).toBe('トップ')
    await a.del(`/api/wikis/${w.id}/pages/${p.id}`)
    expect((await a.get(`/api/wikis/${w.id}`)).json.wiki.topPageId).toBeNull()
  })

  it('page names distinguish case and full/half width (also for children and rename)', async () => {
    const a = await login(app, 'a@example.com')
    const w = (await a.post('/api/wikis', { name: 'W' })).json.wiki
    const mk = async (name: string) => (await a.post(`/api/wikis/${w.id}/pages`, { name, content: name })).json.page
    const upper = await mk('LISA')
    for (const n of ['LiSA', 'ＬｉＳＡ', 'LISA/曲', 'lisa/曲', 'ＬＩＳＡ/曲']) expect((await mk(n)).name).toBe(n)
    for (const n of ['LISA', 'LiSA', 'ＬｉＳＡ']) {
      const r = await a.get(`/api/wikis/${w.id}/resolve?name=${encodeURIComponent(n)}`)
      expect(r.json.page.content).toBe(n)
    }
    // Children of a page that doesn't exist: only exact-prefix matches.
    const r = await a.get(`/api/wikis/${w.id}/resolve?name=lisa`)
    expect(r.status).toBe(404)
    expect(r.json.children.map((c: any) => c.name)).toEqual(['lisa/曲'])
    // Renaming LISA with its children leaves lisa/… and ＬＩＳＡ/… alone.
    await a.post(`/api/wikis/${w.id}/pages/${upper.id}/rename`, { name: 'LISA2', includeChildren: true })
    const names = (await a.get(`/api/wikis/${w.id}/pages`)).json.pages.map((p: any) => p.name).sort()
    expect(names).toEqual(['LISA2', 'LISA2/曲', 'LiSA', 'lisa/曲', 'ＬＩＳＡ/曲', 'ＬｉＳＡ'].sort())
  })

  it('creates child pages without a parent page and resolves names', async () => {
    const a = await login(app, 'a@example.com')
    const w = (await a.post('/api/wikis', { name: 'W' })).json.wiki
    expect((await a.post(`/api/wikis/${w.id}/pages`, { name: ' 開発 / API / 認証 ' })).json.page.name).toBe('開発/API/認証')
    const r = await a.get(`/api/wikis/${w.id}/resolve?name=${encodeURIComponent('開発')}`)
    expect(r.status).toBe(404)
    expect(r.json.children.map((c: any) => c.name)).toEqual(['開発/API/認証'])
    expect((await a.get(`/api/wikis/${w.id}/pages?q=API`)).json.pages.map((x: any) => x.name)).toEqual(['開発/API/認証'])
    expect((await a.post(`/api/wikis/${w.id}/pages`, { name: '開発/API/認証' })).status).toBe(409)
  })

  it('rename keeps old links working via aliases and can rewrite links', async () => {
    const a = await login(app, 'a@example.com')
    const w = (await a.post('/api/wikis', { name: 'W' })).json.wiki
    const api = (await a.post(`/api/wikis/${w.id}/pages`, { name: '開発/API', content: 'api' })).json.page
    await a.post(`/api/wikis/${w.id}/pages`, { name: '開発/API/認証', content: 'auth' })
    const linker = (await a.post(`/api/wikis/${w.id}/pages`, { name: 'Home', content: 'see [[開発/API/認証]] and `[[開発/API]]`' })).json.page

    const r = await a.post(`/api/wikis/${w.id}/pages/${api.id}/rename`, { name: '設計/API', includeChildren: true, rewriteLinks: false })
    expect(r.status).toBe(200)
    expect(r.json.renamed).toEqual([
      { from: '開発/API', to: '設計/API' },
      { from: '開発/API/認証', to: '設計/API/認証' },
    ])
    // Old names resolve through aliases.
    const res = await a.get(`/api/wikis/${w.id}/resolve?name=${encodeURIComponent('開発/API/認証')}`)
    expect(res.json.via).toBe('alias')
    expect(res.json.page.name).toBe('設計/API/認証')

    // Rename again with link rewriting.
    const r2 = await a.post(`/api/wikis/${w.id}/pages/${api.id}/rename`, { name: '仕様/API', rewriteLinks: true })
    expect(r2.json.rewritten).toBe(0) // Home links to 開発/... which is an alias, not the current name
    await a.put(`/api/wikis/${w.id}/pages/${linker.id}`, { content: 'see [[仕様/API/認証]] and `[[仕様/API]]`', baseVersion: 1 })
    const r4 = await a.post(`/api/wikis/${w.id}/pages/${api.id}/rename`, { name: 'Spec/API', rewriteLinks: true })
    expect(r4.json.rewritten).toBe(1)
    const home = (await a.get(`/api/wikis/${w.id}/pages/${linker.id}`)).json.page
    expect(home.content).toBe('see [[Spec/API/認証]] and `[[仕様/API]]`')
    // Every historical name still resolves.
    for (const n of ['開発/API/認証', '設計/API/認証', '仕様/API/認証']) {
      expect((await a.get(`/api/wikis/${w.id}/resolve?name=${encodeURIComponent(n)}`)).json.page.name).toBe('Spec/API/認証')
    }
  })
})

describe('Google OAuth callback', () => {
  it('logs in with a verified Google identity (token endpoint mocked)', async () => {
    const clientId = 'cid.apps.googleusercontent.com'
    let nonce = ''
    const fetchImpl = (async (_url: string, init: any) => {
      expect(String(init.body)).toContain('code_verifier=')
      const payload = { iss: 'https://accounts.google.com', aud: clientId, sub: 'g-123', email: 'G@Example.com', email_verified: true, name: 'G', exp: Date.now() / 1000 + 60, nonce }
      const jwt = `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
      return new Response(JSON.stringify({ id_token: jwt }), { status: 200 })
    }) as unknown as typeof fetch
    const { app } = setup({ google: { clientId, clientSecret: 's' }, devLogin: false, fetchImpl })
    expect((await app.request('/auth/dev-login?email=a@b.c')).status).toBe(404)
    const start = await app.request('/auth/google?returnTo=/w/x')
    const loc = new URL(start.headers.get('location')!)
    expect(loc.host).toBe('accounts.google.com')
    expect(loc.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/google/callback`)
    nonce = loc.searchParams.get('nonce')!
    const oauthCookie = start.headers.get('set-cookie')!.split(';')[0]
    const bad = await app.request(`/auth/google/callback?code=c&state=wrong`, { headers: { cookie: oauthCookie } })
    expect(bad.status).toBe(400)
    const cb = await app.request(`/auth/google/callback?code=c&state=${loc.searchParams.get('state')}`, { headers: { cookie: oauthCookie } })
    expect(cb.status).toBe(302)
    expect(cb.headers.get('location')).toBe('/w/x')
    const session = cb.headers.getSetCookie().find((c) => c.startsWith('mw_session='))!.split(';')[0]
    const me = await app.request('/api/me', { headers: { cookie: session } })
    expect((await me.json()).user.email).toBe('g@example.com')
  })
})
