import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { groupRevisions, lineDiff, type RevisionMeta } from '../../shared/diff'
import { Modal } from './Modal'

type Session = ReturnType<typeof groupRevisions>[number]

/**
 * Page history: autosave revisions grouped into edit sessions, each shown as a diff
 * against the session before it.  Restoring loads that version into the editor; it is
 * then saved like any other edit (a new version on top, nothing is deleted).
 */
export function HistoryDialog({
  wikiId,
  pageId,
  current,
  canRestore,
  onRestore,
  onClose,
}: {
  wikiId: string
  pageId: string
  current: string
  canRestore: boolean
  onRestore: (content: string, version: number) => void
  onClose: () => void
}) {
  const [revs, setRevs] = useState<RevisionMeta[] | null>(null)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState(0)
  const [texts, setTexts] = useState<Record<number, string>>({})
  const [against, setAgainst] = useState<'prev' | 'current'>('prev')

  const load = async (before?: number) => {
    try {
      const r = await api<{ revisions: RevisionMeta[]; more: boolean }>('GET', `/api/wikis/${wikiId}/pages/${pageId}/revisions${before ? `?before=${before}` : ''}`)
      // The first page replaces (effects can run twice); "older" pages append.
      setRevs((old) => (before ? [...(old ?? []).filter((x) => x.version >= before), ...r.revisions] : r.revisions))
      setMore(r.more)
    } catch {
      setError('履歴を読み込めませんでした。')
    }
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wikiId, pageId])

  const sessions = useMemo(() => (revs ? groupRevisions(revs) : []), [revs])
  const s: Session | undefined = sessions[sel]
  // The version just before this session (null: the session starts with the page's creation).
  const prevVersion = s && s.first.version > 1 ? s.first.version - 1 : null

  const text = async (v: number) => {
    if (texts[v] !== undefined) return texts[v]
    const r = await api<{ revision: { content: string } }>('GET', `/api/wikis/${wikiId}/pages/${pageId}/revisions/${v}`)
    setTexts((t) => ({ ...t, [v]: r.revision.content }))
    return r.revision.content
  }
  useEffect(() => {
    if (!s) return
    text(s.last.version).catch(() => setError('この版を読み込めませんでした。'))
    if (prevVersion) text(prevVersion).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.last.version, prevVersion])

  const mine = s ? texts[s.last.version] : undefined
  const base = against === 'current' ? current : prevVersion ? texts[prevVersion] : ''
  const diff = useMemo(() => (mine !== undefined && base !== undefined ? (against === 'current' ? lineDiff(mine, current) : lineDiff(base, mine)) : null), [mine, base, against, current])

  return (
    <Modal title="変更履歴" onClose={onClose} wide>
      {error && <div className="notice">{error}</div>}
      {!revs ? (
        <p className="muted">読み込み中…</p>
      ) : (
        <div className="history">
          <ol className="history-list" data-testid="history-list">
            {sessions.map((g, i) => (
              <li key={g.last.version}>
                <button className={i === sel ? 'on' : ''} onClick={() => setSel(i)}>
                  <span className="history-when">{new Date(g.last.createdAt).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  <span className="muted small">
                    {g.last.byName ?? g.last.byEmail ?? '不明'} · 版 {g.first.version === g.last.version ? g.last.version : `${g.first.version}–${g.last.version}`}
                    {i === 0 && '（最新）'}
                    {g.last.version === 1 && '（作成）'}
                  </span>
                </button>
              </li>
            ))}
            {more && (
              <li>
                <button className="link-btn" onClick={() => load(revs[revs.length - 1].version)}>
                  さらに古い履歴
                </button>
              </li>
            )}
          </ol>
          <div className="history-detail">
            <div className="history-bar">
              <select value={against} onChange={(e) => setAgainst(e.target.value as 'prev' | 'current')} aria-label="比較対象">
                <option value="prev">この編集での変更</option>
                <option value="current">この版 → 現在の内容</option>
              </select>
              {diff && (
                <span className="small">
                  <span className="diff-add-n">+{diff.added}</span> <span className="diff-del-n">−{diff.removed}</span>
                </span>
              )}
              <span style={{ flex: 1 }} />
              {canRestore && s && mine !== undefined && (
                <button
                  className="btn btn-primary btn-small"
                  data-testid="restore"
                  disabled={mine === current}
                  title={mine === current ? '現在の内容と同じです' : undefined}
                  onClick={() => onRestore(mine, s.last.version)}
                >
                  この版に戻す
                </button>
              )}
            </div>
            <div className="diff" data-testid="diff">
              {!diff ? (
                <p className="muted">読み込み中…</p>
              ) : diff.added + diff.removed === 0 ? (
                <p className="muted">変更はありません。</p>
              ) : (
                diff.lines.map((l, i) =>
                  l.kind === 'skip' ? (
                    <div key={i} className="diff-skip">
                      ⋯ {l.count} 行
                    </div>
                  ) : (
                    <div key={i} className={`diff-line diff-${l.kind}`}>
                      <span className="diff-mark">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                      {l.text || ' '}
                    </div>
                  ),
                )
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
