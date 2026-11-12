/** Lower is better; null = no match.  Matching ignores ASCII case (like the sidebar search). */
export function matchScore(name: string, query: string): number | null {
  const n = name.toLowerCase()
  const q = query.toLowerCase().trim()
  if (!q) return 0
  if (n === q) return 0
  const base = n.slice(n.lastIndexOf('/') + 1)
  if (base.startsWith(q)) return 1
  if (n.startsWith(q)) return 2
  const i = n.indexOf(q)
  if (i >= 0) return 3 + i / 1000
  // all words, any order
  const words = q.split(/\s+/)
  if (words.length > 1 && words.every((w) => n.includes(w))) return 5
  // characters in order (fuzzy)
  let at = 0
  for (const ch of q.replace(/\s+/g, '')) {
    at = n.indexOf(ch, at)
    if (at < 0) return null
    at++
  }
  return 8
}

/** Names ranked for a query (score, then the input order, e.g. most recently updated first). */
export function rankNames(names: string[], query: string, limit = 50): string[] {
  return names
    .map((n, i) => ({ n, i, s: matchScore(n, query) }))
    .filter((x): x is { n: string; i: number; s: number } => x.s !== null)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.n)
}
