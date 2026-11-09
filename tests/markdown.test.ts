import { describe, it, expect } from 'vitest'
import { parseMarkdown, walk, type WikiLink } from '../shared/markdown/parse'
import { renderDocument, makeContext, toHtmlString, type VNode, type VText } from '../shared/markdown/render'
import { computeEditUnit } from '../shared/markdown/units'
import { sliceMarkdown } from '../shared/markdown/copy'
import { rewriteWikiLinks } from '../shared/markdown/wikilinks'

function runs(src: string): VText[] {
  const tree = parseMarkdown(src)
  const out: VText[] = []
  const visit = (ns: VNode[]) =>
    ns.forEach((n) => {
      if (n.k === 'text') out.push(n)
      else if (n.k === 'el') visit(n.children)
    })
  visit(renderDocument(tree, makeContext(tree, src)))
  return out
}

/** Source offset of rendered character `ch` (n-th occurrence) — test helper only. */
function srcOf(src: string, rendered: string, nth = 0): number {
  let seen = 0
  for (const r of runs(src)) {
    for (let i = 0; i < r.text.length; i++) {
      if (r.text.startsWith(rendered, i)) {
        if (seen++ === nth) return r.offs[i]
      }
    }
  }
  throw new Error('not found')
}

const html = (src: string) => {
  const t = parseMarkdown(src)
  return toHtmlString(renderDocument(t, makeContext(t, src)))
}

describe('character mapping', () => {
  it('maps inside bold to the matching source position', () => {
    const src = '前置き **太字テキスト** 後'
    // caret before 字 → source index of 字 inside the ** markers
    expect(srcOf(src, '字テ')).toBe(src.indexOf('字テ'))
    expect(src.slice(srcOf(src, '字テ') - 3, srcOf(src, '字テ'))).toBe('**太')
  })

  it('handles repeated text and decorations without string search', () => {
    const src = 'abc **abc** [abc](http://x) abc'
    const offs = runs(src).flatMap((r) => [...r.text].map((_, i) => r.offs[i]))
    const text = runs(src).map((r) => r.text).join('')
    const as = [...text].flatMap((c, i) => (c === 'a' ? [offs[i]] : []))
    expect(as).toEqual([0, 6, 13, 28])
  })

  it('maps escapes and entities to their source', () => {
    const src = 'x \\* &amp; y'
    const r = runs(src)[0]
    expect(r.text).toBe('x * & y')
    expect(r.offs[2]).toBe(2) // * ← \*
    expect(r.offs[4]).toBe(5) // & ← &amp;
    expect(r.offs[6]).toBe(11)
  })

  it('maps multi-line paragraphs in blockquotes across stripped prefixes', () => {
    const src = '> 一行目\n> 二行目'
    expect(srcOf(src, '二')).toBe(src.indexOf('二'))
  })

  it('maps link text and wiki link labels', () => {
    const src = '[リンク文字](https://example.com) と [[開発/API|API文書]]'
    expect(srcOf(src, '文字')).toBe(src.indexOf('文字'))
    expect(srcOf(src, '文書')).toBe(src.indexOf('文書'))
  })

  it('maps code block content (no entity decoding)', () => {
    const src = '```\n&amp; a\n```'
    expect(srcOf(src, ' a') + 1).toBe(src.indexOf(' a') + 1)
    expect(srcOf(src, '&amp;')).toBe(4)
  })
})

describe('GFM rendering', () => {
  it('renders multi-line paragraphs as one paragraph (whole-document parse)', () => {
    expect(html('一行目\n二行目')).toBe('<p>一行目\n二行目</p>')
  })
  it('renders multi-line emphasis and blockquotes', () => {
    expect(html('**a\nb**')).toBe('<p><strong>a\nb</strong></p>')
    expect(html('> a\nb')).toBe('<blockquote><p>a\nb</p></blockquote>')
  })
  it('renders tables, task lists, strikethrough and autolinks', () => {
    expect(html('| a | b |\n|:-|-:|\n| 1 | 2 |')).toContain('<th style="text-align:left">a</th>')
    expect(html('- [x] done\n- [ ] todo')).toContain('<input type="checkbox" checked disabled>')
    expect(html('~~del~~')).toBe('<p><del>del</del></p>')
    expect(html('see https://example.com now')).toContain('<a href="https://example.com">https://example.com</a>')
  })
  it('sanitises raw HTML and javascript: URLs', () => {
    const out = html('<div onclick="x()"><script>alert(1)</script>ok</div>\n\n[x](javascript:alert(1))')
    expect(out).not.toContain('script')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('ok')
  })
  it('does not convert wiki links in code', () => {
    const t = parseMarkdown('`[[a]]` [[b]]\n\n```\n[[c]]\n```\n\n\\[[d]]')
    const targets: string[] = []
    walk(t, (n) => {
      if (n.type === 'wikiLink') targets.push((n as WikiLink).target)
    })
    expect(targets).toEqual(['b'])
  })
})

describe('edit units', () => {
  const unit = (src: string, at: string, mode: 'list' | 'item' = 'list') => {
    const u = computeEditUnit(parseMarkdown(src), src, src.indexOf(at), mode)
    return src.slice(u.start, u.end)
  }
  it('paragraph: one source line', () => {
    expect(unit('first line\nsecond line\nthird', 'second')).toBe('second line')
  })
  it('paragraph: expands for inline constructs spanning lines', () => {
    expect(unit('a **b\nc** d\ne', 'c**')).toBe('a **b\nc** d')
  })
  it('table: whole table', () => {
    const src = 'p\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nq'
    expect(unit(src, '2')).toBe('| a | b |\n|---|---|\n| 1 | 2 |')
  })
  it('list: whole list including nested items (default)', () => {
    const src = '- a\n  - b\n    - c\n- d\n\nafter'
    expect(unit(src, 'c')).toBe('- a\n  - b\n    - c\n- d')
  })
  it('list: item + children in item mode', () => {
    const src = '- a\n  - b\n    - c\n- d'
    expect(unit(src, 'b', 'item')).toBe('  - b\n    - c')
  })
  it('code block: including fences', () => {
    const src = 'x\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\ny'
    expect(unit(src, 'b =')).toBe('```js\nconst a = 1\n\nconst b = 2\n```')
  })
  it('setext heading and blockquote: whole construct', () => {
    expect(unit('Title\n=====\n\nx', 'Title')).toBe('Title\n=====')
    expect(unit('> a\n> b\n\nx', 'b')).toBe('> a\n> b')
  })
})

describe('markdown copy', () => {
  const md = (src: string, sel: string, from = 0) => {
    const a = src.indexOf(sel, from)
    return sliceMarkdown(parseMarkdown(src), src, a, a + sel.length)
  }
  it('partial bold keeps the markers', () => {
    expect(md('これは **太字の部分** です', '字の')).toBe('**字の**')
  })
  it('partial link keeps the url', () => {
    expect(md('[リンクテキスト](https://e.com "t")', 'テキ')).toBe('[テキ](https://e.com "t")')
  })
  it('selection beginning inside bold and ending outside', () => {
    expect(md('a **bold** tail', 'ld** ta')).toBe('**ld** ta')
  })
  it('wiki link is atomic', () => {
    expect(md('see [[開発/API]] ok', 'API]] o')).toBe('[[開発/API]] o')
  })
  it('multi-item list keeps markers', () => {
    expect(md('- one\n- two\n- three', 'ne\n- tw')).toBe('- ne\n- tw')
  })
  it('heading prefix is kept across blocks', () => {
    expect(md('## Title\n\nbody', 'tle\n\nbo')).toBe('## tle\n\nbo')
  })
  it('code block keeps fences', () => {
    expect(md('```js\nline1\nline2\n```', 'ine1')).toBe('```js\nine1\n```')
  })
  it('table keeps header rows', () => {
    expect(md('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |', '3')).toBe('| a | b |\n|---|---|\n| 3 | 4 |')
  })
})

describe('wiki link rewrite', () => {
  it('rewrites targets but not code', () => {
    const src = '[[old]] [[old|label]] `[[old]]` [[other]]'
    expect(rewriteWikiLinks(src, new Map([['old', 'new/name']]))).toBe('[[new/name]] [[new/name|label]] `[[old]]` [[other]]')
  })
})

import { threeWayMerge } from '../shared/merge'
describe('three-way merge', () => {
  it('merges non-overlapping edits', () => {
    expect(threeWayMerge('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n')).toEqual({ text: 'A\nb\nC\n', conflict: false })
  })
  it('marks overlapping edits as conflicts keeping both', () => {
    const r = threeWayMerge('a\nb\n', 'a\nmine\n', 'a\ntheirs\n')
    expect(r.conflict).toBe(true)
    expect(r.text).toContain('mine')
    expect(r.text).toContain('theirs')
  })
})

import { openLine } from '../shared/markdown/openLine'
describe('open line (o / O)', () => {
  it('starts a new paragraph after a paragraph', () => {
    expect(openLine('hello', 2, 'below', 'paragraph')).toEqual({ text: 'hello\n\n', caret: 7 })
    expect(openLine('hello', 2, 'above', 'paragraph')).toEqual({ text: '\n\nhello', caret: 0 })
  })
  it('continues list markers, task boxes and numbering', () => {
    expect(openLine('- a\n  - [x] b\n- c', 9, 'below', 'list')).toEqual({ text: '- a\n  - [x] b\n  - [ ] \n- c', caret: 22 })
    expect(openLine('1. a\n2. b', 1, 'below', 'list').text).toBe('1. a\n2. \n2. b')
  })
  it('continues blockquotes and keeps code indentation', () => {
    expect(openLine('> a', 3, 'below', 'blockquote')).toEqual({ text: '> a\n> ', caret: 6 })
    expect(openLine('```\n  x\n```', 6, 'below', 'code').text).toBe('```\n  x\n  \n```')
  })
})

import { extractOutline } from '../shared/markdown/outline'
describe('outline', () => {
  it('lists headings with text and positions, ignoring code', () => {
    const src = '# A **b** [[W|w]]\n\ntext\n\n```\n# not\n```\n\nSet\n===\n\n> ## q'
    expect(extractOutline(parseMarkdown(src)).map((h) => [h.depth, h.text, src.slice(h.textStart, h.textStart + 1)])).toEqual([
      [1, 'A b w', 'A'],
      [1, 'Set', 'S'],
      [2, 'q', 'q'],
    ])
  })
})

import { computeRangeUnit } from '../shared/markdown/units'
import { markdownToHtml } from '../shared/markdown/render'
describe('range edit unit (multi-line editing)', () => {
  const r = (src: string, from: string, to: string) => {
    const a = src.indexOf(from)
    const b = src.indexOf(to) + to.length
    const u = computeRangeUnit(parseMarkdown(src), src, a, b)
    return { text: src.slice(u.start, u.end), kind: u.kind }
  }
  it('covers the selected lines of a paragraph only', () => {
    expect(r('l1\nl2\nl3\nl4', 'l2', 'l3')).toEqual({ text: 'l2\nl3', kind: 'range' })
  })
  it('includes touched lists / tables whole and cuts paragraphs at lines', () => {
    const src = 'p1\np2\n\n- a\n- b\n\n| x |\n|---|\n| 1 |\n\nq1\nq2'
    expect(r(src, 'p2', 'a').text).toBe('p2\n\n- a\n- b')
    expect(r(src, 'b', 'q1').text).toBe('- a\n- b\n\n| x |\n|---|\n| 1 |\n\nq1')
  })
  it('a selection inside one unit is that unit', () => {
    expect(r('a **b** c\n\nx', 'b', 'c').kind).toBe('block')
  })
})

describe('soft line breaks', () => {
  const h = (src: string, mode: 'gfm' | 'break' | 'join') => markdownToHtml(parseMarkdown(src), src, undefined, mode)
  it('gfm keeps the newline (whitespace), break emits <br>, join removes it between CJK only', () => {
    expect(h('日本\n語', 'gfm')).toBe('<p>日本\n語</p>')
    expect(h('日本\n語', 'break')).toBe('<p>日本<br>\n語</p>')
    expect(h('日本\n語 and\nmore', 'join')).toBe('<p>日本語 and\nmore</p>')
    expect(h('**太字**\n次の行', 'join')).toBe('<p><strong>太字</strong>次の行</p>')
    expect(h('```\na\nb\n```', 'break')).toBe('<pre><code>a\nb</code></pre>')
  })
})

import { continueOnEnter } from '../shared/markdown/continueLine'
describe('Enter continuation in the source editor', () => {
  const at = (t: string) => continueOnEnter(t, t.length, t.length)
  it('continues quotes, lists, tasks, numbers and table rows', () => {
    expect(at('> 引用')).toEqual({ kind: 'insert', text: '\n> ' })
    expect(at('  - 項目')).toEqual({ kind: 'insert', text: '\n  - ' })
    expect(at('- [x] done')).toEqual({ kind: 'insert', text: '\n- [ ] ' })
    expect(at('9. nine')).toEqual({ kind: 'insert', text: '\n10. ' })
    expect(at('> - in quote')).toEqual({ kind: 'insert', text: '\n> - ' })
    expect(at('| a | b \\| c | d |')).toEqual({ kind: 'insert', text: '\n|  |  |  |' })
    expect(at('|---|:-:|')).toEqual({ kind: 'insert', text: '\n|  |  |' })
  })
  it('an empty prefix-only line ends the construct', () => {
    expect(at('> a\n> ')).toEqual({ kind: 'clear', from: 4, to: 6 })
    expect(at('- a\n- ')).toEqual({ kind: 'clear', from: 4, to: 6 })
    expect(at('| a |\n|---|\n|  |')).toEqual({ kind: 'clear', from: 12, to: 16 })
  })
  it('plain newline: mid-line caret, ordinary text, inside code fences, selections', () => {
    expect(continueOnEnter('> abc', 3, 3)).toBeNull()
    expect(at('ふつうの行')).toBeNull()
    expect(at('```\n- not a list')).toBeNull()
    expect(at('```\nx\n```\n- list')).toEqual({ kind: 'insert', text: '\n- ' })
    expect(continueOnEnter('> abc', 2, 5)).toBeNull()
  })
})
