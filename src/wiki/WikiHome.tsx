import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { pageUrl, type PageSummary } from '../api'
import { fullTime, relTime } from '../time'
import { useWiki } from './WikiLayout'

export function WikiHome() {
  const { wiki, pages, canEdit, openNewPage } = useWiki()
  const [params] = useSearchParams()
  // A wiki URL without a page goes to the top page, if one is set (?list shows the page list).
  // Resolve by id from the live page list so a renamed top page still works.
  const top = wiki.topPageId ? (pages.find((p) => p.id === wiki.topPageId)?.name ?? wiki.topPage) : null
  if (top && !params.has('list')) return <Navigate to={pageUrl(wiki.slug, top)} replace />
  const recent = [...pages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)
  const sorted = [...pages].sort((a, b) => a.name.localeCompare(b.name, 'ja'))
  return (
    <div className="page">
      <div className="home-title">
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
              <span className="muted small">{pages.length} ページ</span>
            </div>
            <ul className="list list-compact">
              {sorted.map((p) => (
                <li key={p.id}>
                  <Link to={pageUrl(wiki.slug, p.name)} className="list-row">
                    <PageName page={p} />
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
