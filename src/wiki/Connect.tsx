import { useEffect, useState } from 'react'
import { api, ApiError, ROLE_LABEL, type Role } from '../api'
import { useSession } from '../App'

interface WikiChoice {
  id: string
  name: string
  slug: string
  role: Role
}
interface AuthInfo {
  client: { name: string; redirectHost: string }
  wiki: WikiChoice | null
  wikis: WikiChoice[]
  wantsWrite: boolean
  denyUrl: string
}

/**
 * OAuth consent for an MCP client (/oauth/authorize hands over here with its query):
 * which app wants to use which wiki, read-only or read-write.
 */
export function Connect() {
  const { me } = useSession()
  const query = location.search.replace(/^\?/, '')
  const [info, setInfo] = useState<AuthInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [wikiId, setWikiId] = useState('')
  const [access, setAccess] = useState<'write' | 'read'>('write')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<AuthInfo>('GET', `/api/oauth/request?${query}`)
      .then((r) => {
        setInfo(r)
        const w = r.wiki ?? r.wikis[0]
        if (w) setWikiId(w.id)
      })
      .catch((e) => setError(e instanceof ApiError && typeof (e.body as { message?: string })?.message === 'string' ? (e.body as { message: string }).message : '接続の要求を確認できませんでした。'))
  }, [query])

  const wiki = info?.wiki ?? info?.wikis.find((w) => w.id === wikiId) ?? null
  const canWrite = !!wiki && wiki.role !== 'viewer'
  useEffect(() => {
    if (info) setAccess(canWrite && info.wantsWrite ? 'write' : 'read')
  }, [info, canWrite])

  const approve = async () => {
    setBusy(true)
    try {
      const r = await api<{ redirect: string }>('POST', '/api/oauth/approve', { query, wikiId, access })
      location.href = r.redirect
    } catch {
      setBusy(false)
      setError('許可できませんでした。もう一度お試しください。')
    }
  }

  return (
    <div className="login">
      <div className="login-card connect-card" data-testid="connect">
        <h1>wiki への接続</h1>
        {error ? (
          <p className="notice">{error}</p>
        ) : !info ? (
          <p className="muted">読み込み中…</p>
        ) : (
          <>
            <p>
              <strong data-testid="connect-client">{info.client.name}</strong>
              <span className="muted small">（{info.client.redirectHost}）</span> が、あなた（{me.user.email}）として wiki を使えるようにします。
            </p>
            {info.wiki ? (
              <p>
                wiki: <strong data-testid="connect-wiki">{info.wiki.name}</strong>
                <span className="muted small">（あなたは{ROLE_LABEL[info.wiki.role]}）</span>
              </p>
            ) : info.wikis.length ? (
              <label className="connect-field">
                接続する wiki
                <select value={wikiId} onChange={(e) => setWikiId(e.target.value)} data-testid="connect-wiki-select">
                  {info.wikis.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="notice">接続できる wiki がありません。</p>
            )}
            {wiki && (
              <fieldset className="connect-field">
                <legend>できること</legend>
                <label>
                  <input type="radio" name="access" checked={access === 'write'} disabled={!canWrite} onChange={() => setAccess('write')} data-testid="connect-write" />
                  読み書き（ページを読む・検索する・作る・書き換える）
                </label>
                <label>
                  <input type="radio" name="access" checked={access === 'read'} onChange={() => setAccess('read')} data-testid="connect-read" />
                  読むだけ（ページを読む・検索する）
                </label>
                {!canWrite && <div className="muted small">閲覧者なので、読むだけになります。</div>}
              </fieldset>
            )}
            <p className="muted small">変更はページの履歴に「MCP」として残ります。接続は wiki の「共有設定・メンバー」からいつでも取り消せます。</p>
            <div className="connect-actions">
              <button className="btn" onClick={() => (location.href = info.denyUrl)} disabled={busy}>
                拒否
              </button>
              <button className="btn btn-primary" onClick={approve} disabled={busy || !wiki} data-testid="connect-approve">
                許可する
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
