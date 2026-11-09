/**
 * Vim-like `o` / `O` inside an edit unit: open a new source line below/above the
 * caret's line and return the new text and caret.
 *  - paragraph / heading / rule: a blank line is added so a new paragraph starts
 *  - list: the marker is continued (`- `, `  - [ ] `, `2. `)
 *  - blockquote: `> ` is continued
 *  - code / table / others: a plain new line (keeping indentation)
 */
export type BlockKind = 'paragraph' | 'list' | 'blockquote' | 'code' | 'other'

export function openLine(text: string, caret: number, dir: 'below' | 'above', kind: BlockKind): { text: string; caret: number } {
  const ls = text.lastIndexOf('\n', caret - 1) + 1
  const nl = text.indexOf('\n', caret)
  const le = nl < 0 ? text.length : nl
  const line = text.slice(ls, le)
  const prefix = kind === 'paragraph' ? '' : continuation(line, dir, kind)
  const sep = kind === 'paragraph' ? '\n\n' : '\n'
  if (dir === 'below') {
    const insert = sep + prefix
    return { text: text.slice(0, le) + insert + text.slice(le), caret: le + insert.length }
  }
  return { text: text.slice(0, ls) + prefix + sep + text.slice(ls), caret: ls + prefix.length }
}

function continuation(line: string, dir: 'below' | 'above', kind: BlockKind): string {
  if (kind === 'code') return /^[ \t]*/.exec(line)![0]
  const m = /^((?:[ \t]*>[ \t]?)*)([ \t]*)(?:([-+*])|(\d{1,9})([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/.exec(line)
  if (m && (kind === 'list' || kind === 'blockquote')) {
    const marker = m[3] ?? `${Number(m[4]) + (dir === 'below' ? 1 : 0)}${m[5]}`
    return m[1] + m[2] + marker + m[6] + (m[7] ? '[ ] ' : '')
  }
  const q = /^(?:[ \t]*>[ \t]?)+/.exec(line)
  if (q) return q[0]
  return /^[ \t]*/.exec(line)![0]
}
