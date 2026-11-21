import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { pageUrl, type PageSummary } from '../api'
import { useState } from 'react'
import { fullTime, relTime, staleLabel } from '../time'
import { useWiki, HeaderTitle } from './WikiLayout'

export function WikiHome() {
  const { wiki, pages, canEdit, openNewPage } = useWiki()
  const [params] = useSearchParams()
  // A wiki URL without a page goes to the top page, if one is set (?list shows the page list).
  // Resolve by id from the live page list so a renamed top page still works.
  const top = wiki.topPageId ? (pages.find((p) => p.id === wiki.topPageId)?.name ?? wiki.topPage) : null
  if (top && !params.has('list')) return <Navigate to={pageUrl(wiki.slug, top)} replace />
  const recent = [...pages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)
  const [order, setOrder] = useState<'name' | 'old'>('name')
  const sorted = [...pages].sort((a, b) => (order === 'old' ? a.updatedAt - b.updatedAt : a.name.localeCompare(b.name, 'ja')))
  const stale = pages.filter((p) => staleLabel(p.updatedAt)).length
  return (
    <div className="page">
      <div className="home-title">
        <HeaderTitle>すべてのページ</HeaderTitle>
      <h1 className="page-title">{wiki.name}</h1>
        {canEdit && pages.length > 0 && (
          <button className="btn" onClick={() => openNewPage('')}>
            ＋ 新しいページ
          </button>
        )}
      </div>
      {pages.length === 0 ? (
        <div className="empty-state">
          <p>まだページがありません。</p>
          <p className="muted small">ページ名に「/」を入れると階層になります（例: 開発/環境構築）。</p>
          {canEdit && (
            <button className="btn btn-primary" onClick={() => openNewPage('')}>
              最初のページを作成
            </button>
          )}
        </div>
      ) : (
        <>
          <section>
            <div className="section-head">
              <h3>最近の更新</h3>
              <Link to={`/w/${wiki.slug}/changes`} className="small">
                すべての更新 →
              </Link>
            </div>
            <ul className="list" data-testid="recent-pages">
              {recent.map((p) => (
                <li key={p.id}>
                  <Link to={pageUrl(wiki.slug, p.name)} className="list-row">
                    <PageName page={p} />
                    <span className="list-meta" title={fullTime(p.updatedAt)}>
                      {p.updatedByName && <span className="list-who">{p.updatedByName}</span>}
                      {relTime(p.updatedAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <div className="section-head">
              <h3>すべてのページ</h3>
              <span className="muted small section-count">
                {pages.length} ページ{stale > 0 && <>（うち半年以上更新なし {stale}）</>}
              </span>
              <span className="seg small" role="group" aria-label="並び順">
                <button className={order === 'name' ? 'on' : ''} onClick={() => setOrder('name')} data-testid="order-name">
                  名前順
                </button>
                <button className={order === 'old' ? 'on' : ''} onClick={() => setOrder('old')} data-testid="order-old">
                  更新が古い順
                </button>
              </span>
            </div>
            <ul className="list list-compact" data-testid="all-pages">
              {sorted.map((p) => (
                <li key={p.id}>
                  <Link to={pageUrl(wiki.slug, p.name)} className="list-row">
                    <PageName page={p} />
                    <span className={'list-meta' + (staleLabel(p.updatedAt) ? ' stale' : '')} title={staleLabel(p.updatedAt) ?? fullTime(p.updatedAt)}>
                      {relTime(p.updatedAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}

/** "開発/環境構築": the parent path muted, the page's own name in front; a mark if published. */
export function PageName({ page }: { page: Pick<PageSummary, 'name' | 'publishedAt'> }) {
  const i = page.name.lastIndexOf('/')
  return (
    <span className="list-name">
      {i >= 0 && <span className="list-path">{page.name.slice(0, i + 1)}</span>}
      <span className="list-leaf">{page.name.slice(i + 1)}</span>
      {page.publishedAt ? <span className="tag tag-public" title="ログインしていない人も読めます">公開</span> : null}
    </span>
  )
}
