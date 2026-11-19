import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Root } from 'mdast'
import { parseMarkdown } from '../../shared/markdown/parse'
import { useHighlighter } from '../highlight'
import { makeContext, renderDocument, taskMarkerOffset, type SoftBreak, type WikiResolver } from '../../shared/markdown/render'
import { blockIndexAt, computeEditUnit, computeRangeUnit, lineEnd as lineEndOf, lineStart as lineStartOf, type EditUnit, type ListMode } from '../../shared/markdown/units'
import { openLine, type BlockKind } from '../../shared/markdown/openLine'
import { tableTab, toggleWrap } from '../../shared/markdown/inline'
import { extractOutline, headingIds } from '../../shared/markdown/outline'
import { copyText } from './copyButtons'
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
  /** Ask the AI about the current selection (offered in the touch selection bar). */
  onAskAi?: () => void
  /** Shown under the 「空のページです」 placeholder (e.g. a button to draft the page with AI). */
  emptyAction?: React.ReactNode
}

export interface DocEditorHandle {
  /** Put the caret at a source offset and scroll its block to the top of the view. */
  jumpTo: (offset: number) => void
  /**
   * The range to work on: in display mode the selection widened to whole edit units
   * (null: nothing selected); while editing, the selected lines of the source editor,
   * or the whole block being edited.
   */
  selectedUnits: () => { start: number; end: number; editing: boolean } | null
  /**
   * Replace the document as one undoable step.  While editing, a change that stays
   * inside the block being edited is typed into the source editor (its own ⌘Z undoes
   * it); otherwise editing ends first and ⌘Z / u in display mode restores the text.
   */
  replaceAll: (next: string) => void
  /** Edit the whole document at once (caret at its start). */
  editAll: () => void
  /** Give the keyboard back to the editor (the source editor while editing). */
  focus: () => void
}

interface EditState {
  unit: EditUnit
  frozenSrc: string
  frozenTree: Root
  text: string
  initialCaret: number
  /** When editing a selected range: the other end of the selection inside the text. */
  initialSelEnd?: number
  /** The source before editing began, when opening it changed the source (o / O). */
  before?: string
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
  const { source, onChange, readOnly = false, listMode = 'list', softBreak = 'break', resolveWiki, emptyAction } = props
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
  const pending = useRef<{ caret?: number; selEnd?: number; anchorY?: number; focusDoc?: boolean; top?: boolean; reveal?: boolean } | null>(null)
  const [, forceRender] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  /** A non-empty selection in the document (touch screens show the selection bar for it). */
  const [hasRange, setHasRange] = useState(false)
  /** Pointer type of the last press: 'touch' gets the tap menu and the selection bar. */
  const lastPointer = useRef('mouse')
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

  const highlight = useHighlighter(source)
  // Render vnodes → React. Independent of the textarea text so typing is cheap.
  const unit = edit?.unit
  const { elements, runs } = useMemo(() => {
    const ctx = makeContext(tree, src, resolveWiki, softBreak, highlight)
    if (unit && unit.kind !== 'empty') ctx.replace = { start: unit.start, end: unit.end, kind: unit.kind, target: unit.target }
    const runs: Run[] = []
    const slot = () => <SourceEditor />
    const vnodes = renderDocument(tree, ctx)
    let elements = toReact(vnodes, runs, slot)
    if (unit?.kind === 'empty') elements = [<SourceEditor key="empty" />]
    else if (!vnodes.length) {
      elements = [<p key="ph" className="placeholder">{'空のページです。Enter またはダブルクリックで書き始めましょう。'}</p>]
      if (emptyAction)
        elements.push(
          // Outside the caret / click handling of the document.
          <div key="ph-act" className="empty-action" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            {emptyAction}
          </div>,
        )
    }
    return { elements, runs }
  }, [tree, src, unit, resolveWiki, softBreak, highlight, emptyAction])

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
    setHasRange(!!sel && !sel.isCollapsed && !editRef.current)
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
    (offset: number, open?: 'below' | 'above', rangeEnd?: number, caretAt?: number) => {
      if (readOnly) {
        propsRef.current.onReadOnlyAttempt?.()
        return
      }
      if (editRef.current) return
      const sel = selectionInDoc()
      const r = sel ? caretRect(sel.focusNode!, sel.focusOffset) : null
      // o / O: a new, empty block below / above the caret's block; the block itself is not opened.
      if (open && liveTree.children.length && rangeEnd === undefined) {
        const block = liveTree.children[blockIndexAt(liveTree, offset)]
        const p = open === 'below' ? lineEndOf(source, block.position!.end.offset!) : lineStartOf(source, block.position!.start.offset!)
        const src2 = source.slice(0, p) + '\n\n' + source.slice(p)
        const at2 = open === 'below' ? p + 2 : p
        const u: EditUnit = { start: at2, end: at2, kind: 'insert', target: p, blockIndex: -1 }
        pending.current = { anchorY: r?.top }
        setMenu(null)
        const next: EditState = { unit: u, frozenSrc: src2, frozenTree: parseMarkdown(src2), text: '', initialCaret: 0, before: source }
        editRef.current = next
        setEdit(next)
        emit(src2)
        return
      }
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
      let selEndIn = rangeEnd !== undefined ? Math.min(Math.max(rangeEnd - u.start, 0), text.length) : undefined
      // A caret instead of the range selected (touch: the first key typed would replace it all).
      if (caretAt !== undefined) [caretIn, selEndIn] = [Math.min(Math.max(caretAt - u.start, 0), text.length), undefined]
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
      let composed = e.frozenSrc.slice(0, e.unit.start) + e.text + e.frozenSrc.slice(e.unit.end)
      let c = caretAt ?? e.unit.start + (ta ? ta.selectionEnd : 0)
      if (e.unit.kind === 'insert' && !e.text.trim()) {
        // The new block stayed empty: nothing is added.
        composed = e.before ?? e.frozenSrc
        c = caretAt ?? Math.min(e.unit.target, composed.length)
      }
      pending.current = { caret: c, anchorY: caretAt === undefined && ta ? textareaCaretY(ta) : undefined, focusDoc: true }
      setEdit(null)
      const base = e.before ?? e.frozenSrc
      if (composed !== base) record(base)
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
        const to = p.selEnd !== undefined ? map().sourceToDom(p.selEnd) : null
        sel.setBaseAndExtent(pt.node, pt.offset, to?.node ?? pt.node, to?.offset ?? pt.offset)
        const r = caretRect(pt.node, pt.offset)
        if (p.top) {
          const block = pt.node.parentElement?.closest('h1, h2, h3, h4, h5, h6, p, li, td, th, pre')
          const top = (block ?? pt.node.parentElement)?.getBoundingClientRect().top ?? r?.top
          if (top !== undefined) window.scrollBy({ top: top - 72, behavior: 'instant' as ScrollBehavior })
        } else if (r && p.anchorY !== undefined) window.scrollBy(0, r.top - p.anchorY)
        else if (r && p.reveal && (r.top < 80 || r.bottom > window.innerHeight - 64)) window.scrollBy({ top: r.top - window.innerHeight / 3, behavior: 'instant' as ScrollBehavior })
      }
    }
    paint()
  })

  if (props.handleRef) {
    props.handleRef.current = {
      editAll: () => editSection(0, source.length, 0),
      jumpTo: (offset: number) => {
        if (editRef.current) {
          exitEdit(offset)
          pending.current = { ...pending.current, caret: offset, focusDoc: true, top: true, anchorY: undefined }
        } else {
          pending.current = { caret: offset, focusDoc: true, top: true }
          forceRender((n) => n + 1)
        }
      },
      selectedUnits: () => {
        const e = editRef.current
        if (e) {
          const ta = taRef.current
          let a = 0
          let b = e.text.length
          if (ta && ta.selectionStart < ta.selectionEnd) {
            // Whole lines of the selection: the AI rewrites sentences, not fragments.
            a = e.text.lastIndexOf('\n', ta.selectionStart - 1) + 1
            const nl = e.text.indexOf('\n', ta.selectionEnd - (e.text[ta.selectionEnd - 1] === '\n' ? 1 : 0))
            b = nl < 0 ? e.text.length : nl
          }
          return b > a ? { start: e.unit.start + a, end: e.unit.start + b, editing: true } : null
        }
        const r = selectionRange()
        if (!r) return null
        const u = computeRangeUnit(liveTree, source, r[0], r[1], listMode)
        return u.end > u.start ? { start: u.start, end: u.end, editing: false } : null
      },
      replaceAll: (next: string) => {
        if (next === source) return
        let i = 0
        while (i < next.length && i < source.length && next[i] === source[i]) i++
        const e = editRef.current
        if (e) {
          let j = 0
          while (j < next.length - i && j < source.length - i && next[next.length - 1 - j] === source[source.length - 1 - j]) j++
          const from = i - e.unit.start
          const to = source.length - j - e.unit.start
          const ta = taRef.current
          if (ta && from >= 0 && to <= e.text.length) {
            ta.focus()
            ta.setSelectionRange(from, to)
            const ins = next.slice(i, next.length - j)
            // execCommand keeps it one native undo step; fall back to a plain update.
            const ok = ins ? document.execCommand('insertText', false, ins) : document.execCommand('delete')
            if (!ok || ta.value !== e.text.slice(0, from) + ins + e.text.slice(to)) editCtxRef.current?.setText(e.text.slice(0, from) + ins + e.text.slice(to))
            return
          }
          // The change reaches outside the block: finish editing, then replace.
          editRef.current = null
          setEdit(null)
          if (source !== (e.before ?? e.frozenSrc)) record(e.before ?? e.frozenSrc)
        }
        record(source)
        pending.current = { caret: i, focusDoc: true, reveal: true }
        emit(next)
      },
      focus: () => {
        if (editRef.current) taRef.current?.focus()
        else rootRef.current?.focus({ preventScroll: true })
      },
    }
  }

  // ------------------------------------------------------------ section editing

  /** Edit [start, end) as one range, caret at `caret` (ends the current edit first). */
  const editSection = (start: number, end: number, caret: number) => {
    if (readOnly) return propsRef.current.onReadOnlyAttempt?.()
    if (editRef.current) {
      exitEdit()
      setTimeout(() => propsRef.current.handleRef?.current && editSectionRef.current(start, end, caret), 0)
      return
    }
    setMenu(null)
    setLineSel(null)
    if (!source.trim()) return startEdit(0)
    startEdit(start, undefined, Math.max(start + 1, end), caret)
  }
  const editSectionRef = useRef(editSection)
  editSectionRef.current = editSection

  /** Top-level headings: where their 編集 button goes, and the section each one heads. */
  const sections = useMemo(() => {
    const hs = liveTree.children.flatMap((n) => (n.type === 'heading' ? [{ depth: (n as { depth: number }).depth, start: n.position!.start.offset!, end: n.position!.end.offset! }] : []))
    return hs.map((h, i) => {
      const next = hs.slice(i + 1).find((x) => x.depth <= h.depth)
      let end = next ? next.start : source.length
      while (end > h.start && /\s/.test(source[end - 1])) end--
      return { start: h.start, headEnd: h.end, end }
    })
  }, [liveTree, source])
  const [headButtons, setHeadButtons] = useState<{ x: number; y: number; h: number }[]>([])
  /** `#見出し名` ids of every heading, by source offset. */
  const headIds = useMemo(() => {
    const items = extractOutline(liveTree)
    const ids = headingIds(items)
    return new Map(items.map((h, i) => [h.start, ids[i]]))
  }, [liveTree])
  const headIdsRef = useRef(headIds)
  headIdsRef.current = headIds
  /** Copy buttons: top-right corner of each code block. */
  const [codeButtons, setCodeButtons] = useState<{ x: number; y: number }[]>([])

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
    // 編集 buttons right after each top-level heading's text.
    const hs = [...root.children].filter((el) => /^H[1-6]$/.test(el.tagName))
    setHeadButtons(
      hs.map((el) => {
        const rr = document.createRange()
        rr.selectNodeContents(el)
        const rects = rr.getClientRects()
        const last = rects[rects.length - 1] ?? el.getBoundingClientRect()
        const box = el.getBoundingClientRect()
        // A heading reaching the right edge: keep the button inside the page.
        // Headings keep room on the right (CSS padding), so the buttons fit after the last line.
        const line = rects.length ? last : box
        return { x: last.right - root.getBoundingClientRect().left, y: line.top - rootTop, h: line.height }
      }),
    )
    const rootLeft = root.getBoundingClientRect().left
    setCodeButtons(
      [...root.querySelectorAll('pre')].map((pre) => {
        const b = pre.getBoundingClientRect()
        return { x: b.right - rootLeft, y: b.top - rootTop }
      }),
    )
  }, [source, runs, liveTree, listMode, readOnly])

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
    if (m) return selectLines(Number(m[1]), Number(m[2] ?? m[1]), { updateUrl: false, scroll: true })
    // #見出し名: scroll to that heading.
    let id = ''
    try {
      id = decodeURIComponent(location.hash.slice(1))
    } catch {
      return
    }
    if (!id) return
    for (const [at, hid] of headIdsRef.current) {
      if (hid !== id) continue
      rootRef.current?.querySelector(`[data-h="${at}"]`)?.scrollIntoView()
      return
    }
  }
  const copyHeadingLink = async (at: number, el: HTMLElement) => {
    const id = headIdsRef.current.get(at)
    if (!id) return
    const hash = `#${encodeURIComponent(id)}`
    history.replaceState(history.state, '', hash)
    await copyText(location.origin + location.pathname + hash, el)
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
    const sel = selectionInDoc()
    const live = lineSel && sel && !sel.isCollapsed
    if (live && lastPointer.current === 'touch') {
      // Touch (no Shift): tapping more bars adds their blocks; tapping the only selected one clears.
      if (g.a === lineSel.a && g.b === lineSel.b) clearSelection()
      else selectLines(Math.min(lineSel.a, g.a), Math.max(lineSel.b, g.b))
    } else if (e.shiftKey && lineSel) selectLines(Math.min(lineSel.a, g.a), Math.max(lineSel.b, g.b))
    else selectLines(g.a, g.b)
  }

  const clearSelection = () => {
    document.getSelection()?.removeAllRanges()
    setHasRange(false)
    setLineSel(null)
    setMenu(null)
  }

  /** Touch selection bar: take in the block above / below. */
  const growSelection = (dir: -1 | 1) => {
    if (!lineSel) return
    const gs = gutterRef.current
    const g = dir < 0 ? [...gs].reverse().find((x) => x.b < lineSel.a) : gs.find((x) => x.a > lineSel.b)
    if (!g) return
    selectLines(Math.min(lineSel.a, g.a), Math.max(lineSel.b, g.b))
    const root = rootRef.current!.getBoundingClientRect()
    const top = root.top + g.y
    if (top < 60 || top + g.h > window.innerHeight - 140) window.scrollBy({ top: dir < 0 ? top - 80 : top + g.h - window.innerHeight + 160, behavior: 'smooth' })
  }

  /** Touch tap menu: select the block the caret is in. */
  const selectBlockAtCaret = () => {
    const off = focusOffset()
    if (off == null) return
    const line = source.slice(0, off).split('\n').length
    const g = gutterRef.current.find((x) => x.a <= line && line <= x.b) ?? [...gutterRef.current].reverse().find((x) => x.a <= line)
    setMenu(null)
    if (g) selectLines(g.a, g.b)
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
    const top = 72 // below the sticky page header
    if (r.top < top) window.scrollBy(0, r.top - top)
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
    // Shift+Enter: the section under the caret, from its heading (like the heading's 編集 button).
    if (e.key === 'Enter' && e.shiftKey && !e.altKey && !mod) {
      e.preventDefault()
      if (!liveTree.children.length) return startEdit(0)
      const range = selectionRange()
      const off = focusOffset()
      if (!range && off == null) return
      const [a, b] = range ?? [off!, off!]
      const sec = [...sections].reverse().find((x) => x.start <= a)
      // Before the first heading: from the top of the page to that heading.
      const firstHead = sections[0]?.start ?? source.length
      let s0 = sec ? sec.start : 0
      let e0 = sec ? sec.end : firstHead
      while (e0 > s0 && /\s/.test(source[e0 - 1])) e0--
      e0 = Math.max(e0, b)
      if (!sec) s0 = Math.min(s0, a)
      editSection(s0, Math.max(s0 + 1, e0), Math.min(Math.max(off ?? a, s0), e0))
      return
    }
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

    // ⌘B / ⌘I: bold / italic around the selected text (same as in edit mode).
    if (cmd && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === 'b' || e.key.toLowerCase() === 'i')) {
      e.preventDefault()
      if (readOnly) return
      const range = selectionRange()
      if (!range || source.slice(range[0], range[1]).includes('\n')) {
        setToast(range ? '1 つの段落の中で選んでください' : '文字を選んでから押してください')
        return
      }
      const ed = toggleWrap(source, range[0], range[1], e.key.toLowerCase() === 'b' ? '**' : '*')
      record(source)
      pending.current = { caret: ed.selStart, selEnd: ed.selEnd, focusDoc: true }
      emit(source.slice(0, ed.from) + ed.text + source.slice(ed.to))
      return
    }
    // Tab / Shift+Tab in a table: next / previous cell.
    if (e.key === 'Tab' && !mod && !e.altKey) {
      const off = focusOffset()
      const ed = off == null ? null : tableTab(source, off, e.shiftKey)
      if (ed) {
        e.preventDefault()
        if (ed.text) return // past the last cell: rows are added in edit mode
        const m = map()
        const a = m.sourceToDom(ed.selStart)
        const b = m.sourceToDom(ed.selEnd)
        if (a && b) {
          document.getSelection()?.setBaseAndExtent(a.node, a.offset, b.node, b.offset)
          scrollCaretIntoView()
        } else startEdit(ed.selStart) // an empty cell has no text to put the caret in
        return
      }
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

  /**
   * Keys pressed while nothing in particular has focus (the page was just opened, or a
   * sidebar link was clicked): the document takes them, starting from its first line on
   * screen, so hjkl / arrows / Enter work without clicking into the text first.
   */
  const onKeyDownRef = useRef(onKeyDown)
  onKeyDownRef.current = onKeyDown
  useEffect(() => {
    const KEYS = new Set(['h', 'j', 'k', 'l', 'i', 'a', 'o', 'O', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])
    const h = (e: KeyboardEvent) => {
      const root = rootRef.current
      if (!root || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || editRef.current) return
      if (!KEYS.has(e.key) || (e.shiftKey && e.key !== 'O' && e.key !== 'Enter')) return
      const a = document.activeElement
      if (a && a !== document.body) {
        // Only from a link / button outside the document (not from fields, menus, dialogs).
        if (root.contains(a) || !a.matches('a, button') || a.closest('.modal-back, [role=menu], [role=dialog]')) return
        if (e.key === 'Enter') return // Enter belongs to the focused link / button
      }
      if (document.querySelector('.modal-back')) return
      const first = firstVisibleText(root)
      if (!first) return
      e.preventDefault()
      root.focus({ preventScroll: true })
      document.getSelection()?.setBaseAndExtent(first, 0, first, 0)
      onKeyDownRef.current({ ...e, key: e.key, shiftKey: e.shiftKey, metaKey: false, ctrlKey: false, altKey: false, target: root, nativeEvent: e, preventDefault: () => {} } as unknown as React.KeyboardEvent<HTMLDivElement>)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

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
      // Keep the keyboard on the document (⌘Z right after toggling a task).
      e.preventDefault()
      rootRef.current?.focus({ preventScroll: true })
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

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as Element
    if (target.closest('.src-editor') || target.closest('.doc-menu')) return
    if (target.matches('input[type=checkbox][data-task]')) {
      // No preventDefault: on a checkbox it makes the browser revert the box *after*
      // React has re-rendered it, so the new state never shows.  The input is
      // controlled, so React puts it back to the source's state if nothing changes.
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
    if (range) startEdit(range[0], undefined, range[1], lastPointer.current === 'touch' ? range[1] : undefined)
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

  const editCtxRef = useRef(editCtx)
  editCtxRef.current = editCtx

  const hasSelection = menu?.kind === 'context' ? !!selectionRange() : true
  const touchUi = lastPointer.current === 'touch'

  return (
    <EditCtx.Provider value={editCtx}>
      <div
        ref={rootRef}
        className={`doc markdown-body ${readOnly ? 'head-room-ro' : 'head-room'} ${edit ? 'is-editing' : 'is-viewing'} ${focused ? 'is-focused' : ''} ${softBreak === 'break' ? 'soft-breaks' : ''}`}
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
        {!edit && headButtons.length === sections.length && (
          <div className="head-edits" data-testid="head-edits">
            {sections.map((sec, i) => (
              <div key={sec.start} className="head-tools" style={{ left: headButtons[i].x + 6, top: headButtons[i].y, height: headButtons[i].h }}>
              {!readOnly && <button
                className="head-edit"
                title="この見出しの節（次の同じレベルの見出しまで）を編集"
                aria-label="この節を編集"
                data-testid="head-edit"
                tabIndex={-1}
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  editSection(sec.start, sec.end, sec.headEnd)
                }}
              >
                <span>編集</span>
              </button>}
              <button
                className="head-edit head-link"
                title="この見出しへのリンクをコピー"
                aria-label="この見出しへのリンクをコピー"
                data-testid="head-link"
                tabIndex={-1}
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  copyHeadingLink(sec.start, e.currentTarget)
                }}
              >
                <span>🔗</span>
              </button>
              </div>
            ))}
          </div>
        )}
        {!edit && codeButtons.length > 0 && (
          <div className="head-edits">
            {codeButtons.map((c, i) => (
              <button
                key={i}
                className="code-copy"
                style={{ left: c.x, top: c.y }}
                title="コードをコピー"
                data-testid="code-copy"
                tabIndex={-1}
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  copyText(rootRef.current?.querySelectorAll('pre')[i]?.textContent ?? '', e.currentTarget)
                }}
              >
                <span>コピー</span>
              </button>
            ))}
          </div>
        )}
        {elements}
        {caret && focused && !edit && !atEnd && <div className="caret" data-testid="caret" style={{ left: caret.x, top: caret.y, height: caret.h }} key={`${caret.x},${caret.y}`} />}
        {menu && !edit && !(touchUi && menu.kind === 'selection') && (
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
            {menu.kind === 'tap' && (
              <button role="menuitem" data-testid="tap-select" onClick={selectBlockAtCaret}>
                選択
              </button>
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
      {touchUi && hasRange && !edit && (
        <div className="sel-bar" data-testid="sel-bar" role="toolbar" aria-label="選択範囲" onMouseDown={(e) => e.preventDefault()}>
          <div className="sel-bar-head">
            <span className="grow" title="左の線をタップすると、そのブロックまで選択を広げます">
              {lineSel ? `${gutter.filter((g) => g.b >= lineSel.a && g.a <= lineSel.b).length} ブロックを選択` : 'テキストを選択'}
            </span>
            {lineSel && (
              <>
                <button onClick={() => growSelection(-1)} aria-label="上のブロックも選択" title="上のブロックも選択" data-testid="sel-up">
                  ↑
                </button>
                <button onClick={() => growSelection(1)} aria-label="下のブロックも選択" title="下のブロックも選択" data-testid="sel-down">
                  ↓
                </button>
              </>
            )}
            <button onClick={clearSelection} aria-label="選択を解除" title="選択を解除" data-testid="sel-clear">
              ✕
            </button>
          </div>
          <div className="sel-bar-actions">
            {!readOnly && (
              <button className="primary" onClick={editSelection} data-testid="sel-edit">
                編集
              </button>
            )}
            {!readOnly && props.onAskAi && (
              <button onClick={() => props.onAskAi!()} data-testid="sel-ai">
                AI
              </button>
            )}
            <button onClick={() => copyAs('plain')} data-testid="sel-copy">
              コピー
            </button>
            <button onClick={() => copyAs('markdown')} data-testid="sel-copy-md">
              Markdown
            </button>
            {lineSel && (
              <button onClick={copyPermalink} data-testid="sel-permalink">
                リンク
              </button>
            )}
          </div>
        </div>
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

/** The first rendered text of the document that is on screen (else the very first one). */
function firstVisibleText(root: HTMLElement): Text | null {
  const spans = [...root.querySelectorAll('span.r')]
  const top = 56 // below the sticky header
  for (const sp of spans) {
    if (sp.closest('.src-editor')) continue
    const r = sp.getBoundingClientRect()
    if (r.bottom > top && r.height > 0) return (sp.firstChild as Text) ?? null
  }
  return (spans[0]?.firstChild as Text) ?? null
}
