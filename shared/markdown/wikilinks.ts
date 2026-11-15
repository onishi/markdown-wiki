import { parseMarkdown, walk, type WikiLink } from './parse.js'

export function extractWikiTargets(src: string): string[] {
  const out = new Set<string>()
  walk(parseMarkdown(src), (n) => {
    if (n.type === 'wikiLink') out.add((n as WikiLink).target)
  })
  return [...out]
}

/**
 * Rewrite `[[old]]` → `[[new]]` for the given renames, touching only the target text
 * of real wiki links (never inside code).  Labels (`[[old|label]]`) are kept.
 */
export function rewriteWikiLinks(src: string, renames: Map<string, string>): string {
  const edits: { s: number; e: number; text: string }[] = []
  walk(parseMarkdown(src), (n) => {
    if (n.type !== 'wikiLink') return
    const w = n as WikiLink
    const to = renames.get(w.target)
    if (to === undefined) return
    const [s, e] = w.targetRange
    edits.push({ s, e, text: to })
  })
  edits.sort((a, b) => b.s - a.s)
  let out = src
  for (const ed of edits) out = out.slice(0, ed.s) + ed.text + out.slice(ed.e)
  return out
}

/** Replace `[[target|label]]` links for which `drop(target)` holds by their plain label text. */
export function unwrapWikiLinks(src: string, drop: (target: string) => boolean): string {
  const edits: { s: number; e: number; text: string }[] = []
  walk(parseMarkdown(src), (n) => {
    if (n.type !== 'wikiLink') return
    const w = n as WikiLink
    if (!drop(w.target)) return
    edits.push({ s: w.position.start.offset!, e: w.position.end.offset!, text: src.slice(w.labelRange[0], w.labelRange[1]) })
  })
  edits.sort((a, b) => b.s - a.s)
  let out = src
  for (const ed of edits) out = out.slice(0, ed.s) + ed.text + out.slice(ed.e)
  return out
}

/** Parts of a text where a new link must not go: code, existing links, URLs (same length, so offsets hold). */
function maskNoLink(src: string): string {
  return src.replace(/```[\s\S]*?```|`[^`\n]*`|\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/\S+/g, (m) => '\u0000'.repeat(m.length))
}

/**
 * Put the links that `suggested` adds (relative to `src`) into `src` itself: each wraps
 * the first plain occurrence of its label.  Nothing else of `suggested` is taken, so
 * stray edits (spacing, rewording) cannot slip in with the links.
 */
export function applySuggestedLinks(src: string, suggested: string): string {
  const had = new Set(extractWikiTargets(src))
  const links: { target: string; label: string; raw: string }[] = []
  walk(parseMarkdown(suggested), (n) => {
    if (n.type !== 'wikiLink') return
    const w = n as WikiLink
    if (had.has(w.target) || links.some((l) => l.target === w.target)) return
    const raw = suggested.slice(w.targetRange[0], w.targetRange[1])
    links.push({ target: w.target, label: w.label, raw })
  })
  let out = src
  for (const l of links) {
    const at = maskNoLink(out).indexOf(l.label)
    if (at < 0 || !l.label.trim()) continue
    const link = l.label === l.raw ? `[[${l.raw}]]` : `[[${l.raw}|${l.label}]]`
    out = out.slice(0, at) + link + out.slice(at + l.label.length)
  }
  return out
}
