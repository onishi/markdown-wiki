/**
 * Enter inside the source editor: continue the construct of the current line.
 *  - blockquote `> `, list markers (`- `, `1.` → `2.`, task `[ ]`), table rows
 *    (a new empty row with the same number of cells)
 *  - on a line that is only the prefix (an empty item / quote line / empty row) the
 *    prefix is removed instead, which ends the construct ("Enter twice to get out")
 * Returns null when a plain newline should be inserted: caret not at the line end,
 * a selection, inside a fenced code block, or an ordinary line.
 */
export type EnterAction = { kind: 'insert'; text: string } | { kind: 'clear'; from: number; to: number }

export function continueOnEnter(text: string, selStart: number, selEnd: number): EnterAction | null {
  if (selStart !== selEnd) return null
  const caret = selStart
  const ls = text.lastIndexOf('\n', caret - 1) + 1
  const nl = text.indexOf('\n', caret)
  const le = nl < 0 ? text.length : nl
  if (text.slice(caret, le).trim() !== '') return null // caret in the middle of the line
  if (insideFence(text, ls)) return null
  const line = text.slice(ls, caret)

  // Table row (incl. the delimiter row): new empty row with the same cell count.
  const t = line.trim()
  if (t.startsWith('|') && t.length > 1 && t.endsWith('|')) {
    const cells = splitRow(t)
    if (cells.length) {
      if (cells.every((c) => c.trim() === '')) return { kind: 'clear', from: ls, to: caret }
      const indent = /^[ \t]*/.exec(line)![0]
      return { kind: 'insert', text: '\n' + indent + '| ' + cells.map(() => '').join(' | ') + ' |' }
    }
  }

  // List item (optionally inside a blockquote).
  const m = /^((?:[ \t]*>[ \t]?)*)([ \t]*)(?:([-+*])|(\d{1,9})([.)]))([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/.exec(line)
  if (m) {
    if (m[8].trim() === '') return { kind: 'clear', from: ls + m[1].length, to: caret }
    const marker = m[3] ?? `${Number(m[4]) + 1}${m[5]}`
    return { kind: 'insert', text: '\n' + m[1] + m[2] + marker + m[6] + (m[7] ? '[ ] ' : '') }
  }

  // Blockquote line.
  const q = /^((?:[ \t]*>[ \t]?)+)(.*)$/.exec(line)
  if (q) {
    if (q[2].trim() === '') return { kind: 'clear', from: ls, to: caret }
    return { kind: 'insert', text: '\n' + q[1] }
  }
  return null
}

function splitRow(row: string): string[] {
  const inner = row.replace(/^\|/, '').replace(/\|$/, '')
  return inner.split(/(?<!\\)\|/)
}

function insideFence(text: string, upTo: number): boolean {
  let open: string | null = null
  for (const line of text.slice(0, upTo).split('\n')) {
    const f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
    if (!f) continue
    if (!open) open = f[1]
    else if (f[1][0] === open[0] && f[1].length >= open.length && /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.test(line)) open = null
  }
  return open !== null
}
