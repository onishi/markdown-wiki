import { describe, it, expect } from 'vitest'
import { applyHunks, charDiff, diffHunks } from '../shared/diff'
import { buildPrompt } from '../server/ai'
import { openDb } from '../server/db-node'
import { createApp } from '../server/app'
import type { Reviser, ReviseRequest } from '../server/ai'

describe('hunks', () => {
  const a = 'title\nkeep\nold one\nkeep2\nold two'
  const b = 'title\nkeep\nnew one\nkeep2\nnew two\nadded'
  it('splits changes and applies any subset', () => {
    const segs = diffHunks(a, b)
    const ids = segs.flatMap((s) => ('id' in s ? [s.id] : []))
    expect(ids).toEqual([0, 1])
    expect(applyHunks(segs, new Set(ids))).toBe(b)
    expect(applyHunks(segs, new Set())).toBe(a)
    expect(applyHunks(segs, new Set([0]))).toBe('title\nkeep\nnew one\nkeep2\nold two')
    expect(applyHunks(segs, new Set([1]))).toBe('title\nkeep\nold one\nkeep2\nnew two\nadded')
  })
  it('highlights the changed characters inside a line', () => {
    const d = charDiff('今日はデプロイする', '明日はデプロイする')
    expect(d.del).toEqual([{ text: '今', changed: true }, { text: '日はデプロイする', changed: false }])
    expect(d.add[0]).toEqual({ text: '明', changed: true })
  })
})

describe('prompt', () => {
  it('sends the whole page as context only when the target is a part', () => {
    const page = '# A\n\npara one\n\npara two'
    const part = buildPrompt({ wikiName: 'W', pageName: 'P', page, start: 5, end: 13, preset: 'typo', instruction: ' 敬体に ' })
    expect(part).toContain('<page>\n' + page)
    expect(part).toContain('<target>\npara one\n</target>')
    expect(part).toContain('追加の指示: 敬体に')
    const whole = buildPrompt({ wikiName: 'W', pageName: 'P', page, start: 0, end: page.length, preset: 'auto', instruction: '' })
    expect(whole).not.toContain('<page>')
    expect(whole).not.toContain('追加の指示')
    expect(whole).not.toContain('分量')
    const short = buildPrompt({ wikiName: 'W', pageName: 'P', page, start: 0, end: page.length, preset: 'auto', volume: 'short', instruction: '' })
    expect(short).toContain('分量: 対象のおよそ半分')
    expect(whole).toContain('- ページタイトル: P\n')
    expect(whole).not.toContain('- 階層')
    const deep = buildPrompt({ wikiName: 'W', pageName: '開発/API/認証', page, start: 0, end: page.length, preset: 'auto', instruction: '' })
    expect(deep).toContain('- 階層: 「開発」 > 「API」 > 「認証」（「開発/API」の下にある「認証」のページ）')
    expect(deep).toContain('主題は「認証」')
  })
})

describe('AI revise API', () => {
  async function setup(ai?: Reviser) {
    const app = createApp(openDb(':memory:'), { appOrigin: 'http://localhost:5173', devLogin: true, secureCookies: false, ai })
    const login = async (email: string) => {
      const res = await app.request(`/auth/dev-login?email=${encodeURIComponent(email)}`)
      const cookie = res.headers.get('set-cookie')!.split(';')[0]
      return async (method: string, path: string, body?: unknown) => {
        const r = await app.request(path, {
          method,
          headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'markdown-wiki' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        return { status: r.status, json: (await r.json().catch(() => null)) as any }
      }
    }
    return { login }
  }

  it('is opt-in per wiki, editor-only, and returns the revised target', async () => {
    const seen: ReviseRequest[] = []
    const { login } = await setup(async (r) => (seen.push(r), { revised: r.page.slice(r.start, r.end).toUpperCase() + '\n\n', summary: '大文字に' }))
    const owner = await login('o@example.com')
    const w = (await owner('POST', '/api/wikis', { name: 'W' })).json.wiki
    const p = (await owner('POST', `/api/wikis/${w.id}/pages`, { name: 'P', content: 'abc\n\ndef' })).json.page
    const url = `/api/wikis/${w.id}/pages/${p.id}/ai/revise`
    expect((await owner('GET', `/api/wikis/${w.id}`)).json.wiki).toMatchObject({ aiEnabled: false, aiAvailable: true })
    expect((await owner('POST', url, { content: 'abc\n\ndef' })).status).toBe(403)

    await owner('PATCH', `/api/wikis/${w.id}`, { aiEnabled: true })
    expect((await owner('GET', `/api/wikis/${w.id}`)).json.wiki.aiEnabled).toBe(true)
    // unsaved text from the client is what gets revised; trailing newlines follow the target
    const r = await owner('POST', url, { content: 'abc\n\nxyz', start: 5, end: 8, preset: 'typo', volume: 'auto', instruction: 'x' })
    expect(r.json).toMatchObject({ revised: 'XYZ', summary: '大文字に' })
    expect(seen[0]).toMatchObject({ wikiName: 'W', pageName: 'P', start: 5, end: 8, preset: 'typo', volume: 'auto', instruction: 'x' })

    expect((await owner('POST', url, { content: 'abc', start: 2, end: 9 })).status).toBe(400)
    expect((await owner('POST', url, { content: 'abc', preset: 'nope' })).status).toBe(400)
    expect((await owner('POST', url, { content: 'abc', volume: 'huge' })).json).toEqual({ error: 'invalid_volume' })

    await owner('POST', `/api/wikis/${w.id}/invitations`, { email: 'v@example.com', role: 'viewer' })
    const viewer = await login('v@example.com')
    expect((await viewer('POST', url, { content: 'abc' })).status).toBe(403)
    // only the owner toggles it
    await owner('POST', `/api/wikis/${w.id}/invitations`, { email: 'e@example.com', role: 'editor' })
    const editor = await login('e@example.com')
    expect((await editor('PATCH', `/api/wikis/${w.id}`, { aiEnabled: false })).status).toBe(403)
  })

  it('reports when no API key is configured and when the model fails', async () => {
    const none = await setup()
    const o = await none.login('o@example.com')
    const w = (await o('POST', '/api/wikis', { name: 'W' })).json.wiki
    const p = (await o('POST', `/api/wikis/${w.id}/pages`, { name: 'P', content: 'abc' })).json.page
    expect((await o('GET', `/api/wikis/${w.id}`)).json.wiki.aiAvailable).toBe(false)
    expect((await o('POST', `/api/wikis/${w.id}/pages/${p.id}/ai/revise`, { content: 'abc' })).status).toBe(503)

    const failing = await setup(async () => {
      throw new Error('boom')
    })
    const f = await failing.login('o@example.com')
    const w2 = (await f('POST', '/api/wikis', { name: 'W' })).json.wiki
    const p2 = (await f('POST', `/api/wikis/${w2.id}/pages`, { name: 'P', content: 'abc' })).json.page
    await f('PATCH', `/api/wikis/${w2.id}`, { aiEnabled: true })
    expect((await f('POST', `/api/wikis/${w2.id}/pages/${p2.id}/ai/revise`, { content: 'abc' })).status).toBe(502)
  })
})
