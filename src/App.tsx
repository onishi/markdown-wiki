import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { api, ApiError, type Me, type WikiSummary, ROLE_LABEL, wikiUrl } from './api'
import { normalizeSlug, validateSlug } from '../shared/wikiSlug'
import { Playground } from './Playground'
import { WikiLayout } from './wiki/WikiLayout'
import { PageRoute } from './wiki/PageView'
import { WikiHome } from './wiki/WikiHome'
import { WikiSettings } from './wiki/WikiSettings'

interface Session {
  me: Me
  setMe: (m: Me) => void
  logout: () => void
}
const SessionCtx = createContext<Session | null>(null)
export const useSession = () => useContext(SessionCtx)!

export function App() {
  return (
    <Routes>
      <Route path="/playground" element={<Playground />} />
      <Route path="/login" element={<Login />} />
      <Route path="*" element={<Authed />} />
    </Routes>
  )
}

function Authed() {
  const [me, setMe] = useState<Me | null | 'anon'>(null)
  const loc = useLocation()
  useEffect(() => {
    api<Me>('GET', '/api/me')
      .then(setMe)
      .catch((e) => setMe(e instanceof ApiError && e.status === 401 ? 'anon' : 'anon'))
  }, [])
  const logout = useCallback(async () => {
    await api('POST', '/auth/logout').catch(() => {})
    location.href = '/login'
  }, [])
  if (me === null) return <div className="center-msg">読み込み中…</div>
  if (me === 'anon') return <Navigate to={`/login?returnTo=${encodeURIComponent(loc.pathname + loc.search)}`} replace />
  return (
    <SessionCtx.Provider value={{ me, setMe, logout }}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/w/:wid" element={<WikiLayout />}>
          <Route index element={<WikiHome />} />
          <Route path="p/*" element={<PageRoute />} />
          <Route path="settings" element={<WikiSettings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SessionCtx.Provider>
  )
}

function Login() {
  const [cfg, setCfg] = useState<{ google: boolean; devLogin: boolean } | null>(null)
  const [email, setEmail] = useState('')
  const params = new URLSearchParams(location.search)
  const returnTo = params.get('returnTo') ?? '/'
  useEffect(() => {
    fetch('/auth/config')
      .then((r) => r.json())
      .then(setCfg)
      .catch(() => setCfg({ google: false, devLogin: false }))
  }, [])
  return (
    <div className="login">
      <div className="login-card">
        <h1>Markdown Wiki</h1>
        <p className="muted">読むように書く、Markdown の wiki。</p>
        {cfg?.google ? (
          <a className="btn btn-primary btn-block" href={`/auth/google?returnTo=${encodeURIComponent(returnTo)}`} data-testid="google-login">
            Google でログイン
          </a>
        ) : (
          cfg && (
            <p className="notice">
              Google ログインが未設定です。サーバーに <code>GOOGLE_CLIENT_ID</code> と <code>GOOGLE_CLIENT_SECRET</code> を設定してください（README 参照）。
            </p>
          )
        )}
        {cfg?.devLogin && (
          <form
            className="dev-login"
            onSubmit={(e) => {
              e.preventDefault()
              location.href = `/auth/dev-login?email=${encodeURIComponent(email)}&returnTo=${encodeURIComponent(returnTo)}`
            }}
          >
            <div className="muted small">開発用ログイン（DEV_LOGIN=1 のときのみ）</div>
            <input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="dev-email" />
            <button className="btn" type="submit">
              開発用ログイン
            </button>
          </form>
        )}
        <p className="small try-link">
          <a href="/playground">ログインせずにエディタを試す</a>
          <span className="muted">（保存されません）</span>
        </p>
      </div>
    </div>
  )
}

function Home() {
  const { me, logout } = useSession()
  const [wikis, setWikis] = useState<WikiSummary[] | null>(null)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const nav = useNavigate()
  useEffect(() => {
    api<{ wikis: WikiSummary[] }>('GET', '/api/wikis').then((r) => setWikis(r.wikis))
  }, [])
  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    const s = normalizeSlug(slug)
    const bad = s ? validateSlug(s) : null
    if (bad) return setErr(`識別子: ${bad}`)
    try {
      const r = await api<{ wiki: WikiSummary }>('POST', '/api/wikis', { name, slug: s || undefined })
      nav(wikiUrl(r.wiki.slug))
    } catch (e) {
      setErr((e as ApiError).body?.error === 'slug_taken' ? `識別子「${s}」はすでに使われています。` : 'wiki を作成できませんでした。')
    }
  }
  return (
    <div className="home">
      <header className="home-header">
        <h1>Markdown Wiki</h1>
        <div className="muted">
          {me.user.email} · <button className="link-btn" onClick={logout}>ログアウト</button>
        </div>
      </header>
      <section>
        <h2>あなたの wiki</h2>
        {wikis === null ? (
          <p className="muted">読み込み中…</p>
        ) : wikis.length === 0 ? (
          <p className="muted">まだ wiki がありません。最初の wiki を作成しましょう。</p>
        ) : (
          <ul className="wiki-list">
            {wikis.map((w) => (
              <li key={w.id}>
                <a href={wikiUrl(w.slug)} onClick={(e) => (e.preventDefault(), nav(wikiUrl(w.slug)))}>
                  {w.name}
                </a>
                <span className="muted small">
                  {ROLE_LABEL[w.role]} · {w.pageCount} ページ · {w.memberCount} 人
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <form className="new-wiki" onSubmit={create}>
        <h3>新しい wiki</h3>
        <label className="field">
          <span className="field-label">名前</span>
          <input value={name} onChange={(e) => setName(e.target.value)} data-testid="new-wiki-name" />
        </label>
        <label className="field">
          <span className="field-label">URL</span>
          <span className="slug-input">
            <span className="muted">{location.host}/w/</span>
            <input placeholder="識別子（省略可）" value={slug} onChange={(e) => (setSlug(e.target.value), setErr(null))} data-testid="new-wiki-slug" aria-label="URL の識別子" />
          </span>
        </label>
        <p className="field-hint muted small">半角英小文字・数字・ハイフン。省略すると自動で付きます。あとから共有設定で変更できます。</p>
        {err && <div className="notice field-hint">{err}</div>}
        <div className="field-hint">
          <button className="btn btn-primary" type="submit">
            wiki を作成
          </button>
        </div>
      </form>
      <p className="muted small">新しい wiki は非公開で作成され、あなたがオーナーになります。あとから共有設定でメンバーを招待できます。</p>
    </div>
  )
}
