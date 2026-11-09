import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import type { Nodes, Root, Text } from "mdast"
import { alignText } from './align.js'
import { normalizePageName } from '../pageName.js'

/** Custom inline node for `[[Page name]]` / `[[Page name|label]]` (GFM extension). */
export interface WikiLink {
  type: 'wikiLink'
  /** Normalised page name. */
  target: string
  /** Display label (defaults to the raw target). */
  label: string
  /** Source range of the raw target text (for link rewriting on rename). */
  targetRange: [number, number]
  /** Source range of the displayed label text. */
  labelRange: [number, number]
  position: NonNullable<Text['position']>
  data?: unknown
}

declare module 'mdast' {
  interface PhrasingContentMap {
    wikiLink: WikiLink
  }
  interface RootContentMap {
    wikiLink: WikiLink
  }
}

export type AnyNode = Nodes | WikiLink

export function start(n: { position?: { start: { offset?: number } } }): number {
  return n.position!.start.offset!
}
export function end(n: { position?: { end: { offset?: number } } }): number {
  return n.position!.end.offset!
}

/** Parse the whole document as GFM (+ wiki links). Never line-by-line. */
export function parseMarkdown(src: string): Root {
  const tree = fromMarkdown(src, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  })
  splitWikiLinks(tree, src)
  return tree
}

const WIKI_RE = /\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]+))?\]\]/g

function point(offset: number) {
  return { line: 0, column: 0, offset }
}

/**
 * Replace `[[...]]` inside text nodes with wikiLink nodes.  Only text nodes are
 * considered, so inline code / code blocks are never converted.  Brackets must be
 * literal in the source (escaped `\[\[` does not create a link), which we check via the
 * character alignment rather than searching the source.
 */
function splitWikiLinks(node: any, src: string) {
  if (node.type === 'link' || node.type === 'linkReference') return
  const out: any[] = []
  let changed = false
  for (const child of node.children) {
    if (child.type === 'text' && child.value.includes('[[') && child.position) {
      const pieces = splitText(child, src)
      if (pieces) {
        out.push(...(pieces as any))
        changed = true
        continue
      }
    }
    if ("children" in child) splitWikiLinks(child, src)
    out.push(child as any)
  }
  if (changed) (node as any).children = out
}

function splitText(node: Text, src: string): (Text | WikiLink)[] | null {
  const value = node.value
  const offs = alignText(value, src, start(node), end(node))
  const isLiteral = (i: number, ch: string) => src[offs[i]] === ch && offs[i + 1] === offs[i] + 1
  const result: (Text | WikiLink)[] = []
  let last = 0
  WIKI_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WIKI_RE.exec(value))) {
    const i = m.index
    const e = i + m[0].length
    if (!(isLiteral(i, '[') && isLiteral(i + 1, '[') && isLiteral(e - 2, ']') && isLiteral(e - 1, ']'))) continue
    const target = normalizePageName(m[1])
    if (!target) continue
    if (i > last) result.push(textNode(value.slice(last, i), offs[last], offs[i]))
    const tStart = i + 2
    const tEnd = tStart + m[1].length
    const lStart = m[2] !== undefined ? tEnd + 1 : tStart
    const lEnd = m[2] !== undefined ? lStart + m[2].length : tEnd
    result.push({
      type: 'wikiLink',
      target,
      label: m[2] !== undefined ? m[2] : m[1],
      targetRange: [offs[tStart], offs[tEnd]],
      labelRange: [offs[lStart], offs[lEnd]],
      position: { start: point(offs[i]), end: point(offs[e - 1] + 1) },
    })
    last = e
  }
  if (result.length === 0) return null
  if (last < value.length) result.push(textNode(value.slice(last), offs[last], end(node)))
  return result
}

function textNode(value: string, s: number, e: number): Text {
  return { type: 'text', value, position: { start: point(s), end: point(e) } }
}

/** Depth-first walk with ancestors. Return false from the visitor to skip children. */
export function walk(
  node: AnyNode,
  visit: (n: AnyNode, ancestors: AnyNode[]) => boolean | void,
  ancestors: AnyNode[] = [],
) {
  if (visit(node, ancestors) === false) return
  if ('children' in node) {
    const next = [...ancestors, node]
    for (const c of node.children as AnyNode[]) walk(c, visit, next)
  }
}
