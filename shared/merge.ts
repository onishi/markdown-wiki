import { merge } from 'node-diff3'

/** Line-based three-way merge; conflicts are marked with <<<<<<< / ======= / >>>>>>>. */
export function threeWayMerge(base: string, mine: string, theirs: string): { text: string; conflict: boolean } {
  if (mine === theirs) return { text: mine, conflict: false }
  if (base === theirs) return { text: mine, conflict: false }
  if (base === mine) return { text: theirs, conflict: false }
  const r = merge(mine.split('\n'), base.split('\n'), theirs.split('\n'), { label: { a: 'あなたの変更', b: '最新の版' } })
  return { text: r.result.join('\n'), conflict: r.conflict }
}
