import { test, expect, type Page, type Browser } from '@playwright/test'

let seq = 0
const uniq = (p: string) => `${p}${Date.now().toString(36)}${seq++}@example.com`

async function login(browser: Browser, email: string) {
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await ctx.newPage()
  await page.goto(`/auth/dev-login?email=${encodeURIComponent(email)}&returnTo=/`)
  await expect(page.getByRole('heading', { name: 'Markdown Wiki' })).toBeVisible()
  return page
}

async function apiCall(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json', 'x-requested-with': 'markdown-wiki' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: r.status, json: await r.json().catch(() => null) }
    },
    { method, path, body },
  )
}

async function createWiki(page: Page, name: string) {
  await page.getByTestId('new-wiki-name').fill(name)
  await page.getByRole('button', { name: 'wiki を作成' }).click()
  await expect(page.locator('.wiki-switch')).toHaveValue(/.+/)
  return page.url().split('/w/')[1].split('/')[0]
}

async function newPage(page: Page, name: string) {
  await page.getByTestId('new-page').click()
  await page.getByTestId('new-page-name').fill(name)
  await page.getByRole('button', { name: '作成', exact: true }).click()
  await expect(page.locator('.page-title')).toHaveText(name.split('/').pop()!)
}

/** Enter edit mode on an empty page / at the caret, replace the unit text, leave. */
async function writeBody(page: Page, text: string) {
  await page.getByTestId('doc').click()
  await page.keyboard.press('Enter')
  const ta = page.locator('[data-testid=src-editor] textarea')
  await expect(ta).toBeFocused()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(text)
  await page.keyboard.press('Escape')
}

const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved', { timeout: 10000 })

test('create wiki and pages, autosave, wiki links, hierarchy, rename', async ({ browser }) => {
  const page = await login(browser, uniq('alice'))
  const wid = await createWiki(page, 'チーム wiki')
  await newPage(page, 'Home')
  await expect(page.locator('.placeholder')).toBeVisible()
  await writeBody(page, '# ようこそ\n\n詳細は [[開発/API/認証]] を参照。\n\n- a\n  - b\n')
  await saved(page)
  await expect(page.locator('a.wikilink.missing')).toHaveText('開発/API/認証')

  // persisted
  await page.reload()
  await expect(page.locator('[data-testid=doc] h1')).toHaveText('ようこそ')

  // line permalink inside the wiki
  await page.goto(page.url().split('#')[0] + '#L3')
  await expect.poll(() => page.evaluate(() => getSelection()!.toString())).toBe('詳細は 開発/API/認証 を参照。')

  // sidebar outline tab
  await page.getByTestId('tab-outline').click()
  await expect(page.getByTestId('outline').locator('button')).toHaveText(['ようこそ'])
  await page.getByRole('tab', { name: 'ページ' }).click()

  // follow a link to a missing page with one click, then create it
  await page.locator('a.wikilink').click()
  await expect(page.getByText('このページはまだ作成されていません。')).toBeVisible()
  await page.getByTestId('create-missing').click()
  await expect(page.locator('.page-title')).toHaveText('認証')
  await writeBody(page, '認証の説明')
  await saved(page)

  // hierarchy: parents exist only as virtual folders
  await expect(page.locator('.tree a.virtual', { hasText: '開発' })).toBeVisible()
  await expect(page.locator('.tree a.virtual', { hasText: 'API' })).toBeVisible()
  await page.locator('.tree a.virtual', { hasText: 'API' }).click()
  await expect(page.getByText('このページはまだ作成されていません。')).toBeVisible()
  await expect(page.locator('.children a')).toHaveText('認証')

  // search by page name
  await page.getByTestId('search').fill('認証')
  await expect(page.locator('.tree .tree-row a')).toHaveText(['開発', 'API', '認証'])
  await page.getByTestId('search').fill('')

  // the Home link is no longer "missing"
  await page.goto(`/w/${wid}/p/Home`)
  await expect(page.locator('a.wikilink')).not.toHaveClass(/missing/)

  // rename without rewriting links: the old link keeps working through an alias
  await page.goto(`/w/${wid}/p/${encodeURI('開発/API/認証')}`)
  await page.getByTestId('page-menu').click()
  await page.getByTestId('rename').click()
  await page.getByTestId('rename-input').fill('設計/認証')
  await page.getByLabel(/を新しい名前に書き換える/).uncheck()
  await page.getByRole('button', { name: '変更', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(encodeURI('設計/認証').replace(/[/]/g, '\\/') + '$'))
  await page.goto(`/w/${wid}/p/Home`)
  await expect(page.locator('a.wikilink')).not.toHaveClass(/missing/)
  await page.locator('a.wikilink').click()
  await expect(page.locator('.page-title')).toHaveText('認証')
  await expect(page.getByText('「開発/API/認証」は「設計/認証」に名前が変わりました。')).toBeVisible()
  await expect(page.locator('[data-testid=doc]')).toContainText('認証の説明')
  await page.context().close()
})

test('permissions: outsiders blocked, viewers read and copy only', async ({ browser }) => {
  const owner = await login(browser, uniq('owner'))
  const wid = await createWiki(owner, 'Private')
  await newPage(owner, 'Secret')
  await writeBody(owner, '**秘密**の内容')
  await saved(owner)
  const pid = (await apiCall(owner, 'GET', `/api/wikis/${wid}/pages`)).json.pages[0].id

  const viewerEmail = uniq('viewer')
  const viewer = await login(browser, viewerEmail)
  await viewer.goto(`/w/${wid}/p/Secret`)
  await expect(viewer.getByText('この wiki は存在しないか、アクセス権がありません。')).toBeVisible()
  expect((await apiCall(viewer, 'GET', `/api/wikis/${wid}/pages/${pid}`)).status).toBe(404)
  expect((await apiCall(viewer, 'PUT', `/api/wikis/${wid}/pages/${pid}`, { content: 'x', baseVersion: 1 })).status).toBe(404)

  // invite as viewer (owner UI)
  await owner.goto(`/w/${wid}/settings`)
  await owner.getByTestId('invite-email').fill(viewerEmail)
  await owner.getByTestId('invite-role').selectOption('viewer')
  await owner.getByRole('button', { name: '招待' }).click()
  await expect(owner.getByText('招待中')).toBeVisible()

  await viewer.goto(`/w/${wid}/p/Secret`)
  await expect(viewer.locator('[data-testid=doc] strong')).toHaveText('秘密')
  await expect(viewer.getByTestId('new-page')).toHaveCount(0)
  await viewer.locator('[data-testid=doc] strong').click()
  await viewer.keyboard.press('Enter')
  await expect(viewer.getByTestId('src-editor')).toHaveCount(0)
  await expect(viewer.getByTestId('mode-bar')).toContainText('閲覧者のため編集できません')
  expect((await apiCall(viewer, 'PUT', `/api/wikis/${wid}/pages/${pid}`, { content: 'x', baseVersion: 1 })).status).toBe(403)
  expect((await apiCall(viewer, 'DELETE', `/api/wikis/${wid}/pages/${pid}`)).status).toBe(403)
  // copy is allowed
  await viewer.keyboard.press('ControlOrMeta+a')
  await viewer.keyboard.press('ControlOrMeta+c')
  const text = await viewer.evaluate(() => navigator.clipboard.readText())
  expect(text).toBe('秘密の内容')
  await owner.context().close()
  await viewer.context().close()
})

test('save failure keeps the text and can be retried', async ({ browser }) => {
  const page = await login(browser, uniq('saver'))
  const wid = await createWiki(page, 'Saves')
  await newPage(page, 'Doc')
  await page.route('**/api/wikis/*/pages/*', (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 500, body: '{"error":"boom"}' }) : r.continue()))
  await writeBody(page, '失われてはいけない文章')
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'error', { timeout: 10000 })
  await expect(page.locator('[data-testid=doc]')).toContainText('失われてはいけない文章')
  // even a reload keeps it (local draft), and it is offered for saving
  await page.reload()
  await expect(page.locator('[data-testid=doc]')).toContainText('失われてはいけない文章')
  await page.unroute('**/api/wikis/*/pages/*')
  // The draft may already have been re-saved automatically; otherwise retry by hand.
  await page.getByTestId('retry-save').click({ timeout: 3000 }).catch(() => {})
  await saved(page)
  const pages = (await apiCall(page, 'GET', `/api/wikis/${wid}/pages`)).json.pages
  const p = (await apiCall(page, 'GET', `/api/wikis/${wid}/pages/${pages[0].id}`)).json.page
  expect(p.content).toBe('失われてはいけない文章')
  await page.context().close()
})

test('concurrent edits: conflict detected, nothing overwritten, merged', async ({ browser }) => {
  const a = await login(browser, uniq('a'))
  const wid = await createWiki(a, 'Conflicts')
  await newPage(a, 'Shared')
  await writeBody(a, '一行目\n\n二行目\n\n三行目')
  await saved(a)
  const bEmail = uniq('b')
  await apiCall(a, 'POST', `/api/wikis/${wid}/invitations`, { email: bEmail, role: 'editor' })
  const b = await login(browser, bEmail)
  await b.goto(`/w/${wid}/p/Shared`)
  await expect(b.locator('[data-testid=doc]')).toContainText('三行目')

  // B edits the first paragraph and saves
  await b.locator('[data-testid=doc] p', { hasText: '一行目' }).click()
  await b.keyboard.press('Enter')
  await b.keyboard.press('End')
  await b.keyboard.type('（Bが追記）')
  await b.keyboard.press('Escape')
  await saved(b)

  // A (stale) edits the last paragraph
  await a.locator('[data-testid=doc] p', { hasText: '三行目' }).click()
  await a.keyboard.press('Enter')
  await a.keyboard.press('End')
  await a.keyboard.type('（Aが追記）')
  await a.keyboard.press('Escape')
  await expect(a.getByRole('dialog', { name: '編集が競合しました' })).toBeVisible({ timeout: 10000 })
  await expect(a.getByTestId('conflict-mine')).toHaveValue(/Aが追記/)
  await expect(a.getByTestId('conflict-theirs')).toHaveValue(/Bが追記/)
  await expect(a.getByTestId('conflict-result')).toHaveValue('一行目（Bが追記）\n\n二行目\n\n三行目（Aが追記）')
  // B's version on the server was not overwritten
  const pid = (await apiCall(a, 'GET', `/api/wikis/${wid}/pages`)).json.pages[0].id
  expect((await apiCall(a, 'GET', `/api/wikis/${wid}/pages/${pid}`)).json.page.content).toBe('一行目（Bが追記）\n\n二行目\n\n三行目')
  await a.getByTestId('conflict-save').click()
  await saved(a)
  expect((await apiCall(a, 'GET', `/api/wikis/${wid}/pages/${pid}`)).json.page.content).toBe('一行目（Bが追記）\n\n二行目\n\n三行目（Aが追記）')
  await expect(a.locator('[data-testid=doc]')).toContainText('Bが追記')
  await a.context().close()
  await b.context().close()
})

test('top page: wiki URL without a page redirects there; page list stays reachable', async ({ browser }) => {
  const page = await login(browser, uniq('top'))
  const wid = await createWiki(page, 'トップ wiki')
  await newPage(page, 'はじめに')
  await newPage(page, 'メモ')
  await page.goto(`/w/${wid}/settings`)
  await page.getByTestId('top-page').selectOption({ label: 'はじめに' })
  await expect(page.getByText('トップページを変更しました。')).toBeVisible()

  await page.goto(`/w/${wid}`)
  await expect(page).toHaveURL(new RegExp(`/w/${wid}/p/${encodeURIComponent('はじめに')}$`))
  await expect(page.locator('.page-title')).toHaveText('はじめに')
  // Breadcrumb: the top page itself has no root crumb; other pages start from it.
  await expect(page.getByTestId('breadcrumb')).toHaveText('はじめに')
  await page.goto(`/w/${wid}/p/${encodeURIComponent('メモ')}`)
  await expect(page.getByTestId('breadcrumb')).toHaveText('はじめに/メモ')
  await page.getByTestId('breadcrumb').getByRole('link', { name: 'はじめに' }).click()
  await expect(page.locator('.page-title')).toHaveText('はじめに')

  // An empty page name (/w/<slug>/p/) also goes to the top page.
  await page.goto(`/w/${wid}/p/`)
  await expect(page).toHaveURL(new RegExp(`/p/${encodeURIComponent('はじめに')}$`))

  await page.getByRole('link', { name: 'すべてのページ' }).click()
  await expect(page.getByRole('heading', { name: /すべてのページ/ })).toBeVisible()

  // Unset: back to the page list.
  await page.goto(`/w/${wid}/settings`)
  await page.getByTestId('top-page').selectOption('')
  await expect(page.getByText('トップページを変更しました。')).toBeVisible()
  await page.goto(`/w/${wid}`)
  await expect(page.getByRole('heading', { name: /すべてのページ/ })).toBeVisible()
  // Without a top page the root crumb is the wiki name.
  await page.goto(`/w/${wid}/p/${encodeURIComponent('メモ')}`)
  await expect(page.getByTestId('breadcrumb')).toHaveText('トップ wiki/メモ')
})

test('wiki slug: /w/<slug>/p/<page> URLs; changing it keeps old URLs working', async ({ browser }) => {
  const page = await login(browser, uniq('slug'))
  const slug = `team-${Date.now().toString(36)}`
  await page.getByTestId('new-wiki-name').fill('スラッグ wiki')
  await page.getByTestId('new-wiki-slug').fill(slug)
  await page.getByRole('button', { name: 'wiki を作成' }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`))
  await newPage(page, '議事録')
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/p/${encodeURIComponent('議事録')}$`))

  // A raw wiki id is redirected to the slug URL.
  const id = (await apiCall(page, 'GET', `/api/wikis/${slug}`)).json.wiki.id
  await page.goto(`/w/${id}/p/${encodeURIComponent('議事録')}#L1`)
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/p/${encodeURIComponent('議事録')}#L1$`))

  // Change the slug in settings; the old URL forwards to the new one.
  await page.goto(`/w/${slug}/settings`)
  await page.getByTestId('wiki-slug').fill(`${slug}-new`)
  await page.getByRole('button', { name: '変更' }).first().click()
  await expect(page.getByText('識別子を変更しました。')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/w/${slug}-new/settings$`))
  await page.goto(`/w/${slug}/p/${encodeURIComponent('議事録')}`)
  await expect(page).toHaveURL(new RegExp(`/w/${slug}-new/p/${encodeURIComponent('議事録')}$`))
  await expect(page.locator('.page-title')).toHaveText('議事録')

  // Duplicate slugs are rejected with a message.
  await page.goto('/')
  await page.getByTestId('new-wiki-name').fill('別の wiki')
  await page.getByTestId('new-wiki-slug').fill(`${slug}-new`)
  await page.getByRole('button', { name: 'wiki を作成' }).click()
  await expect(page.getByText(`識別子「${slug}-new」はすでに使われています。`)).toBeVisible()
  await page.context().close()
})

test('history: edit sessions with diffs, restore an older version', async ({ browser }) => {
  const alice = await login(browser, uniq('hist-a'))
  const wid = await createWiki(alice, '履歴 wiki')
  const bobEmail = uniq('hist-b')
  await apiCall(alice, 'POST', `/api/wikis/${wid}/invitations`, { email: bobEmail, role: 'editor' })
  await newPage(alice, 'Doc')
  await writeBody(alice, '最初の文章')
  await saved(alice)

  const bob = await login(browser, bobEmail)
  await bob.goto(alice.url())
  await expect(bob.locator('[data-testid=doc]')).toContainText('最初の文章')
  await writeBody(bob, 'ボブが書き換えた')
  await saved(bob)

  await alice.reload()
  await expect(alice.locator('[data-testid=doc]')).toContainText('ボブが書き換えた')
  await alice.getByTestId('history').click()
  const list = alice.getByTestId('history-list').locator('button:not(.link-btn)')
  await expect(list).toHaveCount(3) // bob, alice, creation
  await expect(alice.getByTestId('diff')).toContainText('ボブが書き換えた')
  await list.nth(1).click()
  await expect(alice.getByTestId('diff').locator('.diff-add')).toHaveText(/最初の文章/)
  await alice.getByTestId('restore').click()
  await expect(alice.locator('[data-testid=doc]')).toHaveText(/最初の文章/)
  await expect(alice.getByText(/の内容に戻しました/)).toBeVisible()
  await saved(alice)
  const pages = (await apiCall(alice, 'GET', `/api/wikis/${wid}/pages`)).json.pages
  const p = (await apiCall(alice, 'GET', `/api/wikis/${wid}/pages/${pages[0].id}`)).json.page
  expect(p.content).toBe('最初の文章')
  expect(p.version).toBe(4) // restoring adds a version; nothing is deleted
  await alice.context().close()
  await bob.context().close()
})

/** Paste a generated PNG into `selector` (a real ClipboardEvent carrying a File). */
async function pastePng(page: Page, selector: string, name = 'スクショ.png') {
  await page.evaluate(
    async ({ selector, name }) => {
      const c = document.createElement('canvas')
      c.width = 24
      c.height = 16
      const g = c.getContext('2d')!
      g.fillStyle = '#2f6feb'
      g.fillRect(0, 0, 24, 16)
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'))
      const dt = new DataTransfer()
      dt.items.add(new File([blob], name, { type: 'image/png' }))
      document.querySelector(selector)!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    },
    { selector, name },
  )
}

test('images: paste in edit mode and in display mode, served to members', async ({ browser }) => {
  const page = await login(browser, uniq('img'))
  const wid = await createWiki(page, '画像 wiki')
  await newPage(page, 'Pics')
  await writeBody(page, '画像の前の段落')
  await saved(page)

  // edit mode: paste at the caret
  await page.getByText('画像の前の段落').dblclick()
  const ta = page.locator('[data-testid=src-editor] textarea')
  await ta.evaluate((t: HTMLTextAreaElement) => t.setSelectionRange(3, 3)) // mid-line: 画像の|前の段落
  await pastePng(page, '[data-testid=src-editor] textarea')
  await expect(ta).toHaveValue(/^画像の\n!\[スクショ\]\(\/api\/wikis\/[0-9a-f-]+\/files\/[0-9a-f-]+\)\n前の段落$/)
  await page.keyboard.press('Escape')
  const img = page.locator('[data-testid=doc] img').first()
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(24)
  await saved(page)

  // display mode: paste goes on a new line below the caret's block
  await page.getByTestId('doc').click()
  await page.keyboard.press('ControlOrMeta+ArrowUp')
  await pastePng(page, '[data-testid=doc]', '二枚目.png')
  await expect(page.locator('[data-testid=src-editor] textarea')).toHaveValue(/!\[二枚目\]\(\/api\/wikis\//)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid=doc] img')).toHaveCount(2)
  await saved(page)

  // members only
  const src = await img.getAttribute('src')
  const out = await login(browser, uniq('img-out'))
  expect((await out.request.get(src!)).status()).toBe(404)
  expect((await page.request.get(src!)).status()).toBe(200)
  void wid
  await page.context().close()
  await out.context().close()
})

test('quick open: Cmd/Ctrl+K finds pages by part of the name and can create one', async ({ browser }) => {
  const page = await login(browser, uniq('quick'))
  await createWiki(page, 'Quick wiki')
  await newPage(page, '開発/API/認証')
  await newPage(page, '議事録/2026-11')
  await page.keyboard.press('ControlOrMeta+k')
  const input = page.getByTestId('quick-open-input')
  await expect(input).toBeFocused()
  await input.fill('認証')
  await expect(page.getByTestId('quick-open-list').locator('button').first()).toHaveText('開発/API/認証')
  await page.keyboard.press('Enter')
  await expect(page.locator('.page-title')).toHaveText('認証')

  // works while editing too; fuzzy match; ↓ + Enter
  await page.getByTestId('doc').click()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ControlOrMeta+k')
  await input.fill('gjr')
  await expect(page.getByTestId('quick-open-list').locator('button')).toHaveCount(1) // only the create row
  await input.fill('議 11')
  await page.keyboard.press('Enter')
  await expect(page.locator('.page-title')).toHaveText('2026-11')

  // create a new page from the switcher
  await page.keyboard.press('ControlOrMeta+k')
  await input.fill('新しい/メモ')
  await expect(page.getByTestId('quick-open-list').locator('button').last()).toHaveText('＋ 「新しい/メモ」を作成')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.locator('.page-title')).toHaveText('メモ')
  await page.context().close()
})

test('page header: … menu, ? shortcut list', async ({ browser }) => {
  const page = await login(browser, uniq('ui'))
  await createWiki(page, 'UI wiki')
  await newPage(page, 'Doc')
  await expect(page.getByTestId('rename')).toHaveCount(0) // tucked into the … menu
  await page.getByTestId('page-menu').click()
  await expect(page.getByRole('menuitem')).toHaveText(['子ページを作成', '名前を変更', '削除'])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menuitem')).toHaveCount(0)
  await page.getByTestId('help-button').click()
  await expect(page.getByTestId('help')).toContainText('直前の編集を取り消す')
  await page.keyboard.press('Escape')
  await page.getByTestId('doc').click()
  await page.keyboard.press('?')
  await expect(page.getByTestId('help')).toBeVisible()
  await page.context().close()
})

test('phone: drawer sidebar, tap → 編集, 完了 button', async ({ browser }) => {
  const email = uniq('phone')
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const page = await ctx.newPage()
  await page.goto(`/auth/dev-login?email=${encodeURIComponent(email)}&returnTo=/`)
  await createWiki(page, 'スマホ wiki')
  // sidebar is a drawer
  await expect(page.getByTestId('new-page')).not.toBeInViewport()
  await page.getByTestId('open-drawer').tap()
  await expect(page.getByTestId('new-page')).toBeInViewport()
  await page.getByTestId('new-page').tap()
  await page.getByTestId('new-page-name').fill('メモ')
  await page.getByRole('button', { name: '作成', exact: true }).tap()
  await expect(page.locator('.page-title')).toHaveText('メモ')
  await expect(page.getByTestId('new-page')).not.toBeInViewport() // closed on navigation
  // empty page: a tap starts writing; 完了 ends it (no Esc key on phones)
  await page.getByTestId('doc').tap()
  const ta = page.locator('[data-testid=src-editor] textarea')
  await expect(ta).toBeVisible()
  await ta.fill('スマホで書いた')
  await page.getByTestId('src-done').tap()
  await expect(ta).toHaveCount(0)
  await saved(page)
  // tapping text shows an 編集 button at the caret
  await page.getByText('スマホで書いた').tap()
  await page.getByTestId('tap-edit').tap()
  await expect(ta).toHaveValue('スマホで書いた')
  await page.getByTestId('src-done').tap()
  await expect(page.getByTestId('mode-bar')).toBeHidden()
  await ctx.close()
})
