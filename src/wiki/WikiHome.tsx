import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { pageUrl } from '../api'
import { useWiki } from './WikiLayout'

export function WikiHome() {
  const { wiki, pages, canEdit, openNewPage } = useWiki()
  const [params] = useSearchParams()
  // A wiki URL without a page goes to the top page, if one is set (?list shows the page list).
  // Resolve by id from the live page list so a renamed top page still works.
  const top = wiki.topPageId ? (pages.find((p) => p.id === wiki.topPageId)?.name ?? wiki.topPage) : null
  if (top && !params.has('list')) return <Navigate to={pageUrl(wiki.slug, top)} replace />
  const recent = [...pages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10)
  return (
    <div className="page">
      <h1 className="page-title">{wiki.name}</h1>
      {pages.length === 0 ? (
        <div className="empty-state">
          <p>まだページがありません。</p>
          {canEdit && (
            <button className="btn btn-primary" onClick={() => openNewPage('')}>
              最初のページを作成
            </button>
          )}
        </div>
      ) : (
        <>
          <section>
            <h3>最近更新されたページ</h3>
            <ul className="page-list">
              {recent.map((p) => (
                <li key={p.id}>
                  <Link to={pageUrl(wiki.slug, p.name)}>{p.name}</Link>
                  <span className="muted small">{new Date(p.updatedAt).toLocaleString('ja-JP')}</span>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>すべてのページ（{pages.length}）</h3>
            <ul className="page-list">
              {pages.map((p) => (
                <li key={p.id}>
                  <Link to={pageUrl(wiki.slug, p.name)}>{p.name}</Link>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
