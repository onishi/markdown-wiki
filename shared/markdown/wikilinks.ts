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
