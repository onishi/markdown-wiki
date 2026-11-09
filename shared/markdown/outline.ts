import type { Root } from 'mdast'
import { type AnyNode, type WikiLink, start, walk } from './parse.js'

export interface OutlineItem {
  depth: number
  text: string
  /** Source offset of the heading block. */
  start: number
  /** Source offset of the first character of the heading text (caret target). */
  textStart: number
}

/** Headings of the document (top level and inside containers), in source order. */
export function extractOutline(tree: Root): OutlineItem[] {
  const out: OutlineItem[] = []
  walk(tree, (n) => {
    if (n.type !== 'heading') return
    const kids = n.children as AnyNode[]
    out.push({ depth: n.depth, text: textOf(n).trim() || '（空の見出し）', start: start(n), textStart: kids.length ? start(kids[0]) : start(n) })
    return false
  })
  return out
}

function textOf(n: AnyNode): string {
  if (n.type === 'wikiLink') return (n as WikiLink).label
  if (n.type === 'image' || n.type === 'imageReference') return n.alt ?? ''
  if ('value' in n && typeof n.value === 'string' && (n.type === 'text' || n.type === 'inlineCode')) return n.value
  if (n.type === 'break') return ' '
  if ('children' in n) return (n.children as AnyNode[]).map(textOf).join('')
  return ''
}
