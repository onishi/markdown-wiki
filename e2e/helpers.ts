import { expect, type Page } from '@playwright/test'

export const source = (page: Page) => page.getByTestId('source').textContent()

/** Put the display-mode caret before the `index`-th character of the first rendered run containing `text`. */
export async function caretAt(page: Page, text: string, index: number, opts: { within?: string; nth?: number } = {}) {
  const pt = await page.evaluate(
    ({ text, index, within, nth }) => {
      const root = document.querySelector('[data-testid=doc]')!
      const spans = [...root.querySelectorAll(`${within ?? ''} span.r`)].filter((s) => s.textContent!.includes(text))
      const span = spans[nth ?? 0]
      const t = span.firstChild as Text
      const at = t.data.indexOf(text) + index
      const r = document.createRange()
      r.setStart(t, at)
      r.setEnd(t, Math.min(at + 1, t.length))
      const rect = r.getBoundingClientRect()
      return { x: rect.left + 0.5, y: rect.top + rect.height / 2 }
    },
    { text, index, within: opts.within, nth: opts.nth },
  )
  await page.mouse.click(pt.x, pt.y)
  return pt
}

export async function textarea(page: Page) {
  const ta = page.locator('[data-testid=src-editor] textarea')
  await expect(ta).toBeVisible()
  return {
    value: await ta.inputValue(),
    caret: await ta.evaluate((t: HTMLTextAreaElement) => t.selectionStart),
    before: await ta.evaluate((t: HTMLTextAreaElement) => t.value.slice(0, t.selectionStart)),
  }
}

export async function focusInfo(page: Page) {
  return page.evaluate(() => {
    const s = getSelection()!
    return { text: s.focusNode?.textContent ?? '', offset: s.focusOffset, collapsed: s.isCollapsed, selected: s.toString() }
  })
}
