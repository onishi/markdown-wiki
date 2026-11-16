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

/** A link to add: wrap `label` at offset `at` of the original text as a link to `target`. */
export interface SuggestedLink {
  target: string
  label: string
  at: number
}

/**
 * The links that `suggested` adds relative to `src`, placed on `src` itself: each wraps
 * the first plain occurrence of its label (not inside code, links, URLs or an earlier
 * suggestion).  Nothing else of `suggested` is taken, so stray edits (spacing, rewording)
 * cannot slip in with the links.  Sorted by position.
 */
export function suggestedLinks(src: string, suggested: string): SuggestedLink[] {
  const had = new Set(extractWikiTargets(src))
  const found: { target: string; label: string }[] = []
  walk(parseMarkdown(suggested), (n) => {
    if (n.type !== 'wikiLink') return
    const w = n as WikiLink
    const target = suggested.slice(w.targetRange[0], w.targetRange[1])
    if (had.has(w.target) || found.some((l) => l.target === target)) return
    found.push({ target, label: w.label })
  })
  const masked = maskNoLink(src).split('')
  const out: SuggestedLink[] = []
  for (const l of found) {
    if (!l.label.trim()) continue
    const at = masked.join('').indexOf(l.label)
    if (at < 0) continue
    for (let i = at; i < at + l.label.length; i++) masked[i] = '\u0000'
    out.push({ ...l, at })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Wrap each of `links` (from `suggestedLinks(src, …)`) in `src`. */
export function applyLinks(src: string, links: readonly SuggestedLink[]): string {
  let out = src
  for (const l of [...links].sort((a, b) => b.at - a.at)) {
    if (src.slice(l.at, l.at + l.label.length) !== l.label) continue
    const link = l.label === l.target ? `[[${l.target}]]` : `[[${l.target}|${l.label}]]`
    out = out.slice(0, l.at) + link + out.slice(l.at + l.label.length)
  }
  return out
}

/** Put all the links that `suggested` adds into `src` (see `suggestedLinks`). */
export function applySuggestedLinks(src: string, suggested: string): string {
  return applyLinks(src, suggestedLinks(src, suggested))
}
