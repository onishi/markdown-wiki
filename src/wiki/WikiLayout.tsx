import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, pageUrl, ROLE_LABEL, type Me, type PageSummary, type Role, type WikiSummary } from '../api'
import { buildTree, normalizePageName, type TreeNode } from '../../shared/pageName'
import type { WikiResolver } from '../../shared/markdown/render'
import { useSession } from '../App'
import { Modal } from './Modal'
import { QuickOpen } from './QuickOpen'
import { Outline } from '../editor/Outline'
import type { OutlineItem } from '../../shared/markdown/outline'

/** Set by the page view so the sidebar can show its outline. */
export interface OutlineSource {
  source: string
  jump: (item: OutlineItem) => void
}

interface WikiCtxValue {
  wiki: WikiSummary
  role: Role
  canEdit: boolean
  pages: PageSummary[]
  aliases: { name: string; pageId: string }[]
  reloadPages: () => Promise<void>
  reloadWiki: () => Promise<void>
  resolveWiki: WikiResolver
  absoluteWiki: WikiResolver
  openNewPage: (prefill?: string) => void
  /** ⌘K page switcher */
  openQuick: () => void
  setOutline: (o: OutlineSource | null) => void
}
const WikiCtx = createContext<WikiCtxValue | null>(null)
export const useWiki = () => useContext(WikiCtx)!

export function WikiLayout() {
  const { wid } = useParams()
  const nav = useNavigate()
  const [wiki, setWiki] = useState<WikiSummary | null>(null)
  const [wikis, setWikis] = useState<WikiSummary[]>([])
  const [pages, setPages] = useState<PageSummary[]>([])
  const [aliases, setAliases] = useState<{ name: string; pageId: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [newPage, setNewPage] = useState<string | null>(null)
  const [outline, setOutline] = useState<OutlineSource | null>(null)

  const reloadPages = useCallback(async () => {
    const r = await api<{ pages: PageSummary[]; aliases: { name: string; pageId: string }[] }>('GET', `/api/wikis/${wid}/pages`)
    setPages(r.pages)
    setAliases(r.aliases)
  }, [wid])

  const reloadWiki = useCallback(async () => {
    const r = await api<{ wiki: WikiSummary }>('GET', `/api/wikis/${wid}`)
    setWiki(r.wiki)
  }, [wid])

  // Moving to the canonical slug of the wiki already shown (or a slug change) is not a new wiki.
  const shownSlug = useRef<string | null>(null)
  shownSlug.current = wiki?.slug ?? null

  useEffect(() => {
    api<{ wikis: WikiSummary[] }>('GET', '/api/wikis').then((r) => setWikis(r.wikis))
    try {
      localStorage.setItem('mw:lastWiki', wid!)
    } catch {}
    if (shownSlug.current === wid) return
    setWiki(null)
    setError(null)
    reloadWiki()
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? 'この wiki は存在しないか、アクセス権がありません。' : '読み込みに失敗しました。'))
    reloadPages().catch(() => {})
  }, [wid, reloadPages, reloadWiki])

  // Old slugs and raw ids still open the wiki; show the canonical /w/<slug> URL.
  const loc = useLocation()
  useEffect(() => {
    if (wiki && wid !== wiki.slug) nav(loc.pathname.replace(`/w/${wid}`, `/w/${wiki.slug}`) + loc.search + loc.hash, { replace: true })
  }, [wiki, wid, loc, nav])

  const slug = wiki?.slug ?? wid!

  // Phone drawer: closes on navigation.
  const [drawer, setDrawer] = useState(false)
  useEffect(() => setDrawer(false), [loc.pathname])

  // ⌘K / Ctrl+K anywhere in the wiki (capture: the source editor stops key propagation).
  const [quick, setQuick] = useState(false)
  useEffect(() => {
    const isMac = /Mac/.test(navigator.platform)
    const h = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (isMac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        e.stopPropagation()
        setQuick((q) => !q)
      }
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [])
  const known = useMemo(() => new Set([...pages.map((p) => p.name), ...aliases.map((a) => a.name)]), [pages, aliases])
  const resolveWiki = useCallback<WikiResolver>((t) => ({ href: pageUrl(slug, t), exists: known.has(t) }), [slug, known])
  const absoluteWiki = useCallback<WikiResolver>((t) => ({ href: location.origin + pageUrl(slug, t), exists: true }), [slug])

  if (error)
    return (
      <div className="center-msg">
        <p>{error}</p>
        <Link to="/">wiki 一覧へ</Link>
      </div>
    )
  if (!wiki) return <div className="center-msg">読み込み中…</div>

  const role = wiki.role
  const value: WikiCtxValue = {
    wiki,
    role,
    canEdit: role !== 'viewer',
    pages,
    aliases,
    reloadPages,
    reloadWiki,
    resolveWiki,
    absoluteWiki,
    openNewPage: (prefill = '') => setNewPage(prefill),
    openQuick: () => setQuick(true),
    setOutline,
  }

  const createAndOpen = async (name: string) => {
    const n = normalizePageName(name)
    const exists = pages.find((p) => p.name === n)
    if (!exists) {
      try {
        await api('POST', `/api/wikis/${wid}/pages`, { name: n, content: '' })
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) throw e
      }
      await reloadPages()
    }
    nav(pageUrl(slug, n))
  }

  return (
    <WikiCtx.Provider value={value}>
      <div className="layout">
        <Sidebar wikis={wikis} outline={outline} open={drawer} />
        {drawer && <div className="drawer-back" onClick={() => setDrawer(false)} data-testid="drawer-back" />}
        <main className="main">
          {/* Phones: the sidebar becomes a drawer behind this bar. */}
          <div className="mobile-bar">
            <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="メニューを開く" data-testid="open-drawer">
              ☰
            </button>
            <span className="mobile-title">{wiki.name}</span>
            <button className="icon-btn" onClick={() => setQuick(true)} aria-label="ページを開く" data-testid="mobile-quick">
              ⌕
            </button>
          </div>
          <Outlet />
        </main>
      </div>
      {newPage !== null && (
        <NewPageDialog
          initial={newPage}
          onClose={() => setNewPage(null)}
          onCreate={async (name) => {
            await createAndOpen(name)
            setNewPage(null)
          }}
        />
      )}
      {quick && (
        <QuickOpen
          wikiId={wiki.id}
          pages={pages}
          canEdit={value.canEdit}
          onClose={() => setQuick(false)}
          onOpen={(name) => (setQuick(false), nav(pageUrl(slug, name)))}
          onCreate={(name) => {
            setQuick(false)
            createAndOpen(name).catch(() => setNewPage(name))
          }}
        />
      )}
    </WikiCtx.Provider>
  )
}

function Sidebar({ wikis, outline, open }: { wikis: WikiSummary[]; outline: OutlineSource | null; open: boolean }) {
  const { wiki, pages, canEdit, openNewPage, openQuick, role } = useWiki()
  const { me, logout } = useSession()
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? pages.filter((p) => p.name.toLowerCase().includes(s)) : pages
  }, [q, pages])
  const tree = useMemo(() => buildTree(filtered), [filtered])
  const [tab, setTab] = useState<'pages' | 'outline'>(() => {
    try {
      return localStorage.getItem('mw:sideTab') === 'outline' ? 'outline' : 'pages'
    } catch {
      return 'pages'
    }
  })
  const switchTab = (t: 'pages' | 'outline') => {
    setTab(t)
    try {
      localStorage.setItem('mw:sideTab', t)
    } catch {}
  }
  const showOutline = tab === 'outline' && !!outline

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`} data-testid="sidebar">
      <div className="sidebar-top">
        <select
          className="wiki-switch"
          value={wiki.slug}
          aria-label="wiki を切り替え"
          onChange={(e) => (e.target.value === '__home' ? nav('/') : nav(`/w/${e.target.value}`))}
        >
          {wikis.map((w) => (
            <option key={w.id} value={w.slug}>
              {w.name}
            </option>
          ))}
          <option value="__home">＋ wiki 一覧・新規作成…</option>
        </select>
        <div className="role-badge" title="あなたの権限">
          {ROLE_LABEL[role]}
        </div>
      </div>
      <div className="side-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'pages'} className={tab === 'pages' ? 'on' : ''} onClick={() => switchTab('pages')}>
          ページ
        </button>
        <button role="tab" aria-selected={tab === 'outline'} className={tab === 'outline' ? 'on' : ''} onClick={() => switchTab('outline')} data-testid="tab-outline">
          アウトライン
        </button>
      </div>
      {tab === 'outline' ? (
        <nav className="side-outline" aria-label="アウトライン">
          {showOutline ? <Outline source={outline!.source} onJump={outline!.jump} /> : <div className="muted small outline-empty">ページを開くと見出しが表示されます。</div>}
        </nav>
      ) : (
        <>
        <input className="search" type="search" placeholder="ページ名で検索" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ページ名で検索" data-testid="search" />
        <button className="btn btn-block quick-btn" onClick={openQuick} data-testid="quick-open">
          ページを開く… <kbd>{/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'}K</kbd>
        </button>
        {canEdit && (
          <button className="btn btn-block" onClick={() => openNewPage('')} data-testid="new-page">
            ＋ 新しいページ
          </button>
        )}
        <nav className="tree" aria-label="ページ階層">
          <NavLink end to={`/w/${wiki.slug}?list`} className="tree-home">
            すべてのページ
          </NavLink>
          {tree.length === 0 && <div className="muted small tree-empty">{q ? '該当するページがありません' : 'ページはまだありません'}</div>}
          <TreeList nodes={tree} forceOpen={!!q} />
        </nav>
        </>
      )}
      <div className="sidebar-bottom">
        <NavLink to={`/w/${wiki.slug}/settings`} className="side-link">
          共有設定・メンバー
        </NavLink>
        <a href="/help" target="_blank" rel="noopener" className="side-link" data-testid="help-link">
          ヘルプ
        </a>
        <UserMenu email={me.user.email} onLogout={logout} />
      </div>
    </aside>
  )
}

function TreeList({ nodes, forceOpen }: { nodes: TreeNode[]; forceOpen: boolean }) {
  return (
    <ul>
      {nodes.map((n) => (
        <TreeItem key={n.name} node={n} forceOpen={forceOpen} />
      ))}
    </ul>
  )
}

function TreeItem({ node, forceOpen }: { node: TreeNode; forceOpen: boolean }) {
  const { wiki } = useWiki()
  const loc = useLocation()
  const url = pageUrl(wiki.slug, node.name)
  const current = decodeURIComponent(loc.pathname) === decodeURIComponent(url)
  const inPath = decodeURIComponent(loc.pathname).startsWith(decodeURIComponent(url) + '/')
  const [open, setOpen] = useState(inPath)
  useEffect(() => {
    if (inPath) setOpen(true)
  }, [inPath])
  const expanded = forceOpen || open
  return (
    <li>
      <div className={`tree-row ${current ? 'current' : ''}`}>
        {node.children.length ? (
          <button className="tree-toggle" onClick={() => setOpen(!open)} aria-label={expanded ? '閉じる' : '開く'}>
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="tree-toggle" />
        )}
        <Link to={url} className={node.pageId ? '' : 'virtual'} title={node.pageId ? node.name : `${node.name}（本文なし）`}>
          {node.label}
        </Link>
      </div>
      {expanded && node.children.length > 0 && <TreeList nodes={node.children} forceOpen={forceOpen} />}
    </li>
  )
}

function UserMenu({ email, onLogout }: { email: string; onLogout: () => void }) {
  const { me, setMe } = useSession()
  const [open, setOpen] = useState(false)
  const listMode = me.settings.listMode ?? 'list'
  const save = async (patch: Partial<Me['settings']>) => {
    const r = await api<{ settings: Me['settings'] }>('PUT', '/api/me/settings', patch)
    setMe({ ...me, settings: r.settings })
  }
  const setListMode = (m: 'list' | 'item') => save({ listMode: m })
  return (
    <div className="user-menu">
      <button className="side-link" onClick={() => setOpen(!open)} aria-expanded={open}>
        {email}
      </button>
      {open && (
        <div className="user-pop">
          <label className="small">
            リストの編集単位
            <select value={listMode} onChange={(e) => setListMode(e.target.value as 'list' | 'item')} data-testid="pref-list-mode">
              <option value="list">リスト全体</option>
              <option value="item">一項目とその配下</option>
            </select>
          </label>
          <label className="small">
            段落内の改行
            <select value={me.settings.softBreak ?? 'break'} onChange={(e) => save({ softBreak: e.target.value as 'break' | 'join' })} data-testid="pref-soft-break">
              <option value="break">改行として表示</option>
              <option value="join">GFM のまま空白を詰める</option>
            </select>
          </label>
          <button className="link-btn" onClick={onLogout}>
            ログアウト
          </button>
        </div>
      )}
    </div>
  )
}


function NewPageDialog({ initial, onClose, onCreate }: { initial: string; onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial)
  const [err, setErr] = useState<string | null>(null)
  return (
    <Modal title="新しいページ" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!normalizePageName(name)) return setErr('ページ名を入力してください')
          try {
            await onCreate(name)
          } catch (e) {
            setErr(e instanceof ApiError && e.body?.error === 'invalid_name' ? 'このページ名は使えません（[ ] | # は使用不可）' : '作成に失敗しました')
          }
        }}
      >
        <input autoFocus className="input-block" value={name} onChange={(e) => setName(e.target.value)} placeholder="例: 開発/API/認証" data-testid="new-page-name" />
        <p className="muted small">「/」で区切ると階層になります。親ページがなくても作成できます。</p>
        {err && <p className="error small">{err}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" className="btn btn-primary">
            作成
          </button>
        </div>
      </form>
    </Modal>
  )
}
