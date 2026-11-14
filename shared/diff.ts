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

/** A changed region between two texts: old lines replaced by new lines. */
export interface Hunk {
  id: number
  del: string[]
  add: string[]
}
export type Segment = { same: string[] } | Hunk

/** Split a line diff into unchanged runs and numbered hunks (for picking changes one by one). */
export function diffHunks(before: string, after: string): Segment[] {
  const out: Segment[] = []
  let id = 0
  for (const part of diffComm(before.split('\n'), after.split('\n')) as { common?: string[]; buffer1?: string[]; buffer2?: string[] }[]) {
    if (part.common) out.push({ same: part.common })
    else out.push({ id: id++, del: part.buffer1 ?? [], add: part.buffer2 ?? [] })
  }
  return out
}

/** Rebuild the text taking the new side of `accepted` hunks and the old side of the rest. */
export function applyHunks(segments: Segment[], accepted: ReadonlySet<number>): string {
  const lines: string[] = []
  for (const s of segments) {
    if ('same' in s) lines.push(...s.same)
    else lines.push(...(accepted.has(s.id) ? s.add : s.del))
  }
  return lines.join('\n')
}

/** Character-level diff of two lines, for highlighting what changed inside a line. */
export function charDiff(a: string, b: string): { del: { text: string; changed: boolean }[]; add: { text: string; changed: boolean }[] } {
  if (a.length + b.length > 4000) return { del: [{ text: a, changed: true }], add: [{ text: b, changed: true }] }
  const del: { text: string; changed: boolean }[] = []
  const add: { text: string; changed: boolean }[] = []
  const push = (arr: { text: string; changed: boolean }[], text: string, changed: boolean) => {
    if (!text) return
    const last = arr[arr.length - 1]
    if (last && last.changed === changed) last.text += text
    else arr.push({ text, changed })
  }
  for (const part of diffComm(Array.from(a), Array.from(b)) as { common?: string[]; buffer1?: string[]; buffer2?: string[] }[]) {
    if (part.common) {
      push(del, part.common.join(''), false)
      push(add, part.common.join(''), false)
    } else {
      push(del, (part.buffer1 ?? []).join(''), true)
      push(add, (part.buffer2 ?? []).join(''), true)
    }
  }
  return { del, add }
}
