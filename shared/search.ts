/** Full-text search helpers shared by the server (matching, snippets) and the client (highlighting). */

/** Whitespace-separated terms (full-width spaces too), lowercased, duplicates removed. */
export function searchTerms(q: string): string[] {
  const out = new Set<string>()
  for (const t of q.normalize('NFC').toLowerCase().split(/[\s　]+/)) if (t) out.add(t)
  return [...out].slice(0, 8)
}

/** Every term appears in name or content (ASCII case-insensitive, like the sidebar search). */
export function matchesAll(name: string, content: string, terms: string[]): boolean {
  const n = name.toLowerCase()
  const c = content.toLowerCase()
  return terms.every((t) => n.includes(t) || c.includes(t))
}

/** A one-line excerpt of `content` around the first term found (null: no term in the body). */
export function snippet(content: string, terms: string[], before = 30, total = 110): string | null {
  const lower = content.toLowerCase()
  let at = -1
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) return null
  // Start at the line containing the hit, but no more than `before` chars back.
  const lineStart = content.lastIndexOf('\n', at - 1) + 1
  const s = Math.max(lineStart, at - before)
  let text = content.slice(s, s + total).replace(/\s+/g, ' ').trim()
  if (s > lineStart) text = '…' + text
  if (s + total < content.length) text += '…'
  return text
}

/** Split `text` into plain / matched parts for highlighting. */
export function highlightParts(text: string, terms: string[]): { text: string; hit: boolean }[] {
  if (terms.length === 0) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const marks = new Array<boolean>(text.length).fill(false)
  for (const t of terms) {
    for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + 1)) marks.fill(true, i, i + t.length)
  }
  const parts: { text: string; hit: boolean }[] = []
  for (let i = 0; i < text.length; ) {
    let j = i
    while (j < text.length && marks[j] === marks[i]) j++
    parts.push({ text: text.slice(i, j), hit: marks[i] })
    i = j
  }
  return parts
}
