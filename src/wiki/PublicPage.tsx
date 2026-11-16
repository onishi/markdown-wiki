import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { pageUrl } from '../api'
import { parseMarkdown } from '../../shared/markdown/parse'
import { makeContext, renderDocument, type VNode } from '../../shared/markdown/render'
import { normalizePageName } from '../../shared/pageName'
import { toReact } from '../editor/vdom'

interface PublicData {
  wiki: { name: string; slug: string }
  page: { name: string; content: string; updatedAt: number }
  /** Published page names (and their old names) of the wiki: links to anything else are plain text. */
  published: string[]
}

/**
 * A published page for anyone, logged in or not, at its usual URL (/w/<slug>/p/<name>).
 * Read only.  `fallback`: what to show when the page is not published.
 */
export function PublicPage({ fallback }: { fallback: React.ReactNode }) {
  const { wid } = useParams()
  const loc = useLocation()
  const nav = useNavigate()
  const name = normalizePageName(decodeURIComponent(loc.pathname.replace(/^\/w\/[^/]+\/p\//, '')))
  const key = `${wid}\n${name}`
  // Tagged with the URL it was loaded for: right after moving to another page the old
  // data must not count (it would redirect back to its own URL).
  const [loaded, setLoaded] = useState<{ key: string; data: PublicData | 'missing' } | null>(null)
  const data = loaded?.key === key ? loaded.data : null
  useEffect(() => {
    let live = true
    const done = (d: PublicData | 'missing') => live && setLoaded({ key, data: d })
    fetch(`/api/public/wikis/${encodeURIComponent(wid!)}/page?name=${encodeURIComponent(name)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : 'missing'))
      .then(done)
      .catch(() => done('missing'))
    return () => {
      live = false
    }
  }, [wid, name, key])

  useEffect(() => {
    if (data && data !== 'missing') document.title = `${data.page.name.split('/').pop()} - ${data.wiki.name}`
  }, [data])

  const doc = useMemo(() => {
    if (!data || data === 'missing') return null
    const published = new Set(data.published)
    const src = data.page.content
    const tree = parseMarkdown(src)
    const ctx = makeContext(tree, src, (t) => ({ href: pageUrl(data.wiki.slug, t), exists: true }), 'break')
    return toReact(privateLinksAsText(renderDocument(tree, ctx), published), [], () => null)
  }, [data])

  if (data === null) return <div className="center-msg">読み込み中…</div>
  if (data === 'missing') return <>{fallback}</>
  // Old page name or old slug: show the current URL.
  const canonical = pageUrl(data.wiki.slug, data.page.name)
  if (decodeURI(loc.pathname) !== decodeURI(canonical)) return <Navigate to={canonical + loc.hash} replace />

  return (
    <div className="public">
      <header className="public-bar">
        <span className="public-wiki">{data.wiki.name}</span>
        <Link to={`/login?returnTo=${encodeURIComponent(loc.pathname)}`} className="public-login muted small">
          ログイン
        </Link>
      </header>
      <main className="page public-page" data-testid="public-page">
        <h1 className="page-title">{data.page.name.split('/').pop()}</h1>
        <div
          className="doc markdown-body is-viewing soft-breaks"
          data-testid="doc"
          onClick={(e) => {
            // Published pages open inside the app; other links behave as usual.
            const a = (e.target as Element).closest('a[data-link=wiki]')
            if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return
            e.preventDefault()
            nav(a.getAttribute('href')!)
          }}
        >
          {doc}
        </div>
        <footer className="public-foot muted small">
          最終更新 {new Date(data.page.updatedAt).toLocaleDateString('ja-JP')} · Markdown Wiki で公開されているページです
        </footer>
      </main>
    </div>
  )
}

/** Links to pages that are not published become plain text (their names may be private, but the text is already on the page). */
function privateLinksAsText(nodes: VNode[], published: Set<string>): VNode[] {
  return nodes.map((n) => {
    if (n.k !== 'el') return n
    const children = privateLinksAsText(n.children, published)
    if (n.tag === 'a' && n.attrs?.['data-link'] === 'wiki' && !published.has(normalizePageName(String(n.attrs['data-wiki'])))) {
      return { k: 'el', tag: 'span', children }
    }
    return { ...n, children }
  })
}
