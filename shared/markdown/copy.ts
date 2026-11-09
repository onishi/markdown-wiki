import type { Root, Definition } from 'mdast'
import { type AnyNode, start, end, walk } from './parse.js'
import { collectDefinitions } from './render.js'
import { lineStart, lineEnd } from './units.js'

/**
 * Markdown for the source range [a, b) selected in display mode.
 *
 * The result is assembled from source pieces: the selected range itself plus the
 * syntax of every construct that is only partially selected (e.g. the `**` of a bold
 * run, the `](url)` of a link, code fences, table header rows).  Original notation is
 * therefore preserved, and a partial selection still forms valid Markdown on its own:
 * selecting part of `**太字**` yields `**字**`-style output.
 */
export function sliceMarkdown(tree: Root, src: string, a: number, b: number): string {
  if (b < a) [a, b] = [b, a]
  if (a === b) return ''
  const pieces: Piece[] = [{ s: a, e: b }]
  const defs = collectDefinitions(tree)
  let leafCount = 0
  let firstLeaf: { node: AnyNode; bq: number } | null = null

  walk(tree as AnyNode, (n, anc) => {
    if (n.type === 'root') return
    const s = start(n)
    const e = end(n)
    if (e <= a || s >= b) return false
    const inside = s >= a && e <= b
    if (isLeafBlock(n)) {
      leafCount++
      if (!firstLeaf) firstLeaf = { node: n, bq: anc.filter((x) => x.type === 'blockquote').length }
    }
    if (inside) return isLeafBlock(n) ? false : undefined
    switch (n.type) {
      case 'emphasis':
      case 'strong':
      case 'delete':
      case 'link': {
        const kids = n.children as AnyNode[]
        if (kids.length) {
          pieces.push({ s, e: start(kids[0]) }, { s: end(kids[kids.length - 1]), e })
        }
        return
      }
      case 'linkReference': {
        const kids = n.children as AnyNode[]
        if (!kids.length) return
        const def: Definition | undefined = defs.get(n.identifier.toLowerCase())
        pieces.push({ s, e: start(kids[0]) })
        if (def) pieces.push({ s: end(kids[kids.length - 1]), e: end(kids[kids.length - 1]), text: `](${def.url}${def.title ? ` "${def.title}"` : ''})` })
        else pieces.push({ s: end(kids[kids.length - 1]), e })
        return
      }
      case 'inlineCode': {
        const k = /^`+/.exec(src.slice(s, e))?.[0].length ?? 1
        pieces.push({ s, e: s + k }, { s: e - k, e })
        return false
      }
      case 'wikiLink':
      case 'image':
      case 'imageReference':
      case 'footnoteReference':
      case 'html':
      case 'break':
        pieces.push({ s, e })
        return false
      case 'code': {
        const fenced = /^[ \t]*(```|~~~)/.test(src.slice(s, s + 10))
        if (fenced) {
          const openEnd = Math.min(e, lineEnd(src, s) + 1)
          pieces.push({ s, e: openEnd })
          const lastLs = lineStart(src, e)
          if (lastLs > s && /^[ \t]*(```+|~~~+)[ \t]*$/.test(src.slice(lastLs, e))) {
            pieces.push({ s: lastLs - 1, e: lastLs - 1, text: '\n' }, { s: lastLs, e })
          }
        }
        return false
      }
      case 'table': {
        const rows = n.children
        const headEnd = lineEnd(src, lineEnd(src, s) + 1)
        pieces.push({ s: lineStart(src, s), e: headEnd }, { s: headEnd, e: headEnd, text: '\n' })
        for (const row of rows.slice(1)) {
          if (end(row) <= a || start(row) >= b) continue
          const rs = lineStart(src, start(row))
          pieces.push({ s: rs - 1, e: rs - 1, text: '\n' }, { s: rs, e: lineEnd(src, end(row)) })
        }
        return false
      }
      case 'heading': {
        // Setext heading: keep the underline.
        const kids = n.children as AnyNode[]
        const last = kids.length ? end(kids[kids.length - 1]) : s
        const ul = lineEnd(src, last)
        if (ul < e && /^[ \t]*(=+|-+)[ \t]*$/.test(src.slice(ul + 1, e))) {
          pieces.push({ s: ul, e })
          leafCount++ // multi-line construct: keep structure
        }
        return
      }
      default:
        return
    }
  })

  // When the selection spans more than one leaf block, keep the container/leaf
  // prefix of the first line (`- `, `> `, `## `, `1. [ ] `) so structure survives.
  const fl = firstLeaf as { node: AnyNode; bq: number } | null
  if (leafCount > 1 && fl) {
    const ls = lineStart(src, a)
    const leaf = fl.node
    let prefixEnd: number
    if (lineStart(src, start(leaf)) === ls) {
      prefixEnd = start(leaf)
      if (leaf.type === 'heading') prefixEnd += /^#{1,6}[ \t]*/.exec(src.slice(prefixEnd))?.[0].length ?? 0
      if (leaf.type === 'code' || leaf.type === 'table') prefixEnd = ls
    } else {
      const re = new RegExp(`^[ \\t]*(?:>[ \\t]?){0,${fl.bq}}[ \\t]*`)
      prefixEnd = ls + (re.exec(src.slice(ls))?.[0].length ?? 0)
    }
    if (prefixEnd > ls && prefixEnd <= a) {
      const prefix = src.slice(ls, prefixEnd)
      if (/\S/.test(prefix)) pieces.push({ s: ls, e: prefixEnd })
    }
  }

  return assemble(pieces, src)
}

interface Piece {
  s: number
  e: number
  text?: string
}

function isLeafBlock(n: AnyNode) {
  return n.type === 'paragraph' || n.type === 'heading' || n.type === 'code' || n.type === 'table' || n.type === 'html' || n.type === 'thematicBreak'
}

function assemble(pieces: Piece[], src: string): string {
  // Source ranges are merged; synthetic text is emitted at its position unless that
  // position is already covered by a source range.
  const ranges = pieces.filter((p) => p.text === undefined && p.e > p.s).sort((x, y) => x.s - y.s)
  const merged: { s: number; e: number }[] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.s <= last.e) last.e = Math.max(last.e, r.e)
    else merged.push({ ...r })
  }
  const covered = (p: number) => merged.some((m) => m.s <= p && p < m.e)
  const synth = pieces.filter((p) => p.text !== undefined && !covered(p.s))
  const events: { at: number; order: number; text: string }[] = [
    ...merged.map((m) => ({ at: m.s, order: 1, text: src.slice(m.s, m.e) })),
    ...synth.map((p) => ({ at: p.s, order: 0, text: p.text! })),
  ]
  // A synthetic piece positioned at the end of a range belongs after it.
  for (const ev of events) {
    if (ev.order === 0 && merged.some((m) => m.e === ev.at)) ev.order = 2
  }
  events.sort((x, y) => x.at - y.at || x.order - y.order)
  const seen = new Set<string>()
  let out = ''
  for (const ev of events) {
    if (ev.order !== 1) {
      const k = `${ev.at}:${ev.text}`
      if (seen.has(k)) continue
      seen.add(k)
      if (ev.text === '\n' && (out === '' || out.endsWith('\n'))) continue
    }
    out += ev.text
  }
  return out
}
