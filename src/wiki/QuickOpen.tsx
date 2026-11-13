import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type PageSummary } from '../api'
import { highlightParts, searchTerms } from '../../shared/search'
import { normalizePageName } from '../../shared/pageName'
import { Modal } from './Modal'
import { matchScore } from '../../shared/fuzzy'
import { isImeKey } from '../editor/SourceEditor'

export interface SearchHit {
  id: string
  name: string
  updatedAt: number
  nameMatch: boolean
  snippet: string | null
}

type Item = { kind: 'page'; page: PageSummary } | { kind: 'create'; name: string } | { kind: 'text'; hit: SearchHit }

/** Plain text with the search terms marked. */
export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlightParts(text, terms).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : p.text))}
    </>
  )
}

/** ⌘K / Ctrl+K: page names first (Enter opens or creates), then pages whose body matches. */
export function QuickOpen({
  wikiId,
  pages,
  canEdit,
  onOpen,
  onCreate,
  onClose,
}: {
  wikiId: string
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
  const [found, setFound] = useState<{ q: string; hits: SearchHit[]; more: boolean } | null>(null)
  const terms = useMemo(() => searchTerms(q), [q])

  // Body search, debounced; stale responses are dropped.
  useEffect(() => {
    if (terms.length === 0) return setFound(null)
    let live = true
    const t = setTimeout(() => {
      api<{ results: SearchHit[]; more: boolean }>('GET', `/api/wikis/${wikiId}/search?q=${encodeURIComponent(q)}`)
        .then((r) => live && setFound({ q, hits: r.results, more: r.more }))
        .catch(() => {})
    }, 200)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [wikiId, q, terms.length])

  const nameItems = useMemo<Item[]>(() => {
    const scored = pages
      .map((p) => ({ p, s: matchScore(p.name, q) }))
      .filter((x): x is { p: PageSummary; s: number } => x.s !== null)
      .sort((a, b) => a.s - b.s || b.p.updatedAt - a.p.updatedAt)
      .slice(0, 50)
      .map((x): Item => ({ kind: 'page', page: x.p }))
    return scored
  }, [pages, q])
  const textHits = useMemo(() => {
    if (!found || found.q !== q) return []
    const shown = new Set(nameItems.flatMap((it) => (it.kind === 'page' ? [it.page.id] : [])))
    return found.hits.filter((h) => !shown.has(h.id) && h.snippet !== null)
  }, [found, q, nameItems])
  // "Create" comes last so Enter after a body search never creates a page by accident.
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [...nameItems, ...textHits.map((hit): Item => ({ kind: 'text', hit }))]
    const name = normalizePageName(q)
    if (canEdit && name && !pages.some((p) => p.name === name)) out.push({ kind: 'create', name })
    return out
  }, [nameItems, textHits, q, canEdit, pages])

  const choose = (it: Item | undefined) => {
    if (!it) return
    if (it.kind === 'page') onOpen(it.page.name)
    else if (it.kind === 'text') onOpen(it.hit.name)
    else onCreate(it.name)
  }
  const move = (d: number) => {
    const n = Math.max(0, Math.min(items.length - 1, sel + d))
    setSel(n)
    listRef.current?.querySelector(`[data-i="${n}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <Modal title="ページを開く・検索" onClose={onClose}>
      <input
        autoFocus
        className="input-block"
        placeholder="ページ名や本文の言葉を入力…"
        value={q}
        data-testid="quick-open-input"
        aria-label="ページ名または本文"
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
          <li key={it.kind === 'page' ? it.page.id : it.kind === 'text' ? 't' + it.hit.id : '__create'} role="option" aria-selected={i === sel} data-i={i}>
            {it.kind === 'text' && i === nameItems.length && <div className="quick-section muted small">本文に含むページ</div>}
            <button
              className={(i === sel ? 'on ' : '') + (it.kind === 'text' ? 'quick-text' : '')}
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(it)}
              data-testid={it.kind === 'text' ? 'quick-text-hit' : undefined}
            >
              {it.kind === 'page' ? (
                <>
                  {it.page.name.includes('/') && <span className="muted">{it.page.name.slice(0, it.page.name.lastIndexOf('/') + 1)}</span>}
                  {it.page.name.slice(it.page.name.lastIndexOf('/') + 1)}
                </>
              ) : it.kind === 'text' ? (
                <>
                  <span className="quick-text-name">{it.hit.name}</span>
                  <span className="quick-snippet muted">
                    <Highlight text={it.hit.snippet ?? ''} terms={terms} />
                  </span>
                </>
              ) : (
                <>
                  ＋ 「{it.name}」を作成
                </>
              )}
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="muted small quick-empty">{found?.q === q || !terms.length ? '該当するページがありません' : '検索中…'}</li>}
        {found?.q === q && found.more && <li className="muted small quick-empty">本文の一致が多いため、最近更新された 100 件まで表示しています</li>}
      </ul>
      <p className="muted small">
        <kbd>↑</kbd>
        <kbd>↓</kbd> で選択 · <kbd>Enter</kbd> で開く · <kbd>Esc</kbd> で閉じる
      </p>
    </Modal>
  )
}
