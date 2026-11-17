/**
 * Small source edits behind keyboard shortcuts: ⌘B / ⌘I (wrap in ** / *) and Tab in a
 * table row (next / previous cell).  Pure functions over the source text.
 */

export interface TextEdit {
  /** Replace [from, to) with `text`, then select [selStart, selEnd) (offsets in the new text). */
  from: number
  to: number
  text: string
  selStart: number
  selEnd: number
}

/**
 * Toggle `mark` (`**` bold, `*` italic) around [s, e).  An empty range inserts a pair
 * with the caret inside.  Already wrapped (just outside or just inside the range): unwrap.
 */
export function toggleWrap(src: string, s: number, e: number, mark: '**' | '*'): TextEdit {
  const n = mark.length
  const sel = src.slice(s, e)
  // For italic, `**` next to the range is bold, not a single star.
  const isMark = (at: number) => src.slice(at, at + n) === mark && (n === 2 || (src[at - 1] !== '*' && src[at + 1] !== '*'))
  if (s >= n && isMark(s - n) && isMark(e)) {
    return { from: s - n, to: e + n, text: sel, selStart: s - n, selEnd: e - n }
  }
  if (sel.length >= 2 * n && sel.startsWith(mark) && sel.endsWith(mark) && (n === 2 || !sel.startsWith('**') || sel.startsWith('***'))) {
    const inner = sel.slice(n, sel.length - n)
    return { from: s, to: e, text: inner, selStart: s, selEnd: s + inner.length }
  }
  // Markdown emphasis cannot start or end with a space: keep surrounding spaces outside.
  const lead = /^\s*/.exec(sel)![0].length
  const trail = sel.length > lead ? /\s*$/.exec(sel)![0].length : 0
  const core = sel.slice(lead, sel.length - trail)
  const text = sel.slice(0, lead) + mark + core + mark + sel.slice(sel.length - trail)
  return { from: s, to: e, text, selStart: s + lead + n, selEnd: s + lead + n + core.length }
}

const isRow = (line: string) => /^\s*\|/.test(line)
const isDelimiter = (line: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line)

/** Each cell of a table row line: its trimmed content [a, b) and its whole span between the bars [ra, rb]. */
function cells(line: string): { a: number; b: number; ra: number; rb: number }[] {
  const out: { a: number; b: number; ra: number; rb: number }[] = []
  const bars: number[] = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') i++
    else if (line[i] === '|') bars.push(i)
  }
  for (let k = 0; k + 1 < bars.length; k++) {
    let a = bars[k] + 1
    let b = bars[k + 1]
    while (a < b && line[a] === ' ') a++
    while (b > a && line[b - 1] === ' ') b--
    out.push({ a, b, ra: bars[k] + 1, rb: bars[k + 1] })
  }
  return out
}

/**
 * Tab / Shift+Tab inside a Markdown table row: select the next / previous cell's text
 * (skipping the delimiter row).  Tab in the last cell adds a row.  null: not in a table.
 */
export function tableTab(src: string, pos: number, back: boolean): TextEdit | null {
  const lineStart = src.lastIndexOf('\n', pos - 1) + 1
  const lineEnd = src.indexOf('\n', pos) < 0 ? src.length : src.indexOf('\n', pos)
  const line = src.slice(lineStart, lineEnd)
  if (!isRow(line)) return null
  const lines: { start: number; text: string }[] = []
  // The table: contiguous row lines around the caret.
  let a = lineStart
  while (a > 0) {
    const ps = src.lastIndexOf('\n', a - 2) + 1
    if (!isRow(src.slice(ps, a - 1))) break
    a = ps
  }
  for (let at = a; at <= src.length; ) {
    const end = src.indexOf('\n', at) < 0 ? src.length : src.indexOf('\n', at)
    const text = src.slice(at, end)
    if (!isRow(text)) break
    lines.push({ start: at, text })
    if (end >= src.length) break
    at = end + 1
  }
  const all: [number, number][] = []
  let cur = -1
  for (const l of lines) {
    if (isDelimiter(l.text)) continue
    for (const c of cells(l.text)) {
      if (l.start + c.ra <= pos && pos <= l.start + c.rb) cur = all.length
      all.push([l.start + c.a, l.start + c.b])
    }
  }
  if (!all.length) return null
  if (cur < 0) {
    // Before the first bar or after the last one on this line.
    cur = all.findIndex(([s]) => s >= pos) - 1
    if (cur < -1) cur = all.length - 1
  }
  const target = back ? cur - 1 : cur + 1
  if (target >= 0 && target < all.length) {
    const [s, e] = all[target]
    return { from: s, to: s, text: '', selStart: s, selEnd: e }
  }
  if (back) return { from: pos, to: pos, text: '', selStart: all[0][0], selEnd: all[0][1] }
  // Past the last cell: add an empty row with as many cells as the header.
  const last = lines[lines.length - 1]
  const cols = Math.max(1, cells(lines[0].text).length)
  const end = last.start + last.text.length
  const row = '\n|' + '   |'.repeat(cols)
  return { from: end, to: end, text: row, selStart: end + 3, selEnd: end + 3 }
}

export type LineKind = 'heading' | 'list' | 'task' | 'quote' | 'indent' | 'outdent'

const LIST_MARK = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/
const TASK_MARK = /^(\s*)[-*+]\s+\[[ xX]\]\s+/
const HEADING_MARK = /^(#{1,6})\s+/
const QUOTE_MARK = /^>\s?/

/** One line's new text for a toolbar line action (`all`: every selected line already has it, so remove). */
function relineOne(line: string, kind: LineKind, all: boolean, level: number): string {
  switch (kind) {
    case 'heading': {
      const body = line.replace(HEADING_MARK, '')
      return level ? '#'.repeat(level) + ' ' + body : body
    }
    case 'list':
    case 'task': {
      const indent = /^\s*/.exec(line)![0]
      const body = line.replace(LIST_MARK, '').replace(/^\s*/, '')
      if (all) return indent + body
      return indent + (kind === 'task' ? '- [ ] ' : '- ') + body
    }
    case 'quote':
      return all ? line.replace(QUOTE_MARK, '') : '> ' + line
    case 'indent':
      return '  ' + line
    case 'outdent':
      return line.replace(/^ {1,2}|^\t/, '')
  }
}

/**
 * The phone toolbar's line actions on the lines touched by [s, e): heading (none → ## →
 * ### → none), bullet list, task list and quote (toggled), indent / outdent.
 * The caret keeps its place in the text; a range ends up selecting the whole lines.
 */
export function toggleLines(src: string, s: number, e: number, kind: LineKind): TextEdit {
  const from = src.lastIndexOf('\n', s - 1) + 1
  const endAt = e > s && src[e - 1] === '\n' ? e - 1 : e
  const nl = src.indexOf('\n', endAt)
  const to = nl < 0 ? src.length : nl
  const lines = src.slice(from, to).split('\n')
  const filled = lines.filter((l) => l.trim())
  const has = (l: string) =>
    kind === 'task' ? TASK_MARK.test(l) : kind === 'list' ? /^\s*[-*+]\s+/.test(l) && !TASK_MARK.test(l) : kind === 'quote' ? QUOTE_MARK.test(l) : false
  const all = filled.length > 0 && filled.every(has)
  const cur = HEADING_MARK.exec(lines[0])?.[1].length ?? 0
  const level = cur === 0 ? 2 : cur === 2 ? 3 : 0
  const out = lines.map((l) => (l.trim() || kind === 'quote' ? relineOne(l, kind, all, level) : l))
  const text = out.join('\n')
  if (s === e) {
    // Same position in the line's body.
    const oldBodyStart = lines[0].length - bodyOf(lines[0], kind).length
    const newBodyStart = out[0].length - bodyOf(out[0], kind).length
    const caret = from + Math.max(newBodyStart, s - from - oldBodyStart + newBodyStart)
    return { from, to, text, selStart: caret, selEnd: caret }
  }
  return { from, to, text, selStart: from, selEnd: from + text.length }
}

function bodyOf(line: string, kind: LineKind): string {
  if (kind === 'heading') return line.replace(HEADING_MARK, '')
  if (kind === 'quote') return line.replace(QUOTE_MARK, '')
  if (kind === 'list' || kind === 'task') return line.replace(LIST_MARK, '')
  return line.replace(/^\s*/, '')
}
