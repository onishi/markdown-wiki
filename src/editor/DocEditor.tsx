import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Root } from 'mdast'
import { parseMarkdown } from '../../shared/markdown/parse'
import { makeContext, renderDocument, taskMarkerOffset, type SoftBreak, type WikiResolver } from '../../shared/markdown/render'
import { blockIndexAt, computeEditUnit, computeRangeUnit, type EditUnit, type ListMode } from '../../shared/markdown/units'
import { openLine, type BlockKind } from '../../shared/markdown/openLine'
import { toReact, type Run } from './vdom'
import { SourceMap, caretRect, pointFromCoords } from './mapping'
import { EditCtx, SourceEditor, isImeKey, textareaCaretY, type EditCtxValue } from './SourceEditor'
import { buildPayload, writeClipboard, type CopyFormat } from './clipboard'
import { gestureOf, linkPolicy } from './linkPolicy'

export interface DocEditorProps {
  source: string
  onChange: (src: string) => void
  readOnly?: boolean
  listMode?: ListMode
  /** How newlines inside paragraphs are shown (default: as line breaks). */
  softBreak?: SoftBreak
  /** href + existence for `[[target]]` (in-app). */
  resolveWiki: WikiResolver
  /** Absolute URLs for rich-text copy. */
  absoluteWiki: WikiResolver
  onOpenWiki: (target: string) => void
  onEditingChange?: (editing: boolean) => void
  onReadOnlyAttempt?: () => void
  /** Imperative API (outline jumps). */
  handleRef?: React.MutableRefObject<DocEditorHandle | null>
  /** Page names offered by `[[` completion in the source editor. */
  wikiNames?: string[]
  /** Store a pasted / dropped image and return its URL (no handler: images are not accepted). */
  onUploadImage?: (file: File) => Promise<{ url: string }>
}

export interface DocEditorHandle {
  /** Put the caret at a source offset and scroll its block to the top of the view. */
  jumpTo: (offset: number) => void
}

interface EditState {
  unit: EditUnit
  frozenSrc: string
  frozenTree: Root
  text: string
  initialCaret: number
  /** When editing a selected range: the other end of the selection inside the text. */
  initialSelEnd?: number
}

interface Menu {
  kind: 'selection' | 'context' | 'link' | 'tap'
  x: number
  y: number
  link?: { href: string; wiki?: string; missing?: boolean }
}

/**
 * Display/edit document editor.
 *
 * Display mode: the rendered document is non-editable; the browser selection is the
 * source of truth for caret and ranges (moved with Selection.modify), and a custom
 * caret is painted at its focus.  Every DOM caret position maps to a source offset
 * through the per-character run maps (see SourceMap).
 *
 * Edit mode: the edit unit containing the caret is replaced by a textarea holding its
 * raw Markdown; other blocks keep the rendering made from the full-document parse at
 * the time editing began ("frozen"), so typing a fence or blank line never collapses
 * the editor.  On exit the whole document is re-parsed.
 */
export function DocEditor(props: DocEditorProps) {
  const { source, onChange, readOnly = false, listMode = 'list', softBreak = 'break', resolveWiki } = props
  const rootRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const appendRef = useRef<HTMLButtonElement | null>(null)
  const [edit, setEdit] = useState<EditState | null>(null)
  const editRef = useRef<EditState | null>(null)
  editRef.current = edit
  const [caret, setCaret] = useState<{ x: number; y: number; h: number } | null>(null)
  const [focused, setFocused] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const mouseDown = useRef(false)
  const pending = useRef<{ caret?: number; anchorY?: number; focusDoc?: boolean; top?: boolean; reveal?: boolean } | null>(null)
  const [, forceRender] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 1800)
    return () => clearTimeout(t)
  }, [toast])
  const propsRef = useRef(props)
  propsRef.current = props
  // Sources this editor produced itself; anything else arriving while editing is an
  // external replacement (e.g. conflict resolution) and ends the edit session.
  const emitted = useRef(source)
  const emit = useCallback(
    (s: string) => {
      emitted.current = s
      onChange(s)
    },
    [onChange],
  )
  // Display-mode undo/redo: whole-document snapshots per edit session (the textarea's
  // own undo stack is gone once the session ends).
  const undoStack = useRef<string[]>([])
  const redoStack = useRef<string[]>([])
  if (edit && source !== emitted.current) {
    emitted.current = source
    editRef.current = null
    setEdit(null)
    undoStack.current = []
    redoStack.current = []
  } else if (!edit && source !== emitted.current) {
    // Someone else's text (remote update, conflict resolution, restore): undoing past it
    // would silently drop their change, so history starts over.
    emitted.current = source
    undoStack.current = []
    redoStack.current = []
  }
  const record = (before: string) => {
    undoStack.current.push(before)
    if (undoStack.current.length > 100) undoStack.current.shift()
    redoStack.current = []
  }

  const liveTree = useMemo(() => parseMarkdown(source), [source])
  const tree = edit ? edit.frozenTree : liveTree
  const src = edit ? edit.frozenSrc : source

  const delta = edit ? edit.text.length - (edit.unit.end - edit.unit.start) : 0
  const deltaRef = useRef(0)
  deltaRef.current = delta

  // Render vnodes → React. Independent of the textarea text so typing is cheap.
  const unit = edit?.unit
  const { elements, runs } = useMemo(() => {
    const ctx = makeContext(tree, src, resolveWiki, softBreak)
    if (unit && unit.kind !== 'empty') ctx.replace = { start: unit.start, end: unit.end, kind: unit.kind, target: unit.target }
    const runs: Run[] = []
    const slot = () => <SourceEditor />
    const vnodes = renderDocument(tree, ctx)
    let elements = toReact(vnodes, runs, slot)
    if (unit?.kind === 'empty') elements = [<SourceEditor key="empty" />]
    else if (!vnodes.length) elements = [<p key="ph" className="placeholder">{'空のページです。Enter またはダブルクリックで書き始めましょう。'}</p>]
    return { elements, runs }
  }, [tree, src, unit, resolveWiki, softBreak])

  const map = useCallback(() => {
    const e = editRef.current
    const toLive = (o: number) => (e && o >= e.unit.end ? o + deltaRef.current : o)
    const fromLive = (o: number) => (e && o >= e.unit.end + deltaRef.current ? o - deltaRef.current : o)
    return new SourceMap(rootRef.current!, runs, toLive, fromLive)
  }, [runs])

  // ------------------------------------------------------------ caret painting

  const selectionInDoc = useCallback((): Selection | null => {
    const sel = document.getSelection()
    if (!sel || !sel.focusNode || !rootRef.current?.contains(sel.focusNode)) return null
    if ((sel.focusNode as Element).closest?.('.src-editor') || sel.focusNode.parentElement?.closest('.src-editor')) return null
    return sel
  }, [])

  const paint = useCallback(() => {
    const root = rootRef.current
    const sel = selectionInDoc()
    if (!root || !sel || editRef.current) {
      setCaret(null)
      return
    }
    const r = caretRect(sel.focusNode!, sel.focusOffset)
    if (!r) return setCaret(null)
    const b = root.getBoundingClientRect()
    setCaret({ x: r.left - b.left, y: r.top - b.top, h: r.height || 20 })
    // Link popover when the caret sits inside a link.
    if (linkPolicy.showLinkMenu && sel.isCollapsed && !mouseDown.current) {
      const a = (sel.focusNode!.nodeType === Node.TEXT_NODE ? sel.focusNode!.parentElement : (sel.focusNode as Element))?.closest('a')
      if (a && root.contains(a)) {
        const ar = a.getBoundingClientRect()
        setMenu((m) => (m?.kind === 'context' ? m : { kind: 'link', x: ar.left - b.left, y: ar.bottom - b.top + 4, link: linkInfo(a) }))
        return
      }
    }
    if (!sel.isCollapsed && !mouseDown.current) {
      const range = sel.getRangeAt(0)
      const rects = range.getClientRects()
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect()
      setMenu((m) => (m?.kind === 'context' ? m : { kind: 'selection', x: last.right - b.left, y: last.bottom - b.top + 6 }))
      return
    }
    setMenu((m) => (m?.kind === 'context' || m?.kind === 'tap' ? m : null))
  }, [selectionInDoc])

  useEffect(() => {
    const onSel = () => {
      // The caret really moved elsewhere (late events for the same position don't count).
      const sel = document.getSelection()
      if (atEndRef.current && (sel?.focusNode !== atEndFrom.current[0] || sel?.focusOffset !== atEndFrom.current[1] || !sel?.isCollapsed)) setAtEnd(false)
      paint()
    }
    document.addEventListener('selectionchange', onSel)
    window.addEventListener('resize', onSel)
    return () => {
      document.removeEventListener('selectionchange', onSel)
      window.removeEventListener('resize', onSel)
    }
  }, [paint])

  const focusOffset = useCallback((): number | null => {
    const sel = selectionInDoc()
    if (!sel) return null
    return map().domToSource(sel.focusNode!, sel.focusOffset)
  }, [map, selectionInDoc])

  const selectionRange = useCallback((): [number, number] | null => {
    const sel = selectionInDoc()
    if (!sel || sel.isCollapsed || !sel.anchorNode) return null
    const m = map()
    const a = m.domToSource(sel.anchorNode, sel.anchorOffset)
    const f = m.domToSource(sel.focusNode!, sel.focusOffset)
    if (a == null || f == null) return null
    return [Math.min(a, f), Math.max(a, f)]
  }, [map, selectionInDoc])

  // ------------------------------------------------------------ mode switching

  /** Enter edit mode at a source offset; `open` opens a new line below/above (vim o / O). */
  const startEdit = useCallback(
    (offset: number, open?: 'below' | 'above', rangeEnd?: number) => {
      if (readOnly) {
        propsRef.current.onReadOnlyAttempt?.()
        return
      }
      if (editRef.current) return
      const sel = selectionInDoc()
      const r = sel ? caretRect(sel.focusNode!, sel.focusOffset) : null
      let at = offset
      let kind: BlockKind = 'other'
      if (open && liveTree.children.length) {
        const block = liveTree.children[blockIndexAt(liveTree, offset)]
        const t = block.type
        kind = t === 'list' ? 'list' : t === 'blockquote' ? 'blockquote' : t === 'code' ? 'code' : t === 'table' ? 'other' : 'paragraph'
        // A paragraph reads as one block: open below/above the whole paragraph.
        if (t === 'paragraph') at = open === 'below' ? block.position!.end.offset! : block.position!.start.offset!
      }
      const u = rangeEnd !== undefined && rangeEnd !== at ? computeRangeUnit(liveTree, source, at, rangeEnd, listMode) : computeEditUnit(liveTree, source, at, listMode)
      let text = source.slice(u.start, u.end)
      let caretIn = Math.min(Math.max(at - u.start, 0), text.length)
      // Keep the selected range selected in the source editor.
      const selEndIn = rangeEnd !== undefined ? Math.min(Math.max(rangeEnd - u.start, 0), text.length) : undefined
      if (open && u.kind !== 'empty') {
        const o = openLine(text, caretIn, open, kind)
        text = o.text
        caretIn = o.caret
      }
      pending.current = { anchorY: r?.top }
      setMenu(null)
      const next = { unit: u, frozenSrc: source, frozenTree: liveTree, text, initialCaret: caretIn, initialSelEnd: selEndIn }
      editRef.current = next
      setEdit(next)
      if (text !== source.slice(u.start, u.end)) emit(source.slice(0, u.start) + text + source.slice(u.end))
    },
    [readOnly, liveTree, source, listMode, selectionInDoc, emit],
  )

  const exitEdit = useCallback(
    (caretAt?: number) => {
      const e = editRef.current
      if (!e) return
      const ta = taRef.current
      const composed = e.frozenSrc.slice(0, e.unit.start) + e.text + e.frozenSrc.slice(e.unit.end)
      const c = caretAt ?? e.unit.start + (ta ? ta.selectionEnd : 0)
      pending.current = { caret: c, anchorY: caretAt === undefined && ta ? textareaCaretY(ta) : undefined, focusDoc: true }
      setEdit(null)
      if (composed !== e.frozenSrc) record(e.frozenSrc)
      if (composed !== source) emit(composed)
    },
    [emit, source],
  )

  useEffect(() => {
    props.onEditingChange?.(!!edit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!edit])

  // After a mode switch: restore caret + keep the caret line where it was on screen.
  useLayoutEffect(() => {
    const p = pending.current
    if (!p) return
    pending.current = null
    if (edit) {
      const ta = taRef.current
      if (ta && p.anchorY !== undefined) window.scrollBy(0, textareaCaretY(ta) - p.anchorY)
      return
    }
    const root = rootRef.current!
    if (p.focusDoc) root.focus({ preventScroll: true })
    if (p.caret !== undefined) {
      const pt = map().sourceToDom(p.caret)
      const sel = document.getSelection()
      if (pt && sel) {
        sel.setBaseAndExtent(pt.node, pt.offset, pt.node, pt.offset)
        const r = caretRect(pt.node, pt.offset)
        if (p.top) {
          const block = pt.node.parentElement?.closest('h1, h2, h3, h4, h5, h6, p, li, td, th, pre')
          const top = (block ?? pt.node.parentElement)?.getBoundingClientRect().top ?? r?.top
          if (top !== undefined) window.scrollBy({ top: top - 72, behavior: 'instant' as ScrollBehavior })
        } else if (r && p.anchorY !== undefined) window.scrollBy(0, r.top - p.anchorY)
        else if (r && p.reveal && (r.top < 64 || r.bottom > window.innerHeight - 64)) window.scrollBy({ top: r.top - window.innerHeight / 3, behavior: 'instant' as ScrollBehavior })
      }
    }
    paint()
  })

  if (props.handleRef) {
    props.handleRef.current = {
      jumpTo: (offset: number) => {
        if (editRef.current) {
          exitEdit(offset)
          pending.current = { ...pending.current, caret: offset, focusDoc: true, top: true, anchorY: undefined }
        } else {
          pending.current = { caret: offset, focusDoc: true, top: true }
          forceRender((n) => n + 1)
        }
      },
    }
  }

  // ------------------------------------------------------------ line numbers

  /**
   * Gutter of edit blocks.  Each edit unit (a paragraph line, a whole list / table /
   * code block / quote …) gets a thin bar from the top of its first rendered
   * character to the bottom of its last one; clicking it selects the block.
   * Source line numbers are kept per entry (a..b) for permalinks (#L12-L15) but not shown,
   * so blank lines between blocks don't make the gutter look gappy.
   */
  const [gutter, setGutter] = useState<GutterEntry[]>([])
  const [lineSel, setLineSel] = useState<{ a: number; b: number; y: number } | null>(null)
  const anchors = useRef<{ first: Map<number, [Text, number]>; last: Map<number, [Text, number]> }>({ first: new Map(), last: new Map() })

  const computeGutter = useCallback(() => {
    const root = rootRef.current
    if (!root || editRef.current) return setGutter([])
    const starts = [0]
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1)
    const lineOf = (o: number) => {
      let lo = 0
      let hi = starts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (starts[mid] <= o) lo = mid
        else hi = mid - 1
      }
      return lo
    }
    const first = new Map<number, [Text, number]>()
    const last = new Map<number, [Text, number]>()
    root.querySelectorAll<HTMLElement>('span.r[data-r]').forEach((span) => {
      const run = runs[Number(span.dataset.r)]
      const t = span.firstChild as Text | null
      if (!run || !t || t.nodeType !== Node.TEXT_NODE) return
      for (let i = 0; i < t.length; i++) {
        if (t.data[i] === '\n') continue // soft break: belongs to the previous line's end
        const L = lineOf(run.offs[i])
        if (!first.has(L)) first.set(L, [t, i])
        last.set(L, [t, i])
      }
    })
    anchors.current = { first, last }
    const rootTop = root.getBoundingClientRect().top
    const r = document.createRange()
    const rectOf = ([t, i]: [Text, number]) => {
      r.setStart(t, i)
      r.setEnd(t, Math.min(i + 1, t.length))
      return r.getClientRects()[0] ?? r.getBoundingClientRect()
    }
    const out: (GutterEntry & { unitEnd: number })[] = []
    for (const L of [...first.keys()].sort((x, y) => x - y)) {
      const prev = out[out.length - 1]
      const bottom = rectOf(last.get(L)!).bottom - rootTop
      // Inside the previous block (nested list items, table rows, …): extend it.
      if (prev && L <= prev.unitEnd) {
        prev.b = L + 1
        prev.h = Math.max(prev.h, bottom - prev.y)
        continue
      }
      const u = computeEditUnit(liveTree, source, starts[L], listMode)
      const unitEnd = Math.max(L, lineOf(Math.max(u.start, u.end - 1)))
      let y = rectOf(first.get(L)!).top - rootTop
      let bot = bottom
      // Whole blocks (code, table, quote, list …): span the block's box, not just its text.
      if (u.kind === 'block' || u.kind === 'item') {
        let el: Element | null = first.get(L)![0].parentElement
        if (u.kind === 'item') el = el?.closest('li') ?? null
        else while (el && el.parentElement !== root) el = el.parentElement
        if (el && el !== root) {
          const box = el.getBoundingClientRect()
          y = Math.min(y, box.top - rootTop)
          bot = Math.max(bot, box.bottom - rootTop)
        }
      }
      // Lines sharing a visual row (soft breaks shown as spaces) become one entry.
      if (prev && y < prev.y + prev.h - 4) {
        prev.b = L + 1
        prev.unitEnd = Math.max(prev.unitEnd, unitEnd)
        prev.h = Math.max(prev.h, bottom - prev.y)
        continue
      }
      out.push({ a: L + 1, b: L + 1, y, h: Math.max(bot - y, 4), unitEnd })
    }
    setGutter(out.map(({ unitEnd: _u, ...e }) => e))
  }, [source, runs, liveTree, listMode])

  useLayoutEffect(() => {
    computeGutter()
  }, [computeGutter, edit])
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => computeGutter())
    ro.observe(root)
    return () => ro.disconnect()
  }, [computeGutter])

  /** Select source lines a..b (1-based, inclusive) as a display-mode selection. */
  const selectLines = useCallback(
    (a: number, b: number, opts: { updateUrl?: boolean; scroll?: boolean } = {}) => {
      if (a > b) [a, b] = [b, a]
      const { first, last } = anchors.current
      const keys = [...first.keys()].sort((x, y) => x - y)
      const fa = keys.find((k) => k >= a - 1)
      const lb = [...keys].reverse().find((k) => k <= b - 1)
      if (fa === undefined || lb === undefined || fa > lb) return
      const [t1, i1] = first.get(fa)!
      const [t2, i2] = last.get(lb)!
      const root = rootRef.current!
      root.focus({ preventScroll: true })
      document.getSelection()?.setBaseAndExtent(t1, i1, t2, i2 + 1)
      const entry = gutterRef.current.find((g) => g.a <= fa + 1 && fa + 1 <= g.b)
      setLineSel({ a, b, y: entry ? entry.y + entry.h : 0 })
      if (opts.updateUrl !== false) history.replaceState(history.state, '', lineHash(a, b))
      if (opts.scroll && entry) window.scrollBy({ top: root.getBoundingClientRect().top + entry.y - 96, behavior: 'instant' as ScrollBehavior })
    },
    [],
  )
  const gutterRef = useRef<GutterEntry[]>([])
  gutterRef.current = gutter

  // Open a permalink (#L12 or #L12-L15) once line positions are known.
  const hashHandled = useRef(false)
  useEffect(() => {
    if (hashHandled.current || !gutter.length) return
    hashHandled.current = true
    openLineHash()
  }, [gutter, selectLines])
  function openLineHash() {
    const m = /^#L(\d+)(?:-L(\d+))?$/.exec(location.hash)
    if (m) selectLines(Number(m[1]), Number(m[2] ?? m[1]), { updateUrl: false, scroll: true })
  }
  useEffect(() => {
    const h = () => {
      if (editRef.current) exitEdit()
      setTimeout(openLineHash, 0)
    }
    window.addEventListener('hashchange', h)
    return () => window.removeEventListener('hashchange', h)
  })

  const onGutterMouseDown = (e: React.MouseEvent, g: GutterEntry) => {
    e.preventDefault()
    e.stopPropagation()
    if (editRef.current) exitEdit()
    if (e.shiftKey && lineSel) selectLines(Math.min(lineSel.a, g.a), Math.max(lineSel.b, g.b))
    else selectLines(g.a, g.b)
  }

  const copyPermalink = async () => {
    try {
      await navigator.clipboard.writeText(location.href)
      setToast('行へのリンクをコピーしました')
    } catch {
      setToast('コピーできませんでした')
    }
    setTimeout(() => setToast(null), 1600)
  }

  // ------------------------------------------------------------ keyboard

  /**
   * Selection.modify, but never leaving the document: at the first/last line the
   * caret stays put (no wrap-around, no jump to the line end, no escape into the
   * surrounding page).
   */
  const moveSelection = (sel: Selection, alter: 'move' | 'extend', dir: 'forward' | 'backward', gran: string) => {
    const before = [sel.anchorNode!, sel.anchorOffset, sel.focusNode!, sel.focusOffset] as const
    const topBefore = caretRect(sel.focusNode!, sel.focusOffset)?.top
    sel.modify(alter, dir, gran)
    const f = sel.focusNode
    const el = f && (f.nodeType === Node.TEXT_NODE ? f.parentElement : (f as Element))
    const inside = !!f && !!el && rootRef.current!.contains(f) && !el.closest('.doc-menu, .doc-toast, .caret, .src-editor, .gutter')
    let ok = inside
    if (ok && gran === 'line' && alter === 'move') {
      const topAfter = caretRect(sel.focusNode!, sel.focusOffset)?.top
      // Moved horizontally to the line end instead of to another line → at the edge.
      if (topBefore !== undefined && topAfter !== undefined && Math.abs(topAfter - topBefore) < 2) ok = false
    }
    if (!ok) sel.setBaseAndExtent(before[0], before[1], before[2], before[3])
  }

  const scrollCaretIntoView = () => {
    const sel = selectionInDoc()
    if (!sel) return
    const r = caretRect(sel.focusNode!, sel.focusOffset)
    if (!r) return
    const margin = 48
    if (r.top < margin) window.scrollBy(0, r.top - margin)
    else if (r.bottom > window.innerHeight - margin) window.scrollBy(0, r.bottom - window.innerHeight + margin)
  }

  const ensureSelection = (): Selection | null => {
    const sel = document.getSelection()
    if (!sel) return null
    if (selectionInDoc()) return sel
    const first = rootRef.current?.querySelector('span.r')?.firstChild
    if (first) sel.setBaseAndExtent(first, 0, first, 0)
    return selectionInDoc()
  }

  /**
   * Vertical caret movement by geometry: keep the caret's x (a sticky "goal column"
   * across consecutive vertical moves) and look for the nearest caret position on
   * the next visual line above/below.  Selection.modify('line') walks table cells in
   * DOM order instead, so it cannot be used for up/down inside tables.
   */
  const goalX = useRef<number | null>(null)
  const verticalMove = (sel: Selection, alter: 'move' | 'extend', dir: 1 | -1): boolean => {
    const root = rootRef.current!
    const focus: [Node, number] = [sel.focusNode!, sel.focusOffset]
    let cur = caretRect(focus[0], focus[1])
    if (!cur) return false
    if (cur.top < 0 || cur.bottom > window.innerHeight) {
      window.scrollBy(0, cur.top - window.innerHeight / 2)
      cur = caretRect(focus[0], focus[1])!
    }
    const x = goalX.current ?? cur.left
    let curTop = cur.top
    let y = dir > 0 ? cur.bottom + 2 : cur.top - 2
    for (let i = 0; i < 600; i++) {
      const rb = root.getBoundingClientRect()
      if ((dir > 0 && y > rb.bottom) || (dir < 0 && y < rb.top)) break // document edge: stay
      if (y < 4 || y > window.innerHeight - 4) {
        const before = window.scrollY
        window.scrollBy(0, dir * 120)
        const d = window.scrollY - before
        if (!d) break
        y -= d
        curTop = caretRect(focus[0], focus[1])?.top ?? curTop - d
        continue
      }
      const hit = pointFromCoords(x, y)
      const hitEl = hit && (hit.node.nodeType === Node.TEXT_NODE ? hit.node.parentElement : (hit.node as Element))
      if (hit && hitEl && root.contains(hit.node) && !hitEl.closest('.doc-menu, .doc-toast, .gutter, .src-editor')) {
        const p = caretPoint(hit.node, hit.offset)
        const pr = p && caretRect(p.node, p.offset)
        if (p && pr && (dir > 0 ? pr.top > curTop + 2 : pr.top < curTop - 2)) {
          if (alter === 'extend') sel.extend(p.node, p.offset)
          else sel.collapse(p.node, p.offset)
          goalX.current = x
          return true
        }
      }
      y += dir * 4
    }
    goalX.current = x
    return false
  }

  /**
   * "Below the last line": moving down from the last line parks the caret on a virtual
   * empty line after the document (the 書き足す row) — Enter / i / a / o there start a new
   * paragraph at the end, ↑ goes back.  The source has no trailing line for this.
   */
  const [atEnd, setAtEndState] = useState(false)
  const atEndRef = useRef(false)
  /** Where the real caret was when the virtual line was entered. */
  const atEndFrom = useRef<[Node | null, number]>([null, 0])
  const setAtEnd = (v: boolean) => {
    atEndRef.current = v
    if (v) {
      const sel = document.getSelection()
      atEndFrom.current = [sel?.focusNode ?? null, sel?.focusOffset ?? 0]
    }
    setAtEndState(v)
  }
  const appendAtEnd = () => {
    setAtEnd(false)
    if (liveTree.children.length) startEdit(source.length, 'below')
    else startEdit(0)
  }

  type Move = { dir: 'forward' | 'backward'; gran: 'character' | 'word' | 'line' | 'lineboundary' | 'documentboundary' }
  /** Apply a caret movement in display mode (shared by arrows, vim and emacs keys). */
  const applyMove = (m: Move, extend: boolean) => {
    const sel = ensureSelection()
    if (!sel) return
    const alter = extend ? 'extend' : 'move'
    if (m.gran === 'line') {
      if (!extend && !sel.isCollapsed) {
        if (m.dir === 'backward') sel.collapseToStart()
        else sel.collapseToEnd()
      }
      const moved = verticalMove(sel, alter, m.dir === 'forward' ? 1 : -1)
      if (!moved && !extend && m.dir === 'forward' && !readOnly && sel.isCollapsed) {
        setAtEnd(true)
        setMenu(null)
        requestAnimationFrame(() => appendRef.current?.scrollIntoView({ block: 'nearest' }))
        return
      }
    } else {
      goalX.current = null
      if (!extend && !sel.isCollapsed && m.gran === 'character') {
        // Like text fields: collapse a range to the side of the arrow.
        if (m.dir === 'backward') sel.collapseToStart()
        else sel.collapseToEnd()
      } else moveSelection(sel, alter, m.dir, m.gran)
    }
    setMenu(null)
    scrollCaretIntoView()
  }

  const compEnd = useRef(-1e9)
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (edit || (e.target as Element).closest('.src-editor')) return
    if (isImeKey(e, compEnd.current)) return
    if (atEndRef.current) {
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey
      const macCtrl = /Mac/.test(navigator.platform) && e.ctrlKey && !e.metaKey && !e.altKey
      if (plain && !e.shiftKey && (e.key === 'Enter' || e.key === 'i' || e.key === 'a' || e.key === 'o')) {
        e.preventDefault()
        return appendAtEnd()
      }
      if ((plain && (e.key === 'ArrowDown' || e.key === 'j')) || (macCtrl && e.key === 'n')) {
        e.preventDefault()
        return // already below the last line
      }
      setAtEnd(false)
      if ((plain && (e.key === 'ArrowUp' || e.key === 'k' || e.key === 'Escape')) || (macCtrl && e.key === 'p')) {
        e.preventDefault()
        return // back onto the last line (the caret never left it)
      }
    }
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
    const mod = e.metaKey || e.ctrlKey
    /** App shortcuts (select all, …): Cmd on macOS, Ctrl elsewhere. */
    const cmd = isMac ? e.metaKey : e.ctrlKey
    if (e.key === 'Enter' && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      if (mod) {
        openLinkAtCaret()
        return
      }
      const range = selectionRange()
      if (range) return startEdit(range[0], undefined, range[1])
      const off = focusOffset() ?? (rootRef.current?.querySelector('span.r') ? null : 0)
      if (off != null) startEdit(off)
      return
    }
    if (e.key === 'Escape') {
      setMenu(null)
      const sel = selectionInDoc()
      if (sel && !sel.isCollapsed) sel.collapseToEnd()
      return
    }
    // Undo / redo of whole edit sessions: Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z (Ctrl+Y), and vim's u.
    const z = e.key.toLowerCase() === 'z'
    if ((cmd && !e.altKey && z) || (!isMac && e.ctrlKey && e.key.toLowerCase() === 'y') || (!mod && !e.altKey && e.key === 'u')) {
      e.preventDefault()
      undoRedo((z && e.shiftKey) || (!isMac && e.ctrlKey && e.key.toLowerCase() === 'y'))
      return
    }
    if (cmd && !e.altKey && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      const spans = rootRef.current!.querySelectorAll('span.r')
      const first = spans[0]?.firstChild
      const last = spans[spans.length - 1]?.firstChild as Text | undefined
      if (first && last) document.getSelection()?.setBaseAndExtent(first, 0, last, last.length)
      return
    }

    // Emacs-style movement (macOS: Ctrl is free for this, app shortcuts use Cmd).
    if (isMac && e.ctrlKey && !e.metaKey && !e.altKey) {
      const emacs: Record<string, Move> = {
        a: { dir: 'backward', gran: 'lineboundary' },
        e: { dir: 'forward', gran: 'lineboundary' },
        f: { dir: 'forward', gran: 'character' },
        b: { dir: 'backward', gran: 'character' },
        n: { dir: 'forward', gran: 'line' },
        p: { dir: 'backward', gran: 'line' },
      }
      const m = emacs[e.key.toLowerCase()]
      if (m) {
        e.preventDefault()
        applyMove(m, e.shiftKey)
        return
      }
    }

    // Vim-style keys (display mode = normal mode, edit mode = insert mode).
    if (!mod && !e.altKey && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault()
      openNewLine(e.key === 'o' ? 'below' : 'above')
      return
    }
    if (!mod && !e.altKey && !e.shiftKey) {
      if (e.key === 'i' || e.key === 'a') {
        e.preventDefault()
        const range = selectionRange()
        if (range) return startEdit(range[0], undefined, range[1])
        const sel = ensureSelection()
        if (!sel) {
          if (!rootRef.current?.querySelector('span.r')) startEdit(0)
          return
        }
        const node = sel.focusNode!
        let offset = sel.focusOffset
        // `a` inserts after the character under the caret.
        if (e.key === 'a' && node.nodeType === Node.TEXT_NODE && offset < (node as Text).length) offset++
        const off = map().domToSource(node, offset)
        if (off != null) startEdit(off)
        return
      }
      const vim: Record<string, Move> = {
        h: { dir: 'backward', gran: 'character' },
        l: { dir: 'forward', gran: 'character' },
        j: { dir: 'forward', gran: 'line' },
        k: { dir: 'backward', gran: 'line' },
      }
      if (vim[e.key]) {
        e.preventDefault()
        applyMove(vim[e.key], false)
        return
      }
    }

    // Arrows / Home / End.
    const horizontal = e.altKey || (!isMac && e.ctrlKey) ? 'word' : isMac && e.metaKey ? 'lineboundary' : 'character'
    const keys: Record<string, Move> = {
      ArrowLeft: { dir: 'backward', gran: horizontal },
      ArrowRight: { dir: 'forward', gran: horizontal },
      ArrowUp: { dir: 'backward', gran: isMac && e.metaKey ? 'documentboundary' : 'line' },
      ArrowDown: { dir: 'forward', gran: isMac && e.metaKey ? 'documentboundary' : 'line' },
      Home: { dir: 'backward', gran: e.ctrlKey ? 'documentboundary' : 'lineboundary' },
      End: { dir: 'forward', gran: e.ctrlKey ? 'documentboundary' : 'lineboundary' },
    }
    const m = keys[e.key]
    if (!m) return
    e.preventDefault()
    applyMove(m, e.shiftKey)
  }

  const undoRedo = (redo: boolean) => {
    if (readOnly) return
    const from = redo ? redoStack.current : undoStack.current
    const to = redo ? undoStack.current : redoStack.current
    const next = from.pop()
    if (next === undefined) {
      setToast(redo ? 'やり直す変更はありません' : '取り消す変更はありません')
      return
    }
    to.push(source)
    // Caret at the first changed character, scrolled into view if needed.
    let i = 0
    while (i < next.length && i < source.length && next[i] === source[i]) i++
    pending.current = { caret: i, focusDoc: true, reveal: true }
    emit(next)
    setToast(redo ? 'やり直しました' : '取り消しました')
  }

  const openNewLine = (dir: 'below' | 'above') => {
    if (!liveTree.children.length) return startEdit(0)
    const off = focusOffset() ?? (dir === 'below' ? source.length : 0)
    startEdit(off, dir)
  }

  // ------------------------------------------------------------ mouse

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const target = e.target as Element
    if (target.closest('.src-editor') || target.closest('.doc-menu') || target.closest('.gutter')) return
    setMenu(null)
    setLineSel(null)
    if (atEndRef.current) setAtEnd(false)
    if (target.matches('input[type=checkbox]')) {
      e.preventDefault()
      return
    }
    const pt = pointFromCoords(e.clientX, e.clientY)
    if (edit) {
      // Leave edit mode, placing the caret where the user clicked.
      e.preventDefault()
      const off = pt ? map().domToSource(pt.node, pt.offset) : null
      exitEdit(off ?? undefined)
      return
    }
    const g = gestureOf(e)
    if (g === 'doubleClick' && linkPolicy.doubleClick === 'edit') {
      e.preventDefault()
      const off = pt ? map().domToSource(pt.node, pt.offset) : null
      if (off != null) startEdit(off)
      else if (!rootRef.current?.querySelector('span.r')) startEdit(0)
      return
    }
    // Caret placement and drag selection are handled here rather than natively:
    // natively, pressing on a link focuses the <a> and drops the selection, and
    // pressing inside an existing selection clears it in non-editable content.
    e.preventDefault()
    const root = rootRef.current!
    root.focus({ preventScroll: true })
    const sel = document.getSelection()
    const p = pt && caretPoint(pt.node, pt.offset)
    if (!sel || !p) return
    if (e.shiftKey && selectionInDoc()) sel.extend(p.node, p.offset)
    else sel.collapse(p.node, p.offset)
    goalX.current = null
    mouseDown.current = true
    let lastY = e.clientY
    let lastX = e.clientX
    let raf = 0
    const extendTo = (x: number, y: number) => {
      const q = pointFromCoords(x, y)
      const qp = q && caretPoint(q.node, q.offset)
      if (qp) sel.extend(qp.node, qp.offset)
    }
    const autoscroll = () => {
      const edge = 40
      const dy = lastY < edge ? lastY - edge : lastY > window.innerHeight - edge ? lastY - (window.innerHeight - edge) : 0
      if (dy) {
        window.scrollBy(0, dy / 2)
        extendTo(lastX, Math.min(Math.max(lastY, 1), window.innerHeight - 1))
      }
      raf = requestAnimationFrame(autoscroll)
    }
    raf = requestAnimationFrame(autoscroll)
    const move = (ev: MouseEvent) => {
      lastX = ev.clientX
      lastY = ev.clientY
      extendTo(ev.clientX, ev.clientY)
    }
    const up = () => {
      mouseDown.current = false
      cancelAnimationFrame(raf)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setTimeout(paint, 0)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /** A DOM point usable as a caret: inside a text run, or normalised to the nearest one. */
  const caretPoint = (node: Node, offset: number): { node: Node; offset: number } | null => {
    if (!rootRef.current?.contains(node)) return null
    if (node.nodeType === Node.TEXT_NODE && node.parentElement?.matches('span.r[data-r]')) return { node, offset }
    const m = map()
    const off = m.domToSource(node, offset)
    return off == null ? null : m.sourceToDom(off)
  }

  const lastPointer = useRef('mouse')
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as Element
    if (target.closest('.src-editor') || target.closest('.doc-menu')) return
    if (target.matches('input[type=checkbox][data-task]')) {
      e.preventDefault()
      toggleTask(target as HTMLInputElement)
      return
    }
    const a = target.closest('a')
    if (!a && lastPointer.current === 'touch' && !edit && !readOnly) {
      // Touch: no double-click / keyboard, so a tap offers an 編集 button at the caret.
      if (!rootRef.current?.querySelector('span.r')) return startEdit(0) // empty page: just start
      const sel = selectionInDoc()
      if (sel?.isCollapsed) {
        const r = caretRect(sel.focusNode!, sel.focusOffset)
        const b = rootRef.current!.getBoundingClientRect()
        if (r) setMenu({ kind: 'tap', x: r.left - b.left, y: r.bottom - b.top + 6 })
      }
      return
    }
    if (a && rootRef.current?.contains(a)) {
      e.preventDefault()
      // A drag or Shift+click that made a selection is a selection, not a link click.
      if (e.shiftKey || (selectionInDoc() && !document.getSelection()!.isCollapsed)) return
      const action = linkPolicy[gestureOf(e)]
      if (action === 'open') openLink(linkInfo(a))
      else if (action === 'openNewTab') openLink(linkInfo(a), true)
    }
  }

  const toggleTask = (input: HTMLInputElement) => {
    if (readOnly || edit) return
    const at = Number(input.dataset.task)
    if (!(at >= 0) || source[at] !== '[') return
    const cur = source.slice(at, at + 3)
    const next = /^\[[xX]\]$/.test(cur) ? '[ ]' : /^\[ \]$/.test(cur) ? '[x]' : null
    if (next) {
      record(source)
      emit(source.slice(0, at) + next + source.slice(at + 3))
    }
  }

  const openLink = (l: Menu['link'], newTab = false) => {
    if (!l) return
    setMenu(null)
    if (l.wiki && newTab && l.href && l.href !== '#') window.open(new URL(l.href, location.href).href, '_blank', 'noopener')
    else if (l.wiki) propsRef.current.onOpenWiki(l.wiki)
    else if (l.href && l.href !== '#') {
      if (l.href.startsWith('#')) document.getElementById(l.href.slice(1))?.scrollIntoView()
      else window.open(l.href, '_blank', 'noopener,noreferrer')
    }
  }

  const openLinkAtCaret = () => {
    const sel = selectionInDoc()
    const a = sel?.focusNode?.parentElement?.closest('a')
    if (a) openLink(linkInfo(a))
  }

  // ------------------------------------------------------------ copy

  const payload = () => {
    const r = selectionRange()
    const sel = selectionInDoc()
    if (!r || !sel) return null
    return buildPayload(liveTree, source, r[0], r[1], sel.toString(), props.absoluteWiki, softBreak)
  }

  const onCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (edit || (e.target as Element).closest?.('.src-editor')) return // source copy in edit mode
    const p = payload()
    if (!p) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', p.plain)
    e.clipboardData.setData('text/html', p.html)
  }

  const copyAs = async (f: CopyFormat) => {
    const p = payload()
    setMenu(null)
    if (!p) return
    try {
      await writeClipboard(f, p)
      setToast(f === 'plain' ? 'テキストをコピーしました' : f === 'markdown' ? 'Markdown をコピーしました' : 'リッチテキストをコピーしました')
    } catch {
      setToast('コピーできませんでした')
    }
    setTimeout(() => setToast(null), 1600)
    rootRef.current?.focus({ preventScroll: true })
  }

  /** Open the selected lines in the source editor (same as Enter / i with a selection). */
  const editSelection = () => {
    const range = selectionRange()
    setMenu(null)
    if (range) startEdit(range[0], undefined, range[1])
  }

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    if (edit || (e.target as Element).closest('.src-editor')) return
    const sel = selectionInDoc()
    const a = (e.target as Element).closest('a')
    if ((sel && !sel.isCollapsed) || a) {
      e.preventDefault()
      const b = rootRef.current!.getBoundingClientRect()
      setMenu({ kind: 'context', x: e.clientX - b.left, y: e.clientY - b.top, link: a ? linkInfo(a) : undefined })
    }
  }

  // ------------------------------------------------------------ images

  /**
   * Pasted / dropped images are inserted as `![…](#uploading-…)` placeholders right away
   * (so typing can continue) and swapped for the real URL when the upload finishes —
   * in the source editor if the placeholder is still there, otherwise in the document.
   */
  const pendingFiles = useRef<File[] | null>(null)
  const replacements = useRef(new Map<string, string>())
  const sourceRef = useRef(source)
  sourceRef.current = source

  const applyReplacements = useCallback(() => {
    for (const [token, repl] of [...replacements.current]) {
      const ta = taRef.current
      if (editRef.current && ta) {
        const i = ta.value.indexOf(token)
        if (i >= 0) {
          const [s0, s1] = [ta.selectionStart, ta.selectionEnd]
          const shift = (x: number) => (x >= i + token.length ? x + repl.length - token.length : Math.min(x, i + repl.length))
          ta.focus({ preventScroll: true })
          ta.setSelectionRange(i, i + token.length)
          // execCommand keeps it one native undo step; empty replacement = delete.
          if (!document.execCommand(repl ? 'insertText' : 'delete', false, repl)) continue
          ta.setSelectionRange(shift(s0), shift(s1))
          replacements.current.delete(token)
          continue
        }
        if (editRef.current.frozenSrc.slice(0, editRef.current.unit.start).includes(token) || editRef.current.frozenSrc.slice(editRef.current.unit.end).includes(token))
          continue // outside the block being edited: apply after the edit ends
      }
      const src = sourceRef.current
      if (!editRef.current && src.includes(token)) emit(src.replace(token, repl))
      if (!editRef.current || !src.includes(token)) replacements.current.delete(token)
    }
  }, [emit])
  useEffect(() => applyReplacements(), [edit, source, applyReplacements])

  const imageFiles = (dt: DataTransfer | null) => (dt ? [...dt.files].filter((f) => f.type.startsWith('image/')) : [])

  const insertImages = useCallback(
    (files: File[]) => {
      const upload = propsRef.current.onUploadImage
      const ta = taRef.current
      if (!upload || !ta || !files.length) return
      const items = files.map((f) => {
        const alt = (f.name.replace(/\.[a-z0-9]+$/i, '') || 'image').replace(/[\[\]\n\\]/g, ' ').slice(0, 80)
        return { f, alt, token: `![アップロード中… ${alt}](#uploading-${Math.random().toString(36).slice(2, 10)})` }
      })
      // Each image on a line of its own.
      const before = ta.value.slice(0, ta.selectionStart)
      const after = ta.value.slice(ta.selectionEnd)
      const lead = before && !before.endsWith('\n') ? '\n' : ''
      const trail = after && !after.startsWith('\n') ? '\n' : ''
      document.execCommand('insertText', false, lead + items.map((x) => x.token).join('\n') + trail)
      if (trail) ta.setSelectionRange(ta.selectionStart - 1, ta.selectionStart - 1)
      for (const it of items) {
        upload(it.f)
          .then((r) => replacements.current.set(it.token, `![${it.alt}](${r.url})`))
          .catch((e) => {
            replacements.current.set(it.token, '')
            const code = e?.body?.error
            setToast(code === 'too_large' ? '画像が大きすぎます（10 MB まで）' : code === 'unsupported_type' ? 'この形式の画像は使えません（PNG / JPEG / GIF / WebP / AVIF）' : '画像をアップロードできませんでした')
          })
          .finally(applyReplacements)
      }
    },
    [applyReplacements],
  )

  // Display mode: paste / drop opens a new line below the caret's block and inserts there.
  useEffect(() => {
    if (edit && pendingFiles.current && taRef.current) {
      const f = pendingFiles.current
      pendingFiles.current = null
      insertImages(f)
    }
  }, [edit, insertImages])
  const acceptImages = (files: File[]) => {
    if (!files.length || !props.onUploadImage) return false
    if (readOnly) {
      props.onReadOnlyAttempt?.()
      return true
    }
    pendingFiles.current = files
    openNewLine('below')
    return true
  }
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (edit) return // the source editor handles it
    if (acceptImages(imageFiles(e.clipboardData))) e.preventDefault()
  }
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (props.onUploadImage && e.dataTransfer.types.includes('Files')) e.preventDefault()
  }
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const files = imageFiles(e.dataTransfer)
    if (!files.length || !props.onUploadImage) return
    e.preventDefault()
    if (edit) {
      if ((e.target as Element).closest('.src-editor')) insertImages(files)
      return
    }
    // Put the caret where the files were dropped, then insert below that block.
    const pt = pointFromCoords(e.clientX, e.clientY)
    const p = pt && caretPoint(pt.node, pt.offset)
    if (p) document.getSelection()?.collapse(p.node, p.offset)
    acceptImages(files)
  }

  // ------------------------------------------------------------ edit context

  const editCtx: EditCtxValue | null = useMemo(
    () =>
      edit
        ? {
            text: edit.text,
            initialCaret: edit.initialCaret,
            initialSelEnd: edit.initialSelEnd,
            taRef,
            setText: (t: string) => {
              const e = editRef.current
              if (!e) return
              const next = { ...e, text: t }
              editRef.current = next
              setEdit(next)
              emit(e.frozenSrc.slice(0, e.unit.start) + t + e.frozenSrc.slice(e.unit.end))
            },
            exit: () => exitEdit(),
            onImages: props.onUploadImage ? insertImages : undefined,
            wikiNames: props.wikiNames,
          }
        : null,
    [edit, emit, exitEdit, insertImages, props.onUploadImage, props.wikiNames],
  )

  const hasSelection = menu?.kind === 'context' ? !!selectionRange() : true

  return (
    <EditCtx.Provider value={editCtx}>
      <div
        ref={rootRef}
        className={`doc markdown-body ${edit ? 'is-editing' : 'is-viewing'} ${focused ? 'is-focused' : ''} ${softBreak === 'break' ? 'soft-breaks' : ''}`}
        tabIndex={0}
        role="document"
        aria-label="本文"
        data-testid="doc"
        onKeyDown={onKeyDown}
        onPointerDown={(e) => (lastPointer.current = e.pointerType)}
        onMouseDown={onMouseDown}
        onClick={onClick}
        onCopy={onCopy}
        onPaste={onPaste}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onContextMenu={onContextMenu}
        onFocus={() => {
          setFocused(true)
          paint()
        }}
        onBlur={(e) => {
          if (!rootRef.current?.contains(e.relatedTarget as Node)) setFocused(false)
        }}
        onCompositionEnd={() => {
          compEnd.current = performance.now()
        }}
      >
        {!edit && (
          <div className="gutter" aria-hidden="true" data-testid="gutter">
            {gutter.map((g) => (
              <div
                key={g.a}
                className={`ln ${lineSel && g.b >= lineSel.a && g.a <= lineSel.b ? 'on' : ''}`}
                data-n={g.a}
                data-lines={g.b > g.a ? `${g.a}-${g.b}` : String(g.a)}
                title={`クリックでこのブロックを選択（${g.b > g.a ? `${g.a}–${g.b}` : g.a} 行目）`}
                style={{ top: g.y, height: g.h }}
                onMouseDown={(e) => onGutterMouseDown(e, g)}
              />
            ))}
          </div>
        )}
        {elements}
        {caret && focused && !edit && !atEnd && <div className="caret" data-testid="caret" style={{ left: caret.x, top: caret.y, height: caret.h }} key={`${caret.x},${caret.y}`} />}
        {menu && !edit && (
          <div className={`doc-menu doc-menu-${menu.kind}`} style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.preventDefault()} role="menu">
            {menu.kind === 'link' && menu.link && (
              <>
                <span className="doc-menu-label">{menu.link.wiki ?? menu.link.href}</span>
                <button onClick={() => openLink(menu.link)} role="menuitem">
                  {menu.link.missing ? 'ページを作成' : '開く'}
                </button>
                <span className="doc-menu-hint">リンクはクリックで開きます</span>
              </>
            )}
            {menu.kind === 'tap' && (
              <button
                role="menuitem"
                data-testid="tap-edit"
                onClick={() => {
                  const off = focusOffset() ?? (rootRef.current?.querySelector('span.r') ? null : 0)
                  if (off != null) startEdit(off)
                }}
              >
                編集
              </button>
            )}
            {menu.kind === 'selection' && lastPointer.current === 'touch' && !readOnly && (
              <>
                <button onClick={editSelection} role="menuitem">
                  選択範囲を編集
                </button>
                <span className="doc-menu-sep" />
              </>
            )}
            {lineSel && menu.kind !== 'link' && menu.kind !== 'tap' && (
              <>
                <span className="doc-menu-label">{lineSel.b > lineSel.a ? `L${lineSel.a}–L${lineSel.b}` : `L${lineSel.a}`}</span>
                <button onClick={copyPermalink} role="menuitem" data-testid="copy-permalink">
                  リンクをコピー
                </button>
                <span className="doc-menu-sep" />
              </>
            )}
            {menu.kind === 'context' && hasSelection && !readOnly && (
              <>
                <button onClick={editSelection} role="menuitem" data-testid="edit-selection">
                  選択範囲を編集 <span className="doc-menu-key">Enter</span>
                </button>
                <span className="doc-menu-sep" />
              </>
            )}
            {(menu.kind === 'selection' || (menu.kind === 'context' && hasSelection)) && (
              <>
                {menu.kind === 'context' && <span className="doc-menu-heading">コピー</span>}
                <button onClick={() => copyAs('plain')} role="menuitem" data-testid="copy-plain">
                  テキスト
                </button>
                <button onClick={() => copyAs('markdown')} role="menuitem" data-testid="copy-markdown">
                  Markdown
                </button>
                <button onClick={() => copyAs('rich')} role="menuitem" data-testid="copy-rich">
                  リッチテキスト
                </button>
              </>
            )}
            {menu.kind === 'context' && menu.link && (
              <button onClick={() => openLink(menu.link)} role="menuitem">
                {menu.link.missing ? 'ページを作成' : 'リンクを開く'}
              </button>
            )}
          </div>
        )}
        {toast && <div className="doc-toast" role="status">{toast}</div>}
      </div>
      {!readOnly && !edit && (
        <button
          ref={appendRef}
          className={`doc-append ${atEnd && focused ? 'at-end' : ''}`}
          data-testid="append"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={appendAtEnd}
          title="文書の末尾に新しい段落を書き始めます（最後の行から ↓ でもここに来られます）"
        >
          {atEnd && focused ? (
            <>
              <span className="append-caret" /> <kbd>Enter</kbd> で新しい段落を書き始める <span className="muted">（<kbd>↑</kbd> で戻る）</span>
            </>
          ) : (
            <>
              ＋ 書き足す <span className="muted">（最後の行から <kbd>↓</kbd> / <kbd>o</kbd> で下に新しい行）</span>
            </>
          )}
        </button>
      )}
    </EditCtx.Provider>
  )
}

interface GutterEntry {
  /** First and last 1-based source line of this entry. */
  a: number
  b: number
  y: number
  h: number
}

export function lineHash(a: number, b: number) {
  return b > a ? `#L${a}-L${b}` : `#L${a}`
}

function linkInfo(a: HTMLAnchorElement): Menu['link'] {
  const wiki = a.dataset.wiki
  return { href: a.getAttribute('href') ?? '', wiki, missing: wiki ? a.classList.contains('missing') : false }
}
