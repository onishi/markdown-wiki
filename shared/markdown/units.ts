import type { Root, ListItem } from 'mdast'
import { type AnyNode, start, end, walk } from './parse.js'

/**
 * An edit unit is the range of *source lines* opened as raw Markdown when editing.
 * It is a UI concept, distinct from GFM blocks:
 *  - paragraph: the source line containing the caret (expanded so that no inline
 *    construct such as `**...**` spanning lines is cut)
 *  - heading: the heading (both lines for setext)
 *  - list: the whole top-level list, or (listMode 'item') the deepest item + children
 *  - table / code block / blockquote / html / others: the whole block
 * Ranges are always whole lines: [lineStart, lineEnd) without the trailing newline.
 */
export type ListMode = 'list' | 'item'

export interface EditUnit {
  start: number
  end: number
  kind: 'block' | 'lines' | 'item' | 'range' | 'empty'
  /** For 'item': start offset of the list item being edited. */
  target: number
  blockIndex: number
}

export function lineStart(src: string, o: number) {
  return src.lastIndexOf('\n', o - 1) + 1
}
export function lineEnd(src: string, o: number) {
  const i = src.indexOf('\n', o)
  return i < 0 ? src.length : i
}

/** Index of the top-level block that should receive a caret at `offset`. */
export function blockIndexAt(tree: Root, offset: number): number {
  const kids = tree.children
  if (kids.length === 0) return -1
  for (let i = 0; i < kids.length; i++) {
    if (offset <= end(kids[i])) return i
  }
  return kids.length - 1
}

export function computeEditUnit(tree: Root, src: string, offset: number, listMode: ListMode = 'list'): EditUnit {
  const bi = blockIndexAt(tree, offset)
  if (bi < 0) return { start: 0, end: src.length, kind: 'empty', target: 0, blockIndex: -1 }
  const node = tree.children[bi] as AnyNode
  const bs = lineStart(src, start(node))
  const be = lineEnd(src, end(node))
  const whole: EditUnit = { start: bs, end: be, kind: 'block', target: start(node), blockIndex: bi }
  const o = Math.min(Math.max(offset, start(node)), end(node))

  if (node.type === 'paragraph') {
    let us = lineStart(src, o)
    let ue = lineEnd(src, o)
    // Expand so that inline constructs crossing line boundaries are fully included.
    let changed = true
    while (changed) {
      changed = false
      walk(node, (n) => {
        if (n === node || n.type === 'text') return
        const s = start(n)
        const e = end(n)
        if ((s < us && e > us) || (s < ue && e > ue)) {
          const ns = Math.min(us, lineStart(src, s))
          const ne = Math.max(ue, lineEnd(src, e))
          if (ns !== us || ne !== ue) {
            us = ns
            ue = ne
            changed = true
          }
        }
        return n.type === 'break' ? false : undefined
      })
    }
    us = Math.max(us, bs)
    ue = Math.min(ue, be)
    if (us === bs && ue === be) return whole
    return { start: us, end: ue, kind: 'lines', target: start(node), blockIndex: bi }
  }

  if (node.type === 'list' && listMode === 'item') {
    let deepest: ListItem | null = null
    walk(node, (n) => {
      if (n.type === 'listItem') {
        if (start(n) <= o && o <= end(n)) deepest = n
        else return false
      }
    })
    const item = deepest as ListItem | null
    if (item) {
      const is = lineStart(src, start(item))
      const ie = lineEnd(src, end(item))
      if (is === bs && ie === be) return whole
      return { start: is, end: ie, kind: 'item', target: start(item), blockIndex: bi }
    }
  }
  return whole
}

/**
 * Edit unit for a selected range [a, b): the union of the units at both ends,
 * widened so that every non-paragraph block it touches is included whole (a list,
 * table or code block is never cut).  Paragraphs may be cut at line boundaries.
 * Returns a normal unit when both ends fall into the same unit.
 */
export function computeRangeUnit(tree: Root, src: string, a: number, b: number, listMode: ListMode = 'list'): EditUnit {
  if (b < a) [a, b] = [b, a]
  const ua = computeEditUnit(tree, src, a, listMode)
  // The end offset is exclusive: a selection ending at a line start belongs to the previous line.
  const ub = computeEditUnit(tree, src, b > a ? Math.max(a, b - 1) : b, listMode)
  if (ua.kind === 'empty' || (ua.start === ub.start && ua.end === ub.end)) return ua
  let start = Math.min(ua.start, ub.start)
  let end = Math.max(ua.end, ub.end)
  tree.children.forEach((n) => {
    const ls = lineStart(src, start_(n))
    const le = lineEnd(src, end_(n))
    if (le < start || ls > end) return
    if (n.type !== 'paragraph') {
      start = Math.min(start, ls)
      end = Math.max(end, le)
    }
  })
  return { start, end, kind: 'range', target: start, blockIndex: Math.min(ua.blockIndex, ub.blockIndex) }
}

const start_ = (n: { position?: { start: { offset?: number } } }) => n.position!.start.offset!
const end_ = (n: { position?: { end: { offset?: number } } }) => n.position!.end.offset!
