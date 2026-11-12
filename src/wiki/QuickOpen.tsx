import { useMemo, useRef, useState } from 'react'
import type { PageSummary } from '../api'
import { normalizePageName } from '../../shared/pageName'
import { Modal } from './Modal'
import { isImeKey } from '../editor/SourceEditor'

/** Lower is better; null = no match.  Matching ignores ASCII case (like the sidebar search). */
export function matchScore(name: string, query: string): number | null {
  const n = name.toLowerCase()
  const q = query.toLowerCase().trim()
  if (!q) return 0
  if (n === q) return 0
  const base = n.slice(n.lastIndexOf('/') + 1)
  if (base.startsWith(q)) return 1
  if (n.startsWith(q)) return 2
  const i = n.indexOf(q)
  if (i >= 0) return 3 + i / 1000
  // all words, any order
  const words = q.split(/\s+/)
  if (words.length > 1 && words.every((w) => n.includes(w))) return 5
  // characters in order (fuzzy)
  let at = 0
  for (const ch of q.replace(/\s+/g, '')) {
    at = n.indexOf(ch, at)
    if (at < 0) return null
    at++
  }
  return 8
}

type Item = { kind: 'page'; page: PageSummary } | { kind: 'create'; name: string }

/** ⌘K / Ctrl+K: type part of a page name, Enter opens it (or creates it). */
export function QuickOpen({
  pages,
  canEdit,
  onOpen,
  onCreate,
  onClose,
}: {
  pages: PageSummary[]
  canEdit: boolean
  onOpen: (name: string) => void
  onCreate: (name: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const compEnd = useRef(-1e9)
  const listRef = useRef<HTMLUListElement>(null)

  const items = useMemo<Item[]>(() => {
    const scored = pages
      .map((p) => ({ p, s: matchScore(p.name, q) }))
      .filter((x): x is { p: PageSummary; s: number } => x.s !== null)
      .sort((a, b) => a.s - b.s || b.p.updatedAt - a.p.updatedAt)
      .slice(0, 50)
      .map((x): Item => ({ kind: 'page', page: x.p }))
    const name = normalizePageName(q)
    if (canEdit && name && !pages.some((p) => p.name === name)) scored.push({ kind: 'create', name })
    return scored
  }, [pages, q, canEdit])

  const choose = (it: Item | undefined) => {
    if (!it) return
    if (it.kind === 'page') onOpen(it.page.name)
    else onCreate(it.name)
  }
  const move = (d: number) => {
    const n = Math.max(0, Math.min(items.length - 1, sel + d))
    setSel(n)
    listRef.current?.children[n]?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <Modal title="ページを開く" onClose={onClose}>
      <input
        autoFocus
        className="input-block"
        placeholder="ページ名の一部を入力…"
        value={q}
        data-testid="quick-open-input"
        aria-label="ページ名"
        onChange={(e) => (setQ(e.target.value), setSel(0))}
        onCompositionEnd={() => (compEnd.current = performance.now())}
        onKeyDown={(e) => {
          if (isImeKey(e, compEnd.current)) return
          const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')
          const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')
          if (down || up) {
            e.preventDefault()
            move(down ? 1 : -1)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            choose(items[sel])
          }
        }}
      />
      <ul className="quick-list" ref={listRef} role="listbox" data-testid="quick-open-list">
        {items.map((it, i) => (
          <li key={it.kind === 'page' ? it.page.id : '__create'} role="option" aria-selected={i === sel}>
            <button className={i === sel ? 'on' : ''} onMouseEnter={() => setSel(i)} onClick={() => choose(it)}>
              {it.kind === 'page' ? (
                <>
                  {it.page.name.includes('/') && <span className="muted">{it.page.name.slice(0, it.page.name.lastIndexOf('/') + 1)}</span>}
                  {it.page.name.slice(it.page.name.lastIndexOf('/') + 1)}
                </>
              ) : (
                <>
                  ＋ 「{it.name}」を作成
                </>
              )}
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="muted small quick-empty">該当するページがありません</li>}
      </ul>
      <p className="muted small">
        <kbd>↑</kbd>
        <kbd>↓</kbd> で選択 · <kbd>Enter</kbd> で開く · <kbd>Esc</kbd> で閉じる
      </p>
    </Modal>
  )
}
