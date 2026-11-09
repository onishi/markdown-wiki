import { test, expect } from '@playwright/test'
import { caretAt, focusInfo, source, textarea } from './helpers'
import { SAMPLE } from '../src/Playground'

test.beforeEach(async ({ page }) => {
  await page.goto('/playground')
  await page.waitForSelector('[data-testid=doc] span.r')
})

test.describe('cursor ↔ source mapping', () => {
  test('editing from the middle of bold keeps the caret position', async ({ page }) => {
    await caretAt(page, '太字の文章', 2) // before 「の」
    expect(await focusInfo(page)).toMatchObject({ text: '太字の文章', offset: 2 })
    await expect(page.getByTestId('caret')).toBeVisible()
    await page.keyboard.press('Enter')
    const ta = await textarea(page)
    expect(ta.value).toBe('これは **太字の文章** と [リンクのテキスト](https://example.com) を含む段落です。')
    expect(ta.before.endsWith('**太字')).toBe(true)
  })

  test('double-click inside link text opens the editor at that character', async ({ page }) => {
    const pt = await caretAt(page, 'リンクのテキスト', 4) // before 「テ」
    await page.mouse.dblclick(pt.x, pt.y)
    const ta = await textarea(page)
    expect(ta.before.endsWith('[リンクの')).toBe(true)
  })

  test('repeated text maps to the right occurrence', async ({ page }) => {
    // 「太字」 appears in the first paragraph and inside the blockquote.
    await caretAt(page, '太字', 1, { within: 'blockquote' })
    await page.keyboard.press('Enter')
    const ta = await textarea(page)
    expect(ta.value).toBe('> 引用の一行目\n> 引用の二行目で **太字** も使えます。')
    expect(ta.before.endsWith('**太')).toBe(true)
  })

  test('arrow keys move by character; Esc restores the logical position', async ({ page }) => {
    await caretAt(page, '太字の文章', 0)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowLeft')
    expect(await focusInfo(page)).toMatchObject({ text: '太字の文章', offset: 1 })
    await page.keyboard.press('Enter')
    await page.keyboard.type('X')
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid=src-editor]')).toHaveCount(0)
    expect(await focusInfo(page)).toMatchObject({ text: '太X字の文章', offset: 2 })
    expect(await source(page)).toContain('**太X字の文章**')
  })

  test('vim keys: hjkl move, i / a start editing', async ({ page }) => {
    await caretAt(page, '太字の文章', 0)
    await page.keyboard.press('l')
    await page.keyboard.press('l')
    await page.keyboard.press('h')
    expect(await focusInfo(page)).toMatchObject({ text: '太字の文章', offset: 1 })
    await page.keyboard.press('j')
    expect((await focusInfo(page)).text).not.toBe('太字の文章')
    await page.keyboard.press('k')
    expect(await focusInfo(page)).toMatchObject({ text: '太字の文章', offset: 1 })
    await page.keyboard.press('i')
    expect((await textarea(page)).before.endsWith('**太')).toBe(true)
    await page.keyboard.press('Escape')
    await page.keyboard.press('a')
    expect((await textarea(page)).before.endsWith('**太字')).toBe(true)
    await page.keyboard.press('Escape')
    expect(await source(page)).toBe(SAMPLE)
  })

  test('j / k stop at the first and last line (no wrap-around)', async ({ page }) => {
    await caretAt(page, '自動リンク', 1)
    for (let i = 0; i < 4; i++) await page.keyboard.press('j')
    expect((await focusInfo(page)).text).toContain('自動リンク')
    await page.keyboard.press('ArrowDown')
    expect((await focusInfo(page)).text).toContain('自動リンク')
    await caretAt(page, 'Markdown Wiki', 3)
    for (let i = 0; i < 3; i++) await page.keyboard.press('k')
    expect(await focusInfo(page)).toMatchObject({ offset: 3 })
    expect((await focusInfo(page)).text).toContain('Markdown Wiki')
  })

  test('o / O open a new line: new paragraph, continued list item', async ({ page }) => {
    await caretAt(page, '太字の文章', 1)
    await page.keyboard.press('o')
    await page.keyboard.type('新しい段落')
    await page.keyboard.press('Escape')
    expect(await source(page)).toContain('~~取り消し~~ があります。\n\n新しい段落\n\n> 引用の一行目')
    await expect(page.locator('[data-testid=doc] > p', { hasText: '新しい段落' })).toHaveCount(1)

    await caretAt(page, '子項目 A-1', 1)
    await page.keyboard.press('o')
    await page.keyboard.type('追加の子項目')
    await page.keyboard.press('Escape')
    expect(await source(page)).toContain('  - 子項目 A-1\n  - 追加の子項目\n  - [ ] タスク')

    await caretAt(page, 'Markdown Wiki', 0)
    await page.keyboard.press('Shift+O')
    await page.keyboard.type('先頭の段落')
    await page.keyboard.press('Escape')
    expect((await source(page))!.startsWith('先頭の段落\n\n# Markdown Wiki')).toBe(true)
  })

  test('“＋ 書き足す” starts a new paragraph at the end', async ({ page }) => {
    await page.getByTestId('append').click()
    await page.keyboard.type('末尾の段落')
    await page.keyboard.press('Escape')
    expect((await source(page))!.endsWith('も自動リンク。\n\n末尾の段落\n')).toBe(true)
  })

  test('display mode never changes text on typing or Backspace', async ({ page }) => {
    await caretAt(page, '太字の文章', 2)
    await page.keyboard.type('xyz あ')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Delete')
    expect(await source(page)).toBe(SAMPLE)
  })
})

test.describe('edit units', () => {
  test('paragraph: only the source line; table, nested list and code block: whole construct', async ({ page }) => {
    await caretAt(page, '同じ段落', 1)
    await page.keyboard.press('Enter')
    expect((await textarea(page)).value).toBe('同じ段落の二行目には *強調* と `inline code` と ~~取り消し~~ があります。')
    // the first line of the same paragraph stays rendered
    await expect(page.locator('p.para-part strong')).toHaveText('太字の文章')
    await page.keyboard.press('Escape')

    await caretAt(page, '右寄せ', 1)
    await page.keyboard.press('Enter')
    expect((await textarea(page)).value).toBe('| 名前 | 説明 |\n|:-----|-----:|\n| foo  | 左寄せ |\n| bar  | 右寄せ |')
    await page.keyboard.press('Escape')

    await caretAt(page, '子項目 A-1', 2)
    await page.keyboard.press('Enter')
    expect((await textarea(page)).value).toBe('- 項目 A\n  - 子項目 A-1\n  - [ ] タスク\n- 項目 B')
    await page.keyboard.press('Escape')

    await caretAt(page, 'const a', 3)
    await page.keyboard.press('Enter')
    const code = await textarea(page)
    expect(code.value).toBe('```js\nconst a = 1 // [[リンクにならない]]\n```')
    expect(code.before).toBe('```js\ncon')
    await page.keyboard.press('Escape')
  })

  test('list unit can be switched to "item + children"', async ({ page }) => {
    await page.getByTestId('list-mode').selectOption('item')
    await caretAt(page, '項目 A', 1)
    await page.keyboard.press('Enter')
    expect((await textarea(page)).value).toBe('- 項目 A\n  - 子項目 A-1\n  - [ ] タスク')
    await page.keyboard.press('Escape')
    await caretAt(page, '子項目 A-1', 1)
    await page.keyboard.press('Enter')
    expect((await textarea(page)).value).toBe('  - 子項目 A-1')
    await page.keyboard.press('Escape')
    expect(await source(page)).toBe(SAMPLE)
  })

  test('switching modes on every block leaves the Markdown untouched', async ({ page }) => {
    for (const t of ['Markdown Wiki', '太字の文章', '同じ段落', '引用の二行目', '子項目', '左寄せ', 'const', '自動リンク']) {
      await caretAt(page, t, 1)
      await page.keyboard.press('Enter')
      await textarea(page)
      await page.keyboard.press('Escape')
    }
    expect(await source(page)).toBe(SAMPLE)
  })

  test('typing a fence or blank lines keeps the editor open; structure updates on exit', async ({ page }) => {
    await caretAt(page, '同じ段落', 0)
    await page.keyboard.press('Enter')
    await page.keyboard.press('End')
    await page.keyboard.type('\n\n```\ncode here')
    const ta = page.locator('[data-testid=src-editor] textarea')
    await expect(ta).toBeFocused()
    expect((await textarea(page)).before.endsWith('```\ncode here')).toBe(true)
    // following blocks are still rendered from the pre-edit structure
    await expect(page.locator('blockquote')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.locator('pre code').first()).toContainText('code here')
  })

  test('undo/redo inside the source editor', async ({ page }) => {
    await caretAt(page, 'Markdown Wiki', 0)
    await page.keyboard.press('Enter')
    await page.keyboard.type('abc')
    await page.keyboard.press('ControlOrMeta+z')
    expect((await textarea(page)).value).not.toContain('abc')
    await page.keyboard.press('ControlOrMeta+Shift+z')
    expect((await textarea(page)).value).toContain('abc')
  })
})

test.describe('rendering (whole-document GFM)', () => {
  test('multi-line paragraph and quote are single blocks', async ({ page }) => {
    const p = page.locator('[data-testid=doc] > p').first()
    await expect(p).toContainText('太字の文章')
    await expect(p).toContainText('同じ段落の二行目')
    await expect(page.locator('blockquote p')).toHaveCount(1)
    await expect(page.locator('blockquote p')).toContainText('引用の一行目')
    await expect(page.locator('blockquote p')).toContainText('引用の二行目')
    await expect(page.locator('table th').nth(1)).toHaveCSS('text-align', 'right')
    await expect(page.locator('li.task-list-item input[type=checkbox]')).toHaveCount(1)
    await expect(page.locator('del')).toHaveText('取り消し')
    await expect(page.locator('a[href="https://example.org"]')).toHaveCount(1)
    await expect(page.locator('pre a')).toHaveCount(0)
    await expect(page.locator('a.wikilink.missing')).toHaveText('存在しないページ')
  })
})

test.describe('IME', () => {
  test('Esc / Enter during composition do not switch modes', async ({ page }) => {
    await caretAt(page, 'Markdown Wiki', 0)
    await page.keyboard.press('Enter')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 })
    await page.keyboard.press('Escape') // cancels conversion, must not leave edit mode
    await expect(page.getByTestId('src-editor')).toBeVisible()
    await page.keyboard.press('Enter') // confirms conversion, must not leave edit mode
    await expect(page.getByTestId('src-editor')).toBeVisible()
    await cdp.send('Input.insertText', { text: '日本語' })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('src-editor')).toHaveCount(0)
  })

  test('composition-flagged Enter in display mode does not start editing', async ({ page }) => {
    await caretAt(page, '太字の文章', 1)
    await page.evaluate(() => {
      const doc = document.querySelector('[data-testid=doc]')!
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true }))
    })
    await expect(page.getByTestId('src-editor')).toHaveCount(0)
  })
})

test.describe('selection and copy', () => {
  async function selectInBold(page: import('@playwright/test').Page) {
    await caretAt(page, '太字の文章', 1)
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    expect((await focusInfo(page)).selected).toBe('字の')
  }
  // Menu copies are async; retry while the clipboard is being written.
  const clip = async (page: import('@playwright/test').Page) => {
    await page.waitForTimeout(100)
    for (let i = 0; ; i++) {
      try {
        return await page.evaluate(async () => {
          const items = await navigator.clipboard.read()
          const out: Record<string, string> = {}
          for (const it of items) for (const t of it.types) out[t] = await (await it.getType(t)).text()
          return out
        })
      } catch (e) {
        if (i > 10) throw e
        await page.waitForTimeout(100)
      }
    }
  }

  test('three copy formats from the selection menu', async ({ page }) => {
    await selectInBold(page)
    await page.getByTestId('copy-markdown').click()
    expect((await clip(page))['text/plain']).toBe('**字の**')
    await selectInBold(page)
    await page.getByTestId('copy-plain').click()
    expect((await clip(page))['text/plain']).toBe('字の')
    await selectInBold(page)
    await page.getByTestId('copy-rich').click()
    const c = await clip(page)
    expect(c['text/html']).toContain('<strong>字の</strong>')
    expect(c['text/plain']).toBe('字の')
  })

  test('Cmd/Ctrl+C puts rich text and plain text', async ({ page }) => {
    await selectInBold(page)
    await page.keyboard.press('ControlOrMeta+c')
    const c = await clip(page)
    expect(c['text/plain']).toBe('字の')
    expect(c['text/html']).toContain('<strong>字の</strong>')
  })

  test('multi-block selection and wiki links', async ({ page }) => {
    await caretAt(page, 'Markdown Wiki', 0)
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Shift+End')
    await page.getByTestId('copy-markdown').click()
    const md = (await clip(page))['text/plain']
    expect(md.startsWith('# Markdown Wiki プレイグラウンド\n\nこれは **太字の文章** と')).toBe(true)

    await caretAt(page, '開発/API/認証', 0)
    await page.keyboard.press('Shift+End')
    await page.getByTestId('copy-markdown').click()
    expect((await clip(page))['text/plain']).toContain('[[開発/API/認証]] と [[存在しないページ]]')
    await caretAt(page, '開発/API/認証', 0)
    await page.keyboard.press('Shift+End')
    await page.getByTestId('copy-rich').click()
    const c = await clip(page)
    expect(c['text/plain']).toContain('開発/API/認証 と 存在しないページ')
    expect(decodeURI(c['text/html'])).toMatch(/<a href="http:\/\/localhost:\d+\/#開発\/API\/認証"[^>]*>開発\/API\/認証<\/a>/)
  })

  test('right-click offers copy formats', async ({ page }) => {
    await selectInBold(page)
    const box = await page.locator('strong').first().boundingBox()
    await page.mouse.click(box!.x + 10, box!.y + 5, { button: 'right' })
    await expect(page.locator('.doc-menu-context')).toBeVisible()
    await page.locator('.doc-menu-context').getByText('Markdown').click()
    expect((await clip(page))['text/plain']).toBe('**字の**')
  })
})

test.describe('links', () => {
  test('click places the caret, link menu and Cmd/Ctrl+click open', async ({ page }) => {
    const url = page.url()
    await caretAt(page, 'リンクのテキスト', 2)
    expect(page.url()).toBe(url)
    expect(await focusInfo(page)).toMatchObject({ text: 'リンクのテキスト', offset: 2 })
    await expect(page.locator('.doc-menu-link')).toContainText('https://example.com')

    const logs: string[] = []
    page.on('console', (m) => logs.push(m.text()))
    await caretAt(page, '開発/API/認証', 1)
    await expect(page.locator('.doc-menu-link button')).toHaveText('開く')
    await page.locator('.doc-menu-link button').click()
    const box = await page.locator('a.wikilink').first().boundingBox()
    await page.keyboard.down('ControlOrMeta')
    await page.mouse.click(box!.x + 5, box!.y + 5)
    await page.keyboard.up('ControlOrMeta')
    await expect.poll(() => logs.filter((l) => l === 'open wiki 開発/API/認証').length).toBe(2)
  })
})

test.describe('outline', () => {
  test('lists headings and jumps to the section', async ({ page }) => {
    const items = page.getByTestId('outline').locator('button')
    await expect(items).toHaveText(['Markdown Wiki プレイグラウンド', '表', 'コード', 'JavaScript', 'リンク'])
    await page.setViewportSize({ width: 1280, height: 400 })
    await items.filter({ hasText: 'リンク' }).click()
    const h = page.locator('[data-testid=doc] h2', { hasText: 'リンク' })
    const box = (await h.boundingBox())!
    expect(box.y).toBeGreaterThan(40)
    expect(box.y).toBeLessThan(110)
    // caret is now at the heading text and the doc has focus (keyboard continues from there)
    expect(await focusInfo(page)).toMatchObject({ text: 'リンク', offset: 0 })
    await expect(items.filter({ hasText: 'リンク' })).toHaveClass(/active/)
    await page.keyboard.press('j')
    await page.keyboard.press('i')
    expect((await textarea(page)).value).toContain('[[開発/API/認証]]')
  })

  test('jumping while editing finishes the edit first', async ({ page }) => {
    await caretAt(page, '太字の文章', 1)
    await page.keyboard.press('Enter')
    await page.keyboard.type('Z')
    await page.getByTestId('outline').getByText('表', { exact: true }).click()
    await expect(page.getByTestId('src-editor')).toHaveCount(0)
    expect(await source(page)).toContain('**太Z字の文章**')
    expect(await focusInfo(page)).toMatchObject({ text: '表', offset: 0 })
  })
})

test.describe('line numbers', () => {
  test('gutter shows source line numbers aligned with their text', async ({ page }) => {
    const lines = await page.locator('.ln').evaluateAll((ls) => ls.map((l) => (l as HTMLElement).dataset.lines))
    // blank lines and the table delimiter row have no number; each source line has its own row
    expect(lines.slice(0, 11)).toEqual(['1', '3', '4', '6', '7', '9', '10', '11', '12', '14', '16'])
    const ln = (await page.locator('.ln[data-n="14"]').boundingBox())!
    const h = (await page.locator('[data-testid=doc] h2', { hasText: '表' }).boundingBox())!
    expect(Math.abs(ln.y + ln.height / 2 - (h.y + h.height / 2))).toBeLessThan(8)
  })

  test('click / shift-click select lines and give a permalink', async ({ page }) => {
    await page.locator('.ln[data-n="9"]').click()
    await page.locator('.ln[data-n="12"]').click({ modifiers: ['Shift'] })
    expect((await focusInfo(page)).selected).toBe('項目 A\n子項目 A-1\nタスク\n項目 B')
    expect(page.url()).toMatch(/\/playground#L9-L12$/)
    await expect(page.locator('.ln.on')).toHaveCount(4)
    await page.getByTestId('copy-permalink').click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/playground#L9-L12$/)
    // the selection behaves like any other: Markdown copy keeps the list structure
    await page.getByTestId('copy-markdown').click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('- 項目 A\n  - 子項目 A-1\n  - [ ] タスク\n- 項目 B')
  })

  test('opening a permalink scrolls to and selects the lines', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 400 })
    await page.goto('/playground#L16-L19')
    await expect.poll(async () => (await focusInfo(page)).selected).toBe('名前\t説明\nfoo\t左寄せ\nbar\t右寄せ')
    const t = (await page.locator('table').boundingBox())!
    expect(t.y).toBeGreaterThan(0)
    expect(t.y).toBeLessThan(200)
  })
})

test.describe('soft line breaks', () => {
  test('shown as line breaks by default; GFM-join mode removes the space between Japanese', async ({ page }) => {
    const p = page.locator('[data-testid=doc] > p').first()
    await expect(p).toHaveCSS('white-space', 'pre-line')
    const rowsOf = (n: string) => page.locator(`.ln[data-n="${n}"]`).boundingBox()
    expect((await rowsOf('4'))!.y).toBeGreaterThan((await rowsOf('3'))!.y + 10)
    // rich copy carries <br>
    await page.locator('.ln[data-n="3"]').click()
    await page.locator('.ln[data-n="4"]').click({ modifiers: ['Shift'] })
    await page.keyboard.press('ControlOrMeta+c')
    const html = await page.evaluate(async () => (await (await navigator.clipboard.read())[0].getType('text/html')).text())
    expect(html).toContain('含む段落です。<br>')

    await page.getByTestId('soft-break').selectOption('join')
    await expect(p).not.toHaveCSS('white-space', 'pre-line')
    await expect(p).toContainText('を含む段落です。同じ段落の二行目')
    // caret mapping still exact around the joined break
    await caretAt(page, '同じ段落', 0)
    await page.keyboard.press('Enter')
    expect((await textarea(page)).value.startsWith('同じ段落の二行目')).toBe(true)
    await page.keyboard.press('Escape')
    expect(await source(page)).toBe(SAMPLE)
  })
})

test.describe('multi-line editing', () => {
  test('selected lines (via line numbers) open together as one source editor', async ({ page }) => {
    await page.locator('.ln[data-n="4"]').click()
    await page.locator('.ln[data-n="7"]').click({ modifiers: ['Shift'] })
    await page.keyboard.press('Enter')
    const ta = page.locator('[data-testid=src-editor] textarea')
    await expect(ta).toHaveValue('同じ段落の二行目には *強調* と `inline code` と ~~取り消し~~ があります。\n\n> 引用の一行目\n> 引用の二行目で **太字** も使えます。')
    // the selection is kept inside the editor; line 3 of the paragraph stays rendered
    expect(await ta.evaluate((t: HTMLTextAreaElement) => t.value.slice(t.selectionStart, t.selectionEnd))).toContain('引用の二行目で **太字** も使えます。')
    await expect(page.locator('p.para-part')).toContainText('太字の文章')
    await expect(page.locator('[data-testid=doc] > ul')).toHaveCount(1)
    // edit across the blocks, then leave
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.insertText('置き換えた二行目\n\n> 新しい引用')
    await page.keyboard.press('Escape')
    const src = await source(page)
    expect(src).toContain('を含む段落です。\n置き換えた二行目\n\n> 新しい引用\n\n- 項目 A')
    await expect(page.locator('blockquote')).toHaveText('新しい引用')
  })

  test('a mouse / keyboard selection across blocks + i edits all of it', async ({ page }) => {
    await caretAt(page, '項目 B', 0)
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('i')
    await expect(page.locator('[data-testid=src-editor] textarea')).toHaveValue(/^- 項目 A[\s\S]*- 項目 B\n\n## 表\n\n\| 名前/)
    await page.keyboard.press('Escape')
    expect(await source(page)).toBe(SAMPLE)
  })
})

test.describe('vertical movement', () => {
  test('k / j and arrows move between table rows (geometric, not cell order)', async ({ page }) => {
    await page.locator('td').filter({ hasText: '右寄せ' }).click()
    await page.keyboard.press('k')
    expect((await focusInfo(page)).text).toBe('左寄せ')
    await page.keyboard.press('ArrowUp')
    expect((await focusInfo(page)).text).toBe('説明')
    await page.keyboard.press('k')
    expect((await focusInfo(page)).text).toBe('表')
    // the goal column (right) is kept across consecutive vertical moves
    await page.keyboard.press('j')
    await page.keyboard.press('ArrowDown')
    expect((await focusInfo(page)).text).toBe('左寄せ')
    await page.keyboard.press('Shift+ArrowDown')
    const f = await focusInfo(page)
    expect(f.text).toBe('右寄せ') // extended to the row below, same column
    expect(f.collapsed).toBe(false)
  })

  test('emacs keys in display mode (macOS)', async ({ page }) => {
    test.skip(!(await page.evaluate(() => /Mac/.test(navigator.platform))), 'Ctrl-based emacs keys are macOS only')
    await caretAt(page, '同じ段落', 2)
    const after = async () => {
      const f = await focusInfo(page)
      return f.text.slice(f.offset)
    }
    await page.keyboard.press('Control+a') // line start (the line begins mid text node)
    expect((await after()).startsWith('同じ段落')).toBe(true)
    await page.keyboard.press('Control+f')
    await page.keyboard.press('Control+f')
    await page.keyboard.press('Control+b')
    expect((await after()).startsWith('じ段落')).toBe(true)
    await page.keyboard.press('Control+p')
    expect((await focusInfo(page)).text).toContain('これは')
    await page.keyboard.press('Control+n')
    await page.keyboard.press('Control+e')
    const f = await focusInfo(page)
    expect(f.text.endsWith('があります。')).toBe(true)
    expect(f.offset).toBe(f.text.length)
    // Cmd+A is still select-all
    await page.keyboard.press('Meta+a')
    expect((await focusInfo(page)).selected.startsWith('Markdown Wiki')).toBe(true)
  })
})

test.describe('Enter continuation in edit mode', () => {
  test('quote, list and table lines continue; Enter on an empty one ends it; undo reverts', async ({ page }) => {
    await caretAt(page, '引用の二行目', 0)
    await page.keyboard.press('Enter')
    const ta = page.locator('[data-testid=src-editor] textarea')
    await page.keyboard.press('ControlOrMeta+ArrowDown')
    await page.keyboard.press('Enter')
    await page.keyboard.type('三行目')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter') // empty "> " → ends the quote
    await page.keyboard.type('引用の外')
    await expect(ta).toHaveValue('> 引用の一行目\n> 引用の二行目で **太字** も使えます。\n> 三行目\n引用の外')
    await page.keyboard.press('Escape')

    await caretAt(page, '右寄せ', 0)
    await page.keyboard.press('Enter')
    await page.keyboard.press('ControlOrMeta+ArrowDown')
    await page.keyboard.press('Enter')
    await expect(ta).toHaveValue(/\| bar  \| 右寄せ \|\n\|  \|  \|$/)
    await page.keyboard.type('baz')
    for (let i = 0; i < 5 && !(await ta.inputValue()).endsWith('|  |  |'); i++) await page.keyboard.press('ControlOrMeta+z')
    await expect(ta).toHaveValue(/\|  \|  \|$/)
    await page.keyboard.press('ControlOrMeta+z') // one undo removes the auto-inserted row
    await expect(ta).toHaveValue(/\| bar  \| 右寄せ \|$/)
    // Shift+Enter is a plain newline
    await page.keyboard.press('Shift+Enter')
    await expect(ta).toHaveValue(/右寄せ \|\n$/)
    await page.keyboard.press('Escape')
  })
})

test.describe('context menu edit', () => {
  test('right-click on a selection offers 選択範囲を編集', async ({ page }) => {
    await page.locator('.ln[data-n="9"]').click()
    await page.locator('.ln[data-n="12"]').click({ modifiers: ['Shift'] })
    const box = (await page.locator('[data-testid=doc] li').first().boundingBox())!
    await page.mouse.click(box.x + 30, box.y + 8, { button: 'right' })
    await page.locator('.doc-menu-context').getByTestId('edit-selection').click()
    await expect(page.locator('[data-testid=src-editor] textarea')).toHaveValue('- 項目 A\n  - 子項目 A-1\n  - [ ] タスク\n- 項目 B')
  })
})

test.describe('scroll stability', () => {
  test('entering and leaving edit mode keeps the caret line in place', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 500 })
    await page.evaluate(() => document.body.style.setProperty('padding-bottom', '2000px'))
    await page.locator('table').scrollIntoViewIfNeeded()
    await page.evaluate(() => window.scrollBy(0, 150))
    await caretAt(page, '右寄せ', 1)
    const before = (await page.getByTestId('caret').boundingBox())!.y
    await page.keyboard.press('Enter')
    const taCaretY = await page.evaluate(() => {
      const ta = document.querySelector('textarea')!
      const lines = ta.value.slice(0, ta.selectionStart).split('\n').length - 1
      const cs = getComputedStyle(ta)
      return ta.getBoundingClientRect().top + parseFloat(cs.paddingTop) + lines * parseFloat(cs.lineHeight)
    })
    expect(Math.abs(taCaretY - before)).toBeLessThan(30)
    await page.keyboard.press('Escape')
    const after = (await page.getByTestId('caret').boundingBox())!.y
    expect(Math.abs(after - taCaretY)).toBeLessThan(30)
  })
})
