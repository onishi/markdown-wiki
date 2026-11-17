import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, pageUrl } from '../api'
import { lineDiff } from '../../shared/diff'
import { useWiki, HeaderTitle } from './WikiLayout'
import { DiffLines } from './DiffLines'

export interface Change {
  pageId: string
  name: string
  from: number
  to: number
  count: number
  at: number
  byName: string | null
  byEmail: string | null
  via: string[]
  created: boolean
  added: number
  removed: number
}

export const VIA_LABEL: Record<string, string> = { ai: 'AI の提案', restore: '復元', rename: 'リンク更新' }

const day = (t: number) => new Date(t).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })

/** Recent changes across the wiki: who edited which page when, grouped into edit sessions. */
export function RecentChanges() {
  const { wiki } = useWiki()
  const [changes, setChanges] = useState<Change[] | null>(null)
  const [next, setNext] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = async (before?: number) => {
    try {
      const r = await api<{ changes: Change[]; next: number | null }>('GET', `/api/wikis/${wiki.id}/changes${before ? `?before=${before}` : ''}`)
      setChanges((old) => (before ? [...(old ?? []), ...r.changes] : r.changes))
      setNext(r.next)
    } catch {
      setError('更新履歴を読み込めませんでした。')
    }
  }
  useEffect(() => {
    setChanges(null)
    setOpen(null)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wiki.id])

  const days = useMemo(() => {
    const out: { day: string; items: Change[] }[] = []
    for (const c of changes ?? []) {
      const d = day(c.at)
      if (out[out.length - 1]?.day !== d) out.push({ day: d, items: [] })
      out[out.length - 1].items.push(c)
    }
    return out
  }, [changes])

  return (
    <div className="page">
      <HeaderTitle>最近の更新</HeaderTitle>
      <h1 className="page-title">最近の更新</h1>
      {error && <div className="notice">{error}</div>}
      {!changes ? (
        <p className="muted">読み込み中…</p>
      ) : changes.length === 0 ? (
        <p className="muted">まだ更新はありません。</p>
      ) : (
        <div className="changes" data-testid="changes">
          {days.map((d) => (
            <section key={d.day}>
              <h3 className="changes-day">{d.day}</h3>
              <ul className="changes-list">
                {d.items.map((c) => {
                  const key = `${c.pageId}:${c.to}`
                  return (
                    <li key={key} className={open === key ? 'open' : ''}>
                      <div className="change-row">
                        <span className="change-time muted small">{new Date(c.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span>
                        <Link to={pageUrl(wiki.slug, c.name)} className="change-page">
                          {c.name}
                        </Link>
                        {c.created && <span className="tag tag-new">作成</span>}
                        {c.via.map((v) => (
                          <span key={v} className={`tag tag-${v}`}>
                            {VIA_LABEL[v] ?? v}
                          </span>
                        ))}
                        <span className="change-who muted small">{c.byName ?? c.byEmail ?? '不明'}</span>
                        <button
                          className="link-btn small change-stat"
                          onClick={() => setOpen(open === key ? null : key)}
                          aria-expanded={open === key}
                          title="差分を表示"
                          data-testid="change-diff"
                        >
                          <span className="diff-add-n">+{c.added}</span> <span className="diff-del-n">−{c.removed}</span>
                        </button>
                      </div>
                      {open === key && <ChangeDiff wikiId={wiki.id} change={c} />}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
          {next && (
            <button className="btn" onClick={() => load(next)}>
              さらに古い更新
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ChangeDiff({ wikiId, change }: { wikiId: string; change: Change }) {
  const [texts, setTexts] = useState<{ before: string; after: string } | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    const get = (v: number) =>
      api<{ revision: { content: string } }>('GET', `/api/wikis/${wikiId}/pages/${change.pageId}/revisions/${v}`).then((r) => r.revision.content)
    Promise.all([change.from > 1 ? get(change.from - 1) : Promise.resolve(''), get(change.to)])
      .then(([before, after]) => setTexts({ before, after }))
      .catch(() => setError(true))
  }, [wikiId, change.pageId, change.from, change.to])
  const diff = useMemo(() => (texts ? lineDiff(texts.before, texts.after) : null), [texts])
  return (
    <div className="diff change-diff">
      {error ? <p className="muted">差分を読み込めませんでした。</p> : !diff ? <p className="muted">読み込み中…</p> : <DiffLines diff={diff} />}
    </div>
  )
}
