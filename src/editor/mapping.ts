import type { Run } from './vdom'

/**
 * Mapping between DOM positions in the rendered document and Markdown source offsets.
 * Every visible character lives in a `span.r[data-r]` whose run holds per-character
 * source offsets, so the mapping is exact (no text search).
 */
export class SourceMap {
  constructor(
    private root: HTMLElement,
    private runs: Run[],
    /** Converts an offset recorded in the runs to a live source offset. */
    private toLive: (o: number) => number = (o) => o,
    private fromLive: (o: number) => number = (o) => o,
  ) {}

  spans(): HTMLElement[] {
    return Array.from(this.root.querySelectorAll<HTMLElement>('span.r[data-r]'))
  }

  private run(span: HTMLElement): Run | undefined {
    return this.runs[Number(span.dataset.r)]
  }

  /** DOM point → live source offset (nearest visible character boundary). */
  domToSource(node: Node, offset: number): number | null {
    if (!this.root.contains(node)) return null
    const parent = node.nodeType === Node.TEXT_NODE ? node.parentElement : null
    if (parent && parent.matches('span.r[data-r]')) {
      const run = this.run(parent)
      if (run) return this.toLive(run.offs[Math.min(offset, run.offs.length - 1)])
    }
    const spans = this.spans()
    if (!spans.length) return null
    // Binary search for the first span at/after the point.
    let lo = 0
    let hi = spans.length
    const range = document.createRange()
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      range.selectNodeContents(spans[mid])
      const cmp = range.comparePoint(node, offset) // -1: point before span
      if (cmp < 0) hi = mid
      else if (cmp > 0) lo = mid + 1
      else {
        const run = this.run(spans[mid])!
        return this.toLive(run.offs[0])
      }
    }
    if (lo < spans.length) return this.toLive(this.run(spans[lo])!.offs[0])
    const last = this.run(spans[spans.length - 1])!
    return this.toLive(last.offs[last.offs.length - 1])
  }

  /** Live source offset → DOM point (text node + offset). */
  sourceToDom(liveOffset: number): { node: Text; offset: number } | null {
    const off = this.fromLive(liveOffset)
    const spans = this.spans()
    let best: { span: HTMLElement; i: number; dist: number } | null = null
    for (const span of spans) {
      const run = this.run(span)
      if (!run) continue
      const o = run.offs
      const s = o[0]
      const e = o[o.length - 1]
      if (s <= off && off <= e) {
        let i = 0
        while (i < o.length - 1 && o[i] < off) i++
        // Prefer a following run that starts exactly here over the end of this one.
        if (i === o.length - 1 && off === e) {
          best = best && best.dist === 0 ? best : { span, i, dist: 0 }
          continue
        }
        return textPoint(span, i)
      }
      const dist = off < s ? s - off : off - e
      if (!best || dist < best.dist || (dist === best.dist && off < s)) {
        best = { span, i: off < s ? 0 : o.length - 1, dist }
      }
    }
    return best ? textPoint(best.span, best.i) : null
  }
}

function textPoint(span: HTMLElement, i: number): { node: Text; offset: number } | null {
  let t = span.firstChild
  if (!t) {
    t = document.createTextNode('')
    span.appendChild(t)
  }
  if (t.nodeType !== Node.TEXT_NODE) return null
  return { node: t as Text, offset: Math.min(i, (t as Text).length) }
}

/** Client rect for a caret at a DOM point. */
export function caretRect(node: Node, offset: number): DOMRect | null {
  const r = document.createRange()
  try {
    r.setStart(node, offset)
    r.collapse(true)
  } catch {
    return null
  }
  const rects = r.getClientRects()
  if (rects.length && rects[0].height > 0) return rects[rects.length - 1]
  if (node.nodeType === Node.TEXT_NODE) {
    const len = (node as Text).length
    if (offset < len) {
      r.setEnd(node, offset + 1)
      const rr = r.getClientRects()[0]
      if (rr) return new DOMRect(rr.left, rr.top, 0, rr.height)
    }
    if (offset > 0) {
      r.setStart(node, offset - 1)
      r.setEnd(node, offset)
      const rr = r.getClientRects()
      const last = rr[rr.length - 1]
      if (last) return new DOMRect(last.right, last.top, 0, last.height)
    }
  }
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  if (el) {
    const b = el.getBoundingClientRect()
    return new DOMRect(b.left, b.top, 0, b.height || 20)
  }
  return null
}

/** DOM point under client coordinates. */
export function pointFromCoords(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y)
    if (p) return { node: p.offsetNode, offset: p.offset }
  }
  if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(x, y)
    if (r) return { node: r.startContainer, offset: r.startOffset }
  }
  return null
}
