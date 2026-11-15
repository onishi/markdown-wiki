import { describe, it, expect } from 'vitest'
import { applyHunks, charDiff, diffHunks } from '../shared/diff'
import { buildPrompt, parseTagged } from '../server/ai'
import { reviewSegments, withSources } from '../src/wiki/AiDialog'
import { openDb } from '../server/db-node'
import { createApp } from '../server/app'
import type { Reviser, ReviseRequest } from '../server/ai'

describe('hunks', () => {
  it('treats an empty text as no lines', () => {
    const segs = diffHunks('', '## A\n\nb')
    expect(segs).toEqual([{ id: 0, del: [], add: ['## A', '', 'b'] }])
    expect(applyHunks(segs, new Set())).toBe('')
    expect(applyHunks(segs, new Set([0]))).toBe('## A\n\nb')
  })

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
    const blank = buildPrompt({ wikiName: 'W', pageName: 'P', page: '', start: 0, end: 0, preset: 'auto', instruction: '' })
    expect(blank).toContain('ページは空です')
    expect(blank).toContain('<target>\n</target>')
    expect(whole).not.toContain('ページは空です')
  })
})

describe('web mode', () => {
  it('parses the tagged answer', () => {
    expect(parseTagged('前置き\n<summary> 埋めた </summary>\n<revised>\n# A\n\nB\n</revised>')).toEqual({ revised: '# A\n\nB', summary: '埋めた' })
    expect(() => parseTagged('{"revised": "x"}')).toThrow('bad_response')
  })
  it('appends sources only when something changed', () => {
    const src = [{ uri: 'https://e.com/a (b)', title: 'E [x]' }, { uri: 'https://f.org/' }]
    expect(withSources('a\n', 'a\n', src)).toBe('a\n')
    expect(withSources('a\n', 'b\n', [])).toBe('b\n')
    expect(withSources('a\n', 'b\n', src)).toBe('b\n\n出典:\n\n- [E x](https://e.com/a%20%28b%29)\n- [f.org](https://f.org/)\n')
  })
})

describe('review segments', () => {
  it('puts the sources in a hunk of their own', () => {
    const target = 'teh first\n\nsecond\n'
    const revised = 'the first\n\nsecond\n\n（追記）\n'
    const segs = reviewSegments(target, revised, [{ uri: 'https://e.com/', title: 'E' }])
    const hunks = segs.filter((s) => 'id' in s) as { id: number; add: string[] }[]
    expect(hunks.map((h) => h.add)).toEqual([['the first'], ['', '（追記）'], ['', '出典:', '', '- [E](https://e.com/)']])
    expect(applyHunks(segs, new Set([0, 1]))).toBe(revised)
    expect(applyHunks(segs, new Set([2]))).toBe('teh first\n\nsecond\n\n出典:\n\n- [E](https://e.com/)\n')
    expect(applyHunks(segs, new Set([0, 1, 2]))).toBe(withSources(target, revised, [{ uri: 'https://e.com/', title: 'E' }]))
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
    expect((await owner('POST', url, { content: 'abc', start: 1, end: 1 })).status).toBe(400) // empty range in a non-empty page
    // an empty page: write from the title
    expect((await owner('POST', url, { content: '' })).status).toBe(200)
    expect(seen[seen.length - 1]).toMatchObject({ page: '', start: 0, end: 0 })
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

  it('streams the answer as NDJSON when asked', async () => {
    let fail = false
    const app = createApp(openDb(':memory:'), {
      appOrigin: 'http://localhost:5173',
      devLogin: true,
      secureCookies: false,
      ai: async (r, onText) => {
        onText?.('<summary>s</summary>\n<revised>\nAB')
        await new Promise((res) => setTimeout(res, 200))
        if (fail) throw new Error('boom')
        onText?.('<summary>s</summary>\n<revised>\nABC\n</revised>')
        return { revised: 'ABC', summary: 's' }
      },
    })
    const res = await app.request('/auth/dev-login?email=o@example.com')
    const headers = { cookie: res.headers.get('set-cookie')!.split(';')[0], 'content-type': 'application/json', 'x-requested-with': 'markdown-wiki' }
    const call = (path: string, body: unknown) => app.request(path, { method: 'POST', headers, body: JSON.stringify(body) })
    const w = (await (await call('/api/wikis', { name: 'W' })).json()).wiki
    const p = (await (await call(`/api/wikis/${w.id}/pages`, { name: 'P', content: 'abc\n' })).json()).page
    await app.request(`/api/wikis/${w.id}`, { method: 'PATCH', headers, body: JSON.stringify({ aiEnabled: true }) })
    const url = `/api/wikis/${w.id}/pages/${p.id}/ai/revise`
    const read = async (r: Response) => (await r.text()).trim().split('\n').map((l) => JSON.parse(l))
    const ok = await call(url, { content: 'abc\n', stream: true })
    expect(ok.headers.get('content-type')).toContain('application/x-ndjson')
    const lines = await read(ok)
    expect(lines[0]).toEqual({ text: '<summary>s</summary>\n<revised>\nAB' })
    expect(lines.at(-2)).toEqual({ text: '<summary>s</summary>\n<revised>\nABC\n</revised>' })
    expect(lines.at(-1)).toEqual({ done: { revised: 'ABC\n', summary: 's', sources: [], related: [], remaining: 99 } })
    fail = true
    expect((await read(await call(url, { content: 'abc\n', stream: true }))).at(-1)).toEqual({ error: 'ai_failed' })
    // validation errors still come as plain JSON
    expect((await call(url, { content: 'abc', start: 2, end: 9, stream: true })).status).toBe(400)
  })

  it('sends linked, parent and linking pages as background when asked', async () => {
    const seen: ReviseRequest[] = []
    const { login } = await setup(async (r) => (seen.push(r), { revised: 'x', summary: '' }))
    const o = await login('o@example.com')
    const w = (await o('POST', '/api/wikis', { name: 'W' })).json.wiki
    await o('PATCH', `/api/wikis/${w.id}`, { aiEnabled: true })
    const mk = async (name: string, content: string) => (await o('POST', `/api/wikis/${w.id}/pages`, { name, content })).json.page
    await mk('開発', '開発の親ページ')
    await mk('用語集', 'トークン: 1 時間で失効')
    const old = await mk('旧名', 'リネームされる')
    await o('POST', `/api/wikis/${w.id}/pages/${old.id}/rename`, { name: '新名' })
    await mk('空', '')
    const p = await mk('開発/認証', 'see [[用語集]] [[旧名]] [[空]] [[ない]]')
    await mk('索引', '- [[開発/認証]]')
    await mk('無関係', 'nothing')
    const url = `/api/wikis/${w.id}/pages/${p.id}/ai/revise`
    // links are taken from the client's (possibly unsaved) text
    const r = await o('POST', url, { content: 'see [[用語集]] [[旧名]] [[空]] [[ない]] [[開発/認証]]', wiki: true })
    expect(r.json.related).toEqual(['用語集', '新名', '開発', '索引'])
    expect(seen[0].related!.map((x) => [x.name, x.relation])).toEqual([
      ['用語集', 'このページからのリンク先'],
      ['新名', 'このページからのリンク先'],
      ['開発', '親ページ'],
      ['索引', 'このページへリンクしているページ'],
    ])
    const prompt = buildPrompt(seen[0])
    expect(prompt).toContain('【wiki 内の関連ページ】')
    expect(prompt).toContain('<related name="用語集" relation="このページからのリンク先">\nトークン: 1 時間で失効\n</related>')
    // off unless asked
    expect((await o('POST', url, { content: 'see [[用語集]]' })).json.related).toEqual([])
    expect(buildPrompt(seen[1])).not.toContain('関連ページ】')
  })

  it('links: offers pages named in the text, and drops links to pages that do not exist', async () => {
    const seen: ReviseRequest[] = []
    let answer = ''
    const { login } = await setup(async (r) => (seen.push(r), { revised: answer, summary: '' }))
    const o = await login('o@example.com')
    const w = (await o('POST', '/api/wikis', { name: 'W' })).json.wiki
    await o('PATCH', `/api/wikis/${w.id}`, { aiEnabled: true })
    const mk = async (name: string) => (await o('POST', `/api/wikis/${w.id}/pages`, { name, content: '' })).json.page
    await mk('開発/API')
    await mk('用語集')
    await mk('デプロイ手順')
    await mk('X') // too short to match
    const old = await mk('旧ページ')
    await o('POST', `/api/wikis/${w.id}/pages/${old.id}/rename`, { name: '新ページ' })
    const p = await mk('メモ')
    const url = `/api/wikis/${w.id}/pages/${p.id}/ai/revise`
    const text = 'API の説明は用語集を見る。メモ。X。`デプロイ手順` [[開発/API]]'
    answer = '[[開発/API|API]] の説明は [[用語集]] を見る。[[架空]]と[[旧ページ]]。'
    const r = await o('POST', url, { content: text, preset: 'links' })
    // only the names found outside code and existing links; not this page itself
    expect(seen[0].linkCandidates).toEqual([{ name: '用語集', words: ['用語集'] }])
    // only links are taken from the answer, onto the original text; made-up targets are dropped
    expect(r.json.revised).toBe('API の説明は[[用語集]]を見る。メモ。X。`デプロイ手順` [[開発/API]]')
    // each link is listed for adopting one by one
    expect(r.json.links).toEqual([{ target: '用語集', label: '用語集', at: 8, exists: true }])
    expect(buildPrompt(seen[0])).toContain('【リンクにできるページ】（wiki に実在するページ。本文中に名前が出てくるもの）\n- 用語集\n')

    const r2 = await o('POST', url, { content: '開発の API について', preset: 'links' })
    expect(seen[1].linkCandidates).toEqual([{ name: '開発/API', words: ['API'] }])
    expect(buildPrompt(seen[1])).toContain('- 開発/API（本文中の表記: 「API」）')
    expect(r2.json.remaining).toBe(98)
    expect(r2.json.revised).toBe('開発の [[開発/API|API]] について')
    // nothing to link: answered without the model
    const none = await o('POST', url, { content: 'なにもない', preset: 'links' })
    expect(none.json).toMatchObject({ revised: 'なにもない', remaining: null })
    expect(seen).toHaveLength(2)
  })

  it('keywords: links key terms, including pages that do not exist yet, one by one', async () => {
    let answer = ''
    const seen: ReviseRequest[] = []
    const { login } = await setup(async (r) => (seen.push(r), { revised: answer, summary: '' }))
    const o = await login('o@example.com')
    const w = (await o('POST', '/api/wikis', { name: 'W' })).json.wiki
    await o('PATCH', `/api/wikis/${w.id}`, { aiEnabled: true })
    await o('POST', `/api/wikis/${w.id}/pages`, { name: '開発/API', content: '' })
    const p = (await o('POST', `/api/wikis/${w.id}/pages`, { name: 'メモ', content: '' })).json.page
    const url = `/api/wikis/${w.id}/pages/${p.id}/ai/revise`
    const text = 'Kubernetes で API を公開する。Kubernetes は便利。'
    // spaces added, a renamed target, an invalid name, a word not in the text
    answer = '[[Kubernetes]] で [[開発/API|API]] を公開する。[[Kubernetes]] は[[a|b|便利]]。[[架空の語]]'
    const r = await o('POST', url, { content: text, preset: 'keywords', web: true })
    expect(seen[0]).toMatchObject({ web: false, linkCandidates: [{ name: '開発/API', words: ['API'] }] })
    expect(r.json.links).toEqual([
      { target: 'Kubernetes', label: 'Kubernetes', at: 0, exists: false },
      { target: '開発/API', label: 'API', at: 13, exists: true },
    ])
    expect(r.json.revised).toBe('[[Kubernetes]] で [[開発/API|API]] を公開する。Kubernetes は便利。')
    // no existing page named in the text: the model is still asked
    answer = '[[Docker]] を使う'
    const r2 = await o('POST', url, { content: 'Docker を使う', preset: 'keywords' })
    expect(r2.json.links).toEqual([{ target: 'Docker', label: 'Docker', at: 0, exists: false }])
    expect(seen).toHaveLength(2)
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

describe('streamed answer', () => {
  it('shows what has arrived of a partial answer', async () => {
    const { partialAnswer } = await import('../src/wiki/AiDialog')
    expect(partialAnswer('<summ')).toEqual({ summary: '', revised: '' })
    expect(partialAnswer('<summary>直し')).toEqual({ summary: '直し', revised: '' })
    expect(partialAnswer('<summary>直した</summary>\n<revised>\n# A\n\nb</rev')).toEqual({ summary: '直した', revised: '# A\n\nb' })
    expect(partialAnswer('<summary>x</summary><revised>\nAB\n</revised>')).toEqual({ summary: 'x', revised: 'AB\n' })
  })
})
