import { createContext, useContext, useLayoutEffect, useRef } from 'react'
import { continueOnEnter } from '../../shared/markdown/continueLine'

export interface EditCtxValue {
  text: string
  initialCaret: number
  initialSelEnd?: number
  setText: (t: string) => void
  exit: () => void
  taRef: React.MutableRefObject<HTMLTextAreaElement | null>
  /** Pasted / dropped image files (insert at the caret, upload). */
  onImages?: (files: File[]) => void
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
        }}
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
      <div className="src-hint" aria-hidden>
        Markdown · <kbd>Esc</kbd> で表示に戻る
      </div>
    </div>
  )
}

function autosize(ta: HTMLTextAreaElement) {
  ta.style.height = '0px'
  ta.style.height = `${ta.scrollHeight}px`
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
