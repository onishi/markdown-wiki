import { diffComm } from 'node-diff3'

export type DiffLine = { kind: 'same' | 'del' | 'add'; text: string; oldNo?: number; newNo?: number } | { kind: 'skip'; count: number }

/**
 * Line diff of two texts for display: unchanged runs longer than 2×context are
 * collapsed into a `skip` entry.
 */
export function lineDiff(before: string, after: string, context = 3): { lines: DiffLine[]; added: number; removed: number } {
  const raw: DiffLine[] = []
  let o = 1
  let n = 1
  let added = 0
  let removed = 0
  for (const part of diffComm(before.split('\n'), after.split('\n')) as { common?: string[]; buffer1?: string[]; buffer2?: string[] }[]) {
    if (part.common) for (const t of part.common) raw.push({ kind: 'same', text: t, oldNo: o++, newNo: n++ })
    else {
      for (const t of part.buffer1 ?? []) (raw.push({ kind: 'del', text: t, oldNo: o++ }), removed++)
      for (const t of part.buffer2 ?? []) (raw.push({ kind: 'add', text: t, newNo: n++ }), added++)
    }
  }
  const lines: DiffLine[] = []
  for (let i = 0; i < raw.length; ) {
    if (raw[i].kind !== 'same') {
      lines.push(raw[i++])
      continue
    }
    let j = i
    while (j < raw.length && raw[j].kind === 'same') j++
    const head = i === 0 ? 0 : context
    const tail = j === raw.length ? 0 : context
    if (j - i > head + tail + 1) {
      lines.push(...raw.slice(i, i + head), { kind: 'skip', count: j - i - head - tail }, ...raw.slice(j - tail, j))
    } else lines.push(...raw.slice(i, j))
    i = j
  }
  return { lines, added, removed }
}

export interface RevisionMeta {
  version: number
  createdAt: number
  length: number
  byName: string | null
  byEmail: string | null
}

/**
 * Autosave makes a revision every few seconds while typing.  For the history list,
 * consecutive revisions by the same person with gaps under `gapMs` form one edit
 * session, represented by its last revision.  Input and output are newest first.
 */
export function groupRevisions(revs: RevisionMeta[], gapMs = 10 * 60 * 1000): { last: RevisionMeta; first: RevisionMeta; count: number }[] {
  const out: { last: RevisionMeta; first: RevisionMeta; count: number }[] = []
  for (const r of revs) {
    const g = out[out.length - 1]
    if (g && g.first.byEmail === r.byEmail && g.first.createdAt - r.createdAt < gapMs && r.version > 1) {
      g.first = r
      g.count++
    } else out.push({ last: r, first: r, count: 1 })
  }
  return out
}
