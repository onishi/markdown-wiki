import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError, ROLE_LABEL, type Role } from '../api'
import { useSession } from '../App'
import { useWiki } from './WikiLayout'
import { Modal } from './Modal'
import { normalizeSlug, validateSlug } from '../../shared/wikiSlug'

interface Member {
  userId: string
  email: string
  name: string
  role: Role
}
interface Invitation {
  email: string
  role: Role
}

const ERRORS: Record<string, string> = {
  last_owner: 'オーナーが一人もいなくなるため変更できません。',
  already_member: 'すでにメンバーです。',
  invalid_email: 'メールアドレスが正しくありません。',
  forbidden: '権限がありません。',
  slug_taken: 'その識別子はすでに使われています。',
  invalid_slug: '識別子は半角英小文字・数字・ハイフンで 2〜32 文字にしてください。',
}

export function WikiSettings() {
  const { wiki, role, pages, reloadWiki } = useWiki()
  const { me } = useSession()
  const nav = useNavigate()
  const isOwner = role === 'owner'
  const [members, setMembers] = useState<Member[]>([])
  const [invites, setInvites] = useState<Invitation[]>([])
  const [email, setEmail] = useState('')
  const [newRole, setNewRole] = useState<Role>('editor')
  const [msg, setMsg] = useState<string | null>(null)
  const [name, setName] = useState(wiki.name)
  const [slug, setSlug] = useState(wiki.slug)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    const r = await api<{ members: Member[]; invitations: Invitation[] }>('GET', `/api/wikis/${wiki.id}/members`)
    setMembers(r.members)
    setInvites(r.invitations)
  }, [wiki.id])
  useEffect(() => {
    load()
  }, [load])

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null)
    try {
      await fn()
      if (ok) setMsg(ok)
      await load()
    } catch (e) {
      const code = (e as ApiError).body?.error
      setMsg(ERRORS[code] ?? '操作に失敗しました。')
    }
  }

  return (
    <div className="page settings">
      <h1 className="page-title">共有設定</h1>
      <p className="muted">
        この wiki は<strong>非公開</strong>です。メンバーだけがアクセスできます。あなたの権限: {ROLE_LABEL[role]}
      </p>
      {msg && <div className="notice">{msg}</div>}

      <section>
        <h3>メンバー</h3>
        <table className="members">
          <tbody>
            {members.map((m) => (
              <tr key={m.userId} data-testid={`member-${m.email}`}>
                <td>
                  {m.name} <span className="muted small">{m.email}</span>
                  {m.userId === me.user.id && <span className="muted small">（あなた）</span>}
                </td>
                <td>
                  {isOwner ? (
                    <select value={m.role} onChange={(e) => run(() => api('PATCH', `/api/wikis/${wiki.id}/members/${m.userId}`, { role: e.target.value }), '権限を変更しました。')}>
                      {(['owner', 'editor', 'viewer'] as Role[]).map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    ROLE_LABEL[m.role]
                  )}
                </td>
                <td>
                  {(isOwner || m.userId === me.user.id) && (
                    <button
                      className="link-btn danger"
                      onClick={() =>
                        run(async () => {
                          await api('DELETE', `/api/wikis/${wiki.id}/members/${m.userId}`)
                          if (m.userId === me.user.id) nav('/')
                        })
                      }
                    >
                      {m.userId === me.user.id ? '退出' : '削除'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {invites.map((i) => (
              <tr key={i.email} className="invite-row">
                <td>
                  {i.email} <span className="muted small">招待中（このアカウントでログインすると参加）</span>
                </td>
                <td>{ROLE_LABEL[i.role]}</td>
                <td>
                  {isOwner && (
                    <button className="link-btn danger" onClick={() => run(() => api('DELETE', `/api/wikis/${wiki.id}/invitations/${encodeURIComponent(i.email)}`))}>
                      取り消し
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {isOwner && (
        <>
          <section>
            <h3>メンバーを招待</h3>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault()
                run(() => api('POST', `/api/wikis/${wiki.id}/invitations`, { email, role: newRole }), `${email} を招待しました。`).then(() => setEmail(''))
              }}
            >
              <input type="email" required placeholder="Google アカウントのメールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="invite-email" />
              <select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)} data-testid="invite-role">
                <option value="editor">編集者</option>
                <option value="viewer">閲覧者</option>
                <option value="owner">オーナー</option>
              </select>
              <button className="btn btn-primary" type="submit">
                招待
              </button>
            </form>
            <p className="muted small">オーナー: メンバーと権限の管理 / 編集者: ページの作成・編集・削除 / 閲覧者: 閲覧とコピー</p>
          </section>
          <section>
            <h3>トップページ</h3>
            <p className="muted small">wiki の URL（ページ名なし）を開いたときに表示するページです。未設定ならページ一覧を表示します。</p>
            <select
              value={wiki.topPageId ?? ''}
              data-testid="top-page"
              onChange={(e) => run(async () => (await api('PATCH', `/api/wikis/${wiki.id}`, { topPageId: e.target.value || null }), await reloadWiki()), 'トップページを変更しました。')}
            >
              <option value="">（なし：ページ一覧）</option>
              {pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </section>
          <section>
            <h3>AI による編集の提案</h3>
            {wiki.aiAvailable ? (
              <>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={!!wiki.aiEnabled}
                    data-testid="ai-enabled"
                    onChange={(e) => {
                      const on = e.target.checked
                      run(async () => (await api('PATCH', `/api/wikis/${wiki.id}`, { aiEnabled: on }), await reloadWiki()), on ? 'AI の提案を有効にしました。' : 'AI の提案を無効にしました。')
                    }}
                  />
                  編集者がページの「AI」から修正の提案を受けられるようにする
                </label>
                <p className="muted small">提案を作るとき、対象の文章とページの内容が Google の Gemini API に送られます。提案は差分で確認し、選んだ変更だけが保存されます。</p>
              </>
            ) : (
              <p className="muted small">サーバーに Gemini の API キー（GOOGLE_AI_API_KEY）が設定されていないため使えません。</p>
            )}
          </section>
          <section>
            <h3>URL の識別子</h3>
            <p className="muted small">
              ページの URL は <code>{location.origin}/w/{wiki.slug}/p/ページ名</code> です。変更しても、前の識別子の URL は新しい識別子へ転送されます。
            </p>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault()
                const s = normalizeSlug(slug)
                const bad = validateSlug(s)
                if (bad) return setMsg(`識別子: ${bad}`)
                run(async () => {
                  await api('PATCH', `/api/wikis/${wiki.id}`, { slug: s })
                  await reloadWiki()
                  nav(`/w/${s}/settings`, { replace: true })
                }, '識別子を変更しました。')
              }}
            >
              <span className="slug-input">
                <span className="muted">/w/</span>
                <input value={slug} onChange={(e) => setSlug(e.target.value)} data-testid="wiki-slug" aria-label="URL の識別子" />
              </span>
              <button className="btn" type="submit">
                変更
              </button>
            </form>
          </section>
          <section>
            <h3>wiki の名前</h3>
            <form className="inline-form" onSubmit={(e) => (e.preventDefault(), run(async () => (await api('PATCH', `/api/wikis/${wiki.id}`, { name }), await reloadWiki()), '名前を変更しました。'))}>
              <input value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn" type="submit">
                変更
              </button>
            </form>
          </section>
          <section>
            <h3>wiki の削除</h3>
            <button className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
              この wiki を削除
            </button>
          </section>
        </>
      )}
      {confirmDelete && <DeleteWiki name={wiki.name} onClose={() => setConfirmDelete(false)} onConfirm={async () => (await api('DELETE', `/api/wikis/${wiki.id}`), nav('/'))} />}
    </div>
  )
}

function DeleteWiki({ name, onClose, onConfirm }: { name: string; onClose: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = useState('')
  return (
    <Modal title="wiki を削除" onClose={onClose}>
      <p>すべてのページとメンバー設定が削除されます。確認のため wiki の名前「{name}」を入力してください。</p>
      <input className="input-block" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          キャンセル
        </button>
        <button className="btn btn-danger" disabled={typed !== name} onClick={onConfirm}>
          削除する
        </button>
      </div>
    </Modal>
  )
}
