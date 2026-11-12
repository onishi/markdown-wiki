import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { continueOnEnter } from '../../shared/markdown/continueLine'
import { rankNames } from '../../shared/fuzzy'

export interface EditCtxValue {
  text: string
  initialCaret: number
  initialSelEnd?: number
  setText: (t: string) => void
  exit: () => void
  taRef: React.MutableRefObject<HTMLTextAreaElement | null>
  /** Pasted / dropped image files (insert at the caret, upload). */
  onImages?: (files: File[]) => void
  /** Page names offered after `[[` (most relevant first, e.g. recently updated). */
  wikiNames?: string[]
}

/** An unclosed `[[query` right before the caret (same line, no `]`/`|`). */
export function wikiQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /\[\[([^\[\]\n|]{0,100})$/.exec(text.slice(Math.max(0, caret - 110), caret))
  return m ? { start: caret - m[1].length, query: m[1] } : null
}

export const EditCtx = createContext<EditCtxValue | null>(null)

/** Is this keydown part of an IME composition (confirm/cancel)? */
export function isImeKey(e: React.KeyboardEvent | KeyboardEvent, lastCompositionEnd: number): boolean {
  const ne = 'nativeEvent' in e ? e.nativeEvent : e
  if (ne.isComposing || ne.keyCode === 229) return true
  // Safari fires keydown(Enter) right after compositionend for the confirming Enter.
  return performance.now() - lastCompositionEnd < 50
}

/**
 * Raw Markdown editor for one edit unit.  A plain <textarea> so that IME, undo/redo,
 * selection, copy & paste all behave natively.
 */
export function SourceEditor() {
  const ctx = useContext(EditCtx)!
  const compEnd = useRef(-1e9)

  // `[[` completion
  const [comp, setComp] = useState<{ start: number; query: string; x: number; y: number } | null>(null)
  const [compSel, setCompSel] = useState(0)
  const items = useMemo(() => (comp && ctx.wikiNames ? rankNames(ctx.wikiNames, comp.query, 8) : []), [comp, ctx.wikiNames])
  // Esc dismisses the suggestions for this `[[` until the text changes.
  const dismissed = useRef<number | null>(null)
  const updateComp = (ta: HTMLTextAreaElement, typed = false) => {
    if (typed) dismissed.current = null
    if (!ctx.wikiNames || ta.selectionStart !== ta.selectionEnd) return setComp(null)
    const q = wikiQueryAt(ta.value, ta.selectionStart)
    if (!q || dismissed.current === q.start) return setComp(null)
    const p = textareaCaretPos(ta)
    setComp((c) => {
      if (!c || c.query !== q.query) setCompSel(0)
      return { ...q, x: p.left, y: p.bottom }
    })
  }
  const accept = (name: string) => {
    const ta = ctx.taRef.current!
    const pos = ta.selectionStart
    // Replace the query (and a closing `]]` already typed after it) with `name]]`.
    const end = ta.value.startsWith(']]', pos) ? pos + 2 : pos
    ta.setSelectionRange(comp!.start, end)
    document.execCommand('insertText', false, `${name}]]`)
    setComp(null)
  }

  useLayoutEffect(() => {
    const ta = ctx.taRef.current!
    autosize(ta)
    ta.focus({ preventScroll: true })
    ta.setSelectionRange(ctx.initialCaret, ctx.initialSelEnd ?? ctx.initialCaret)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(() => {
    if (ctx.taRef.current) autosize(ctx.taRef.current)
  }, [ctx.text])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeKey(e, compEnd.current)) return
    if (comp && items.length) {
      const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')
      const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')
      if (down || up) {
        e.preventDefault()
        e.stopPropagation()
        setCompSel((i) => (i + (down ? 1 : -1) + items.length) % items.length)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        accept(items[compSel] ?? items[0])
        return
      }
      if (e.key === 'Escape') {
        // First Esc closes the suggestions; the next one leaves edit mode.
        e.preventDefault()
        e.stopPropagation()
        dismissed.current = comp.start
        setComp(null)
        return
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      ctx.exit()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Continue quotes / lists / table rows; Enter on an empty one ends it.
      // Shift+Enter is always a plain newline.
      const ta = e.currentTarget
      const act = continueOnEnter(ta.value, ta.selectionStart, ta.selectionEnd)
      if (act) {
        e.preventDefault()
        // execCommand keeps each auto-insertion a single native undo step.
        if (act.kind === 'insert') document.execCommand('insertText', false, act.text)
        else {
          ta.setSelectionRange(act.from, act.to)
          document.execCommand('delete')
        }
        e.stopPropagation()
        return
      }
    }
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      const ta = e.currentTarget
      if (e.shiftKey) {
        // Outdent current line by up to two spaces.
        const ls = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1
        const n = /^ {1,2}/.exec(ta.value.slice(ls))?.[0].length ?? 0
        if (n) {
          const pos = ta.selectionStart
          ta.setSelectionRange(ls, ls + n)
          document.execCommand('delete')
          ta.setSelectionRange(Math.max(ls, pos - n), Math.max(ls, pos - n))
        }
      } else {
        // execCommand keeps the native undo stack intact.
        document.execCommand('insertText', false, '  ')
      }
    }
    e.stopPropagation()
  }

  return (
    <div className="src-editor" data-testid="src-editor">
      <textarea
        ref={ctx.taRef}
        className="src-textarea"
        value={ctx.text}
        spellCheck={false}
        aria-label="Markdown ソース"
        onChange={(e) => {
          ctx.setText(e.target.value)
          autosize(e.target)
          updateComp(e.target, true)
        }}
        onSelect={(e) => updateComp(e.currentTarget)}
        onBlur={() => setComp(null)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
          if (files.length && ctx.onImages) {
            e.preventDefault()
            ctx.onImages(files)
          }
        }}
        onCompositionEnd={() => {
          compEnd.current = performance.now()
        }}
      />
      {comp && items.length > 0 && (
        <ul className="wiki-complete" role="listbox" data-testid="wiki-complete" style={{ left: comp.x, top: comp.y + 4 }}>
          {items.map((n, i) => (
            <li key={n} role="option" aria-selected={i === compSel}>
              <button className={i === compSel ? 'on' : ''} onMouseDown={(e) => (e.preventDefault(), accept(n))} onMouseEnter={() => setCompSel(i)}>
                {n}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="src-hint">
        Markdown{ctx.wikiNames ? ' · [[ でページ名を補完' : ''} ·{' '}
        <button className="src-done" onMouseDown={(e) => e.preventDefault()} onClick={() => ctx.exit()} data-testid="src-done">
          完了 <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  )
}

function autosize(ta: HTMLTextAreaElement) {
  ta.style.height = '0px'
  ta.style.height = `${ta.scrollHeight}px`
}

/** Viewport position of the caret inside a textarea (mirror element). */
export function textareaCaretPos(ta: HTMLTextAreaElement): { left: number; top: number; bottom: number } {
  const cs = getComputedStyle(ta)
  const m = document.createElement('div')
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'borderTopWidth', 'borderLeftWidth', 'borderRightWidth', 'boxSizing', 'tabSize'] as const) {
    ;(m.style as any)[p] = (cs as any)[p]
  }
  m.style.position = 'absolute'
  m.style.visibility = 'hidden'
  m.style.whiteSpace = 'pre-wrap'
  m.style.overflowWrap = 'break-word'
  m.style.width = `${ta.offsetWidth}px`
  m.style.left = '0'
  m.style.top = '0'
  m.textContent = ta.value.slice(0, ta.selectionEnd)
  const mark = document.createElement('span')
  mark.textContent = '\u200b'
  m.appendChild(mark)
  document.body.appendChild(m)
  const r = ta.getBoundingClientRect()
  const left = r.left + mark.offsetLeft - ta.scrollLeft
  const top = r.top + mark.offsetTop - ta.scrollTop
  const h = mark.offsetHeight || parseFloat(cs.lineHeight) || 20
  m.remove()
  return { left, top, bottom: top + h }
}

/** Viewport y of the caret inside a textarea, measured with a mirror element. */
export function textareaCaretY(ta: HTMLTextAreaElement): number {
  const cs = getComputedStyle(ta)
  const m = document.createElement('div')
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'borderTopWidth', 'borderLeftWidth', 'borderRightWidth', 'boxSizing', 'tabSize'] as const) {
    ;(m.style as any)[p] = (cs as any)[p]
  }
  m.style.position = 'absolute'
  m.style.visibility = 'hidden'
  m.style.whiteSpace = 'pre-wrap'
  m.style.overflowWrap = 'break-word'
  m.style.width = `${ta.offsetWidth}px`
  m.textContent = ta.value.slice(0, ta.selectionEnd)
  const mark = document.createElement('span')
  mark.textContent = '​'
  m.appendChild(mark)
  document.body.appendChild(m)
  const y = ta.getBoundingClientRect().top + mark.offsetTop - ta.scrollTop
  m.remove()
  return y
}
