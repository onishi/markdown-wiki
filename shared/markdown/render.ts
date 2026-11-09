import type { Root, Nodes, Parents, Definition, List, ListItem, Table, Code, Html } from 'mdast'
import { fromHtml } from 'hast-util-from-html'
import { sanitize, defaultSchema } from 'hast-util-sanitize'
import { toHtml } from 'hast-util-to-html'
import { alignText } from './align.js'
import { type AnyNode, type WikiLink, start, end, walk } from './parse.js'

/**
 * Virtual DOM produced from the mdast.  Every piece of visible text is a `text` vnode
 * carrying `offs`: the source offset of each character (length = text.length + 1).
 * This is what lets the display-mode caret be mapped back to the exact source position.
 */
export type VNode = VEl | VText | VRaw | VSlot
export interface VEl {
  k: 'el'
  tag: string
  attrs?: Record<string, string | boolean | undefined>
  children: VNode[]
}
export interface VText {
  k: 'text'
  text: string
  offs: number[]
}
export interface VRaw {
  k: 'raw'
  html: string
  /** Source offset used for the caret when the raw block is targeted. */
  at: number
}
/** Placeholder replaced by the source editor in the UI. */
export interface VSlot {
  k: 'slot'
}

export interface WikiResolver {
  (target: string): { href: string; exists: boolean }
}

export interface RenderContext {
  src: string
  resolveWiki: WikiResolver
  definitions: Map<string, Definition>
  /** Edit-unit replacement: a block whose full-line range equals this is replaced by a slot. */
  replace?: { start: number; end: number; kind: 'block' | 'lines' | 'item' | 'range'; target: number }
  /**
   * Soft line breaks (newline inside a paragraph):
   *  - 'gfm'   (spec) rendered as whitespace
   *  - 'break' shown as a line break (newline kept in the text; CSS pre-line / <br> in HTML)
   *  - 'join'  GFM, but no space is inserted between two CJK characters
   */
  softBreak?: SoftBreak
}

export type SoftBreak = 'gfm' | 'break' | 'join'

export interface Block {
  node: Nodes
  index: number
  start: number
  end: number
}

export function collectDefinitions(tree: Root): Map<string, Definition> {
  const defs = new Map<string, Definition>()
  walk(tree, (n) => {
    if (n.type === 'definition') {
      const id = n.identifier.toLowerCase()
      if (!defs.has(id)) defs.set(id, n)
    }
  })
  return defs
}

export const defaultWikiResolver: WikiResolver = (t) => ({ href: `#wiki:${encodeURIComponent(t)}`, exists: true })

export function makeContext(tree: Root, src: string, resolveWiki: WikiResolver = defaultWikiResolver, softBreak: SoftBreak = 'gfm'): RenderContext {
  return { src, resolveWiki, definitions: collectDefinitions(tree), softBreak }
}

/** Render one top-level block (or any block). */
export function renderBlock(node: Nodes, ctx: RenderContext): VNode[] {
  return block(node as AnyNode, ctx, false)
}

export function renderDocument(tree: Root, ctx: RenderContext): VNode[] {
  const r = ctx.replace
  if (r?.kind === 'range') return renderWithRange(tree, ctx, r)
  return tree.children.flatMap((c) => renderBlock(c, ctx))
}

/** A multi-block edit range: blocks inside become one slot; paragraphs at the edges are split. */
function renderWithRange(tree: Root, ctx: RenderContext, r: { start: number; end: number }): VNode[] {
  const out: VNode[] = []
  let slotDone = false
  const inner: RenderContext = { ...ctx, replace: undefined }
  for (const node of tree.children) {
    const ls = lineStart(ctx.src, start(node))
    const le = lineEnd(ctx.src, end(node))
    if (le < r.start || ls > r.end) {
      out.push(...renderBlock(node, inner))
      continue
    }
    if (node.type === 'paragraph' && ls < r.start) {
      const before = clipInlines(node.children as AnyNode[], inner, start(node), r.start)
      if (hasText(before)) out.push(el('p', before, { class: 'para-part' }))
    }
    if (!slotDone) {
      out.push({ k: 'slot' })
      slotDone = true
    }
    if (node.type === 'paragraph' && le > r.end) {
      const after = clipInlines(node.children as AnyNode[], inner, r.end, end(node))
      if (hasText(after)) out.push(el('p', after, { class: 'para-part' }))
    }
  }
  if (!slotDone) out.push({ k: 'slot' })
  return out
}

const el = (tag: string, children: VNode[] = [], attrs?: VEl['attrs']): VEl => ({ k: 'el', tag, attrs, children })

function lineStart(src: string, o: number) {
  return src.lastIndexOf('\n', o - 1) + 1
}
function lineEnd(src: string, o: number) {
  const i = src.indexOf('\n', o)
  return i < 0 ? src.length : i
}

function sentinel(at: number): VText {
  // Zero-width caret anchor for blocks without text (images, rules, empty cells).
  return { k: 'text', text: '​', offs: [at, at] }
}

function hasText(nodes: VNode[]): boolean {
  return nodes.some((n) => n.k === 'text' || (n.k === 'el' && hasText(n.children)))
}

function block(node: AnyNode, ctx: RenderContext, tight: boolean): VNode[] {
  const r = ctx.replace
  if (r && node.position && node.type !== 'listItem') {
    const ls = lineStart(ctx.src, start(node))
    const le = lineEnd(ctx.src, end(node))
    if (r.kind === 'block' && ls === r.start && le === r.end) return [{ k: 'slot' }]
    if (r.kind === 'lines' && node.type === 'paragraph' && ls <= r.start && r.end <= le) {
      return splitParagraph(node, ctx, r)
    }
  }
  switch (node.type) {
    case 'paragraph': {
      const kids = inlines(node.children as AnyNode[], ctx)
      if (!hasText(kids)) kids.push(sentinel(start(node)))
      return tight ? kids : [el('p', kids)]
    }
    case 'heading': {
      const kids = inlines(node.children as AnyNode[], ctx)
      if (!hasText(kids)) kids.push(sentinel(start(node)))
      return [el(`h${node.depth}`, kids, { "data-h": String(start(node)) })]
    }
    case 'thematicBreak':
      return [el('div', [sentinel(start(node))], { class: 'hr' })]
    case 'blockquote':
      return [el('blockquote', node.children.flatMap((c) => block(c as AnyNode, ctx, false)))]
    case 'list':
      return [renderList(node, ctx)]
    case 'code':
      return [renderCode(node, ctx)]
    case 'html':
      return [renderHtmlBlock(node)]
    case 'table':
      return [renderTable(node, ctx)]
    case 'definition':
      return [] // link reference definitions are not displayed
    case 'footnoteDefinition': {
      const kids = node.children.flatMap((c) => block(c as AnyNode, ctx, false))
      return [
        el('div', [el('span', [{ k: 'text', text: `[^${node.label ?? node.identifier}]`, offs: seq(start(node), (node.label ?? node.identifier).length + 3) }], { class: 'fn-label' }), ...kids], {
          class: 'footnote-def',
          id: `fn-${node.identifier}`,
        }),
      ]
    }
    default:
      return inlines([node], ctx)
  }
}

function seq(from: number, n: number): number[] {
  return Array.from({ length: n + 1 }, (_, i) => from + i)
}

function splitParagraph(node: Nodes & { type: 'paragraph' }, ctx: RenderContext, r: { start: number; end: number }): VNode[] {
  const out: VNode[] = []
  const before = clipInlines(node.children as AnyNode[], ctx, start(node), r.start)
  if (hasText(before)) out.push(el('p', before, { class: 'para-part' }))
  out.push({ k: 'slot' })
  const after = clipInlines(node.children as AnyNode[], ctx, r.end, end(node))
  if (hasText(after)) out.push(el('p', after, { class: 'para-part' }))
  return out
}

/** Render only the inline content inside [a, b). Units never split non-text inlines. */
function clipInlines(nodes: AnyNode[], ctx: RenderContext, a: number, b: number): VNode[] {
  const out: VNode[] = []
  for (const n of nodes) {
    const s = start(n)
    const e = end(n)
    if (e <= a || s >= b) continue
    if (s >= a && e <= b) {
      out.push(...inlines([n], ctx))
      continue
    }
    if (n.type === 'text') {
      const t = textVNode(n.value, ctx.src, s, e)
      let i0 = 0
      while (i0 < t.text.length && t.offs[i0] < a) i0++
      let i1 = i0
      while (i1 < t.text.length && t.offs[i1] < b) i1++
      const text = t.text.slice(i0, i1).replace(/^\n/, '')
      const shift = t.text.slice(i0, i1).startsWith('\n') ? 1 : 0
      if (text) out.push({ k: 'text', text, offs: t.offs.slice(i0 + shift, i1 + 1) })
    } else if ('children' in n) {
      // Shouldn't happen (units expand to cover containers) but degrade gracefully.
      out.push(...inlines([n], ctx))
    }
  }
  return out
}

const CJK = /[\u2E80-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/

/** Drop soft-break newlines whose neighbours are both CJK (they would render as a space). */
function joinCjkBreaks(t: VText, src: string): VText {
  if (!t.text.includes('\n')) return t
  let text = ''
  const offs: number[] = []
  for (let i = 0; i < t.text.length; i++) {
    if (t.text[i] === '\n') {
      const prev = i > 0 ? t.text[i - 1] : srcNeighbour(src, t.offs[i] - 1, -1)
      const next = i + 1 < t.text.length ? t.text[i + 1] : srcNeighbour(src, t.offs[i] + 1, 1)
      if (prev && next && CJK.test(prev) && CJK.test(next)) continue
    }
    text += t.text[i]
    offs.push(t.offs[i])
  }
  offs.push(t.offs[t.offs.length - 1])
  return { k: 'text', text, offs }
}

/** Nearest source character in a direction, skipping inline markup and indentation. */
function srcNeighbour(src: string, from: number, dir: 1 | -1): string | undefined {
  for (let j = from; j >= 0 && j < src.length; j += dir) {
    const c = src[j]
    if (c === '\n') return undefined
    if (!/[*_~`\[\]> \t]/.test(c)) return c
  }
  return undefined
}

function textVNode(value: string, src: string, s: number, e: number, literal = false): VText {
  return { k: 'text', text: value, offs: alignText(value, src, s, e, literal) }
}

function renderList(node: List, ctx: RenderContext): VNode {
  const tight = !node.spread && !node.children.some((c) => c.spread)
  const items = node.children.map((item) => renderItem(item, ctx, tight))
  const attrs: VEl['attrs'] = {}
  if (node.ordered && node.start != null && node.start !== 1) attrs.start = String(node.start)
  if (node.children.some((c) => typeof c.checked === 'boolean')) attrs.class = 'contains-task-list'
  return el(node.ordered ? 'ol' : 'ul', items, attrs)
}

function renderItem(item: ListItem, ctx: RenderContext, tight: boolean): VNode {
  const r = ctx.replace
  if (r && r.kind === 'item' && start(item) === r.target) {
    return el('li', [{ k: 'slot' }], { class: 'editing-item' })
  }
  const kids: VNode[] = []
  if (typeof item.checked === 'boolean') {
    kids.push(el('input', [], { type: 'checkbox', checked: item.checked, 'data-task': String(taskMarkerOffset(item, ctx.src)) }))
  }
  const body = item.children.flatMap((c) => block(c as AnyNode, ctx, tight && c.type === 'paragraph'))
  if (!hasText(body) && !body.some((b) => b.k === 'el' && (b.tag === 'ul' || b.tag === 'ol'))) body.push(sentinel(start(item)))
  kids.push(...body)
  return el('li', kids, typeof item.checked === 'boolean' ? { class: 'task-list-item' } : undefined)
}

/** Offset of the `[ ]` / `[x]` marker of a task item. */
export function taskMarkerOffset(item: ListItem, src: string): number {
  const s = start(item)
  const limit = item.children[0] ? start(item.children[0]) : end(item)
  const i = src.lastIndexOf('[', limit)
  return i >= s ? i : -1
}

function renderCode(node: Code, ctx: RenderContext): VNode {
  const s = start(node)
  const e = end(node)
  const src = ctx.src
  const fenced = /^[ \t]*(```|~~~)/.test(src.slice(s, Math.min(e, s + 10)))
  let cs = s
  let ce = e
  if (fenced) {
    cs = Math.min(e, lineEnd(src, s) + 1)
    const lastLs = lineStart(src, e)
    const closing = /^[ \t]*(```+|~~~+)[ \t]*$/.test(src.slice(lastLs, e)) && lastLs > s
    ce = closing ? Math.max(cs, lastLs) : e
  }
  const t = textVNode(node.value, src, cs, ce, true)
  const kids: VNode[] = t.text ? [t] : [sentinel(s)]
  const attrs = node.lang ? { class: `language-${node.lang.replace(/[^\w-]/g, '')}` } : undefined
  return el('pre', [el('code', kids, attrs)])
}

function renderTable(node: Table, ctx: RenderContext): VNode {
  const align = node.align ?? []
  const rows = node.children.map((row, ri) =>
    el(
      'tr',
      row.children.map((cell, ci) => {
        const kids = inlines(cell.children as AnyNode[], ctx)
        if (!hasText(kids)) kids.push(sentinel(start(cell)))
        return el(ri === 0 ? 'th' : 'td', kids, align[ci] ? { style: `text-align:${align[ci]}` } : undefined)
      }),
    ),
  )
  const [head, ...body] = rows
  return el('table', [el('thead', [head]), ...(body.length ? [el('tbody', body)] : [])])
}

const htmlSchema = {
  ...defaultSchema,
  // GitHub-like: no ids clobbering, no inline styles/scripts.
}

export function sanitizeHtml(html: string): string {
  const tree = fromHtml(html, { fragment: true })
  return toHtml(sanitize(tree, htmlSchema))
}

function renderHtmlBlock(node: Html): VNode {
  return el('div', [{ k: 'raw', html: sanitizeHtml(node.value), at: start(node) }, sentinel(start(node))], { class: 'html-block' })
}

// ---------------------------------------------------------------- inlines

const INLINE_HTML_TAGS = new Set(['b', 'i', 'em', 'strong', 's', 'strike', 'del', 'ins', 'u', 'mark', 'sub', 'sup', 'kbd', 'small', 'code', 'span', 'abbr', 'q', 'var', 'samp'])

function parseTag(html: string): { name: string; close: boolean; selfClose: boolean } | null {
  const m = /^<(\/)?([A-Za-z][A-Za-z0-9-]*)(?:\s[^>]*)?\s*(\/)?>$/.exec(html.trim())
  if (!m) return null
  return { name: m[2].toLowerCase(), close: !!m[1], selfClose: !!m[3] }
}

function inlines(nodes: AnyNode[], ctx: RenderContext): VNode[] {
  const out: VNode[] = []
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.type === 'html') {
      // Inline raw HTML: only a small, attribute-free set of formatting tags is honoured.
      const tag = parseTag(n.value)
      if (tag && tag.name === 'br' && !tag.close) {
        out.push(el('br'))
        continue
      }
      if (tag && !tag.close && !tag.selfClose && INLINE_HTML_TAGS.has(tag.name)) {
        let depth = 0
        let j = i + 1
        for (; j < nodes.length; j++) {
          const m = nodes[j]
          if (m.type !== 'html') continue
          const t = parseTag(m.value)
          if (!t || t.name !== tag.name) continue
          if (!t.close) depth++
          else if (depth === 0) break
          else depth--
        }
        if (j < nodes.length) {
          out.push(el(tag.name, inlines(nodes.slice(i + 1, j), ctx)))
          i = j
          continue
        }
      }
      continue // other inline HTML is dropped (sanitised away)
    }
    out.push(...inline(n, ctx))
  }
  return out
}

function inline(n: AnyNode, ctx: RenderContext): VNode[] {
  const src = ctx.src
  switch (n.type) {
    case 'text': {
      if (!n.value) return []
      const t = textVNode(n.value, src, start(n), end(n))
      return [ctx.softBreak === 'join' ? joinCjkBreaks(t, src) : t]
    }
    case 'emphasis':
      return [el('em', inlines(n.children as AnyNode[], ctx))]
    case 'strong':
      return [el('strong', inlines(n.children as AnyNode[], ctx))]
    case 'delete':
      return [el('del', inlines(n.children as AnyNode[], ctx))]
    case 'inlineCode': {
      const s = start(n)
      const e = end(n)
      const k = /^`+/.exec(src.slice(s, e))?.[0].length ?? 1
      const t = textVNode(n.value, src, s + k, e - k, true)
      return [el('code', [{ ...t, text: t.text.replace(/\r?\n/g, ' ') }])]
    }
    case 'break':
      return [el('br')]
    case 'link': {
      const kids = inlines(n.children as AnyNode[], ctx)
      return [el('a', kids, { href: safeUrl(n.url), title: n.title ?? undefined, 'data-link': 'external' })]
    }
    case 'linkReference': {
      const def = ctx.definitions.get(n.identifier.toLowerCase())
      const kids = inlines(n.children as AnyNode[], ctx)
      if (!def) return kids
      return [el('a', kids, { href: safeUrl(def.url), title: def.title ?? undefined, 'data-link': 'external' })]
    }
    case 'image':
      return [imgNode(n.url, n.alt ?? '', n.title, start(n))]
    case 'imageReference': {
      const def = ctx.definitions.get(n.identifier.toLowerCase())
      if (!def) return [{ k: 'text', text: src.slice(start(n), end(n)), offs: seq(start(n), end(n) - start(n)) }]
      return [imgNode(def.url, n.alt ?? '', def.title, start(n))]
    }
    case 'footnoteReference':
      return [
        el('sup', [el('a', [{ k: 'text', text: n.label ?? n.identifier, offs: seq(start(n) + 2, (n.label ?? n.identifier).length) }], { href: `#fn-${n.identifier}`, 'data-link': 'footnote' })]),
      ]
    case 'wikiLink': {
      const w = n as WikiLink
      const r = ctx.resolveWiki(w.target)
      const t = textVNode(w.label, src, w.labelRange[0], w.labelRange[1])
      return [el('a', [t], { href: r.href, class: r.exists ? 'wikilink' : 'wikilink missing', 'data-link': 'wiki', 'data-wiki': w.target })]
    }
    default:
      if ('children' in n) return inlines(n.children as AnyNode[], ctx)
      if ('value' in n && typeof n.value === 'string') return [textVNode(n.value, src, start(n as any), end(n as any))]
      return []
  }
}

function imgNode(url: string, alt: string, title: string | null | undefined, at: number): VNode {
  return el('span', [el('img', [], { src: safeUrl(url, true), alt, title: title ?? undefined }), sentinel(at)], { class: 'img-wrap' })
}

export function safeUrl(url: string, image = false): string {
  const u = url.trim()
  if (/^(https?:|mailto:)/i.test(u)) return u
  if (!image && /^(#|\/|\.\/|\.\.\/)/.test(u)) return u
  if (image && /^(\/|\.\/|\.\.\/)/.test(u)) return u
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u // relative path without scheme
  return '#'
}

// ---------------------------------------------------------------- HTML string output

const VOID = new Set(['br', 'hr', 'img', 'input'])

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function toHtmlString(nodes: VNode[], opts: { breaks?: boolean } = {}): string {
  return nodes.map((n) => nodeHtml(n, !!opts.breaks)).join('')
}

function nodeHtml(n: VNode, breaks: boolean): string {
  switch (n.k) {
    case 'text': {
      const t = esc(n.text.replace(/​/g, ''))
      return breaks ? t.replace(/\n/g, '<br>\n') : t
    }
    case 'raw':
      return n.html
    case 'slot':
      return ''
    case 'el': {
      if (n.attrs?.class === 'hr') return '<hr>'
      const attrs = Object.entries(n.attrs ?? {})
        .filter(([k, v]) => v !== undefined && v !== false && !k.startsWith('data-'))
        .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(String(v))}"`))
        .join('')
      const extra = n.tag === 'input' ? ' disabled' : ''
      if (VOID.has(n.tag)) return `<${n.tag}${attrs}${extra}>`
      return `<${n.tag}${attrs}>${toHtmlString(n.children, { breaks: breaks && n.tag !== 'pre' })}</${n.tag}>`
    }
  }
}

/** Convenience: full Markdown → sanitised HTML string (used for rich-text copy). */
export function markdownToHtml(tree: Root, src: string, resolveWiki?: WikiResolver, softBreak: SoftBreak = 'gfm'): string {
  return toHtmlString(renderDocument(tree, makeContext(tree, src, resolveWiki, softBreak)), { breaks: softBreak === 'break' })
}

export type { Parents }
