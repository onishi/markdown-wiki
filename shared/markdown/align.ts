import { decodeNamedCharacterReference } from 'decode-named-character-reference'

/**
 * Character-level alignment between a parsed text value and the source it came from.
 *
 * The parser (micromark) tells us the source range of each text-bearing node, but the
 * node's value may differ from the raw source: backslash escapes are removed, entity
 * references are decoded, container prefixes (`> `, list indentation) and line
 * indentation are stripped on continuation lines, and inline-code line endings become
 * spaces.  `alignText` walks value and source in lockstep and produces, for every
 * character of `value`, the source offset it came from.  This is purely positional
 * (no string search), so repeated text and decorations are handled correctly.
 *
 * Returns an array of length value.length + 1; the last entry is the source offset
 * just after the last character.
 */
export function alignText(value: string, src: string, start: number, end: number, literal = false): number[] {
  const offs = new Array<number>(value.length + 1)
  let i = 0
  let j = start
  while (i < value.length && j < end) {
    const v = value[i]
    const s = src[j]
    if (!literal && s === '\\' && j + 1 < end && isAsciiPunct(src[j + 1]) && v === src[j + 1]) {
      offs[i++] = j
      j += 2
      continue
    }
    if (!literal && s === '&') {
      const m = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/.exec(src.slice(j, Math.min(end, j + 40)))
      if (m) {
        const decoded = decodeEntity(m[1])
        if (decoded && value.startsWith(decoded, i)) {
          for (let k = 0; k < decoded.length; k++) offs[i + k] = j
          i += decoded.length
          j += m[0].length
          continue
        }
      }
    }
    if (v === s) {
      offs[i++] = j++
      continue
    }
    // Inline code: line endings are converted to spaces.
    if (v === ' ' && (s === '\n' || s === '\r')) {
      offs[i++] = j
      j += s === '\r' && src[j + 1] === '\n' ? 2 : 1
      continue
    }
    // Tabs expanded to spaces (virtual columns): map the spaces onto the tab.
    if (v === ' ' && s === '\t') {
      offs[i++] = j
      if (value[i] !== ' ') j++
      continue
    }
    // CRLF normalised to LF in the value.
    if (v === '\n' && s === '\r') {
      j++
      continue
    }
    // U+0000 is replaced by U+FFFD.
    if (v === '�' && s === '\0') {
      offs[i++] = j++
      continue
    }
    // Source-only character (stripped indentation, container markers, trailing spaces).
    j++
  }
  const tail = i > 0 ? Math.min(Math.max(offs[i - 1] + 1, j), end) : start
  while (i < value.length) offs[i++] = tail
  offs[value.length] = value.length === 0 ? start : literal ? Math.min(end, offs[value.length - 1] + 1) : endOfLastChar(src, offs[value.length - 1], end)
  return offs
}

function endOfLastChar(src: string, lastOff: number, end: number): number {
  // Advance over the source unit that produced the last character.
  const s = src[lastOff]
  if (s === '\\' && lastOff + 1 < end && isAsciiPunct(src[lastOff + 1])) return lastOff + 2
  if (s === '&') {
    const m = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/.exec(src.slice(lastOff, lastOff + 40))
    if (m) return Math.min(end, lastOff + m[0].length)
  }
  return Math.min(end, lastOff + 1)
}

export function isAsciiPunct(c: string | undefined): boolean {
  return c !== undefined && /[!-/:-@[-`{-~]/.test(c)
}

function decodeEntity(body: string): string | false {
  if (body[0] === '#') {
    const hex = body[1] === 'x' || body[1] === 'X'
    const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
    if (!Number.isFinite(code)) return false
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�'
    return String.fromCodePoint(code)
  }
  return decodeNamedCharacterReference(body)
}
