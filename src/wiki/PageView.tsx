import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HistoryDialog } from './HistoryDialog'
import { HelpDialog } from './HelpDialog'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, pageUrl, type Page, type PageSummary, uploadImage } from '../api'
import { normalizePageName } from '../../shared/pageName'
import { DocEditor, type DocEditorHandle } from '../editor/DocEditor'
import { useSession } from '../App'
import { useWiki } from './WikiLayout'
import { readDraft, usePageSaver, type Conflict } from './usePageSaver'
import { ConflictDialog } from './ConflictDialog'
import { Modal } from './Modal'

type Loaded =
  | { kind: 'loading' }
  | { kind: 'page'; page: Page; initialContent: string; conflict: Conflict | null; restored: boolean; renamedFrom?: string }
  | { kind: 'missing'; name: string; children: { id: string; name: string }[] }
  | { kind: 'error'; message: string }

export function PageRoute() {
  const params = useParams()
  const name = normalizePageName(params['*'] ?? '')
  const { wiki } = useWiki()
  // /w/<slug>/p/ (no page name) → the wiki's home, which forwards to its top page.
  if (!name) return <Navigate to={`/w/${wiki.slug}`} replace />
  return <PageRouteFor name={name} />
}

function PageRouteFor({ name }: { name: string }) {
  const { wiki } = useWiki()
  const nav = useNavigate()
  const [state, setState] = useState<Loaded>({ kind: 'loading' })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let alive = true
    setState({ kind: 'loading' })
    api<{ page: Page; via: 'name' | 'alias' }>('GET', `/api/wikis/${wiki.id}/resolve?name=${encodeURIComponent(name)}`)
      .then(async (r) => {
        if (!alive) return
        if (r.via === 'alias') {
          nav(pageUrl(wiki.slug, r.page.name), { replace: true, state: { renamedFrom: name } })
          return
        }
        const draft = readDraft(r.page.id)
        let initialContent = r.page.content
        let conflict: Conflict | null = null
        let restored = false
        if (draft && draft.content !== r.page.content) {
          restored = true
          initialContent = draft.content
          if (draft.baseVersion !== r.page.version) {
            const base = await api<{ revision: { content: string } }>('GET', `/api/wikis/${wiki.id}/pages/${r.page.id}/revisions/${draft.baseVersion}`).catch(() => null)
            conflict = { current: r.page, base: base?.revision.content ?? null }
          }
        }
        if (alive) setState({ kind: 'page', page: r.page, initialContent, conflict, restored, renamedFrom: (history.state?.usr as any)?.renamedFrom })
      })
      .catch((e: ApiError) => {
        if (!alive) return
        if (e.status === 404 && e.body?.name) setState({ kind: 'missing', name, children: e.body.children ?? [] })
        else setState({ kind: 'error', message: e.status === 0 ? 'ネットワークに接続できません。' : '読み込みに失敗しました。' })
      })
    return () => {
      alive = false
    }
  }, [wiki.id, name, nonce, nav])

  if (state.kind === 'loading') return <div className="page-loading muted">読み込み中…</div>
  if (state.kind === 'error')
    return (
      <div className="page">
        <p className="error">{state.message}</p>
        <button className="btn" onClick={() => setNonce((n) => n + 1)}>
          再読み込み
        </button>
      </div>
    )
  if (state.kind === 'missing') return <MissingPage name={state.name} children={state.children} onCreated={() => setNonce((n) => n + 1)} />
  return <PageView key={`${state.page.id}:${nonce}`} loaded={state} reload={() => setNonce((n) => n + 1)} />
}

function Breadcrumb({ name }: { name: string }) {
  const { wiki, pages } = useWiki()
  const segs = name.split('/')
  // Root crumb: the wiki's top page (or the wiki itself), unless this page is the top page or under it.
  const top = wiki.topPageId ? (pages.find((p) => p.id === wiki.topPageId)?.name ?? wiki.topPage ?? null) : null
  const showRoot = !top || (name !== top && !name.startsWith(top + '/'))
  return (
    <nav className="breadcrumb" aria-label="階層" data-testid="breadcrumb">
      {showRoot && (
        <span>
          <Link to={`/w/${wiki.slug}`} className="crumb-root">
            {top ?? wiki.name}
          </Link>
          <span className="sep">/</span>
        </span>
      )}
      {segs.map((s, i) => {
        const path = segs.slice(0, i + 1).join('/')
        return (
          <span key={path}>
            {i > 0 && <span className="sep">/</span>}
            {i === segs.length - 1 ? <span className="crumb-current">{s}</span> : <Link to={pageUrl(wiki.slug, path)}>{s}</Link>}
          </span>
        )
      })}
    </nav>
  )
}

function MissingPage({ name, children, onCreated }: { name: string; children: { id: string; name: string }[]; onCreated: () => void }) {
  const { wiki, canEdit, reloadPages } = useWiki()
  const [busy, setBusy] = useState(false)
  const create = async () => {
    setBusy(true)
    try {
      await api('POST', `/api/wikis/${wiki.id}/pages`, { name, content: '' })
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) {
        setBusy(false)
        return
      }
    }
    await reloadPages()
    onCreated()
  }
  return (
    <div className="page">
      <Breadcrumb name={name} />
      <h1 className="page-title missing-title">{name.split('/').pop()}</h1>
      <p className="muted">このページはまだ作成されていません。</p>
      {canEdit ? (
        <button className="btn btn-primary" onClick={create} disabled={busy} data-testid="create-missing">
          「{name}」を作成
        </button>
      ) : (
        <p className="muted small">閲覧者はページを作成できません。</p>
      )}
      {children.length > 0 && (
        <section className="children">
          <h3>下位のページ</h3>
          <ul>
            {children.map((c) => (
              <li key={c.id}>
                <Link to={pageUrl(wiki.slug, c.name)}>{c.name.slice(name.length + 1)}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function PageView({ loaded }: { loaded: Extract<Loaded, { kind: 'page' }>; reload: () => void }) {
  const { wiki, canEdit, resolveWiki, absoluteWiki, pages, reloadPages, openNewPage, setOutline } = useWiki()
  const editorHandle = useRef<DocEditorHandle | null>(null)
  const { me } = useSession()
  const nav = useNavigate()
  const page = loaded.page
  const saver = usePageSaver(wiki.id, page, loaded.initialContent, loaded.conflict)
  const [editing, setEditing] = useState(false)
  const [showConflict, setShowConflict] = useState(!!loaded.conflict)
  const [notice, setNotice] = useState<string | null>(
    loaded.renamedFrom ? `「${loaded.renamedFrom}」は「${page.name}」に名前が変わりました。` : loaded.restored && !loaded.conflict ? '保存されていなかった変更をこのブラウザから復元しました。' : null,
  )
  const [dialog, setDialog] = useState<'rename' | 'delete' | 'history' | null>(null)
  const [roNotice, setRoNotice] = useState(false)
  const [help, setHelp] = useState(false)

  // `?` (outside text fields, not while editing) shows the shortcut list.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as Element
      if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || editing) return
      if (t.closest('input, textarea, select, [contenteditable=true]')) return
      e.preventDefault()
      setHelp(true)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [editing])

  useEffect(() => {
    if (saver.conflict) setShowConflict(true)
  }, [saver.conflict])

  // Pick up other members' saves while we have no local changes.
  useEffect(() => {
    const t = setInterval(async () => {
      if (document.hidden || editing || saver.status !== 'saved') return
      try {
        const r = await api<{ page: Page }>('GET', `/api/wikis/${wiki.id}/pages/${page.id}`)
        if (r.page.version > saver.baseVersion() && saver.applyRemote(r.page)) {
          setNotice(`${r.page.updatedByName ?? '他のメンバー'} さんの更新を反映しました。`)
        }
      } catch {}
    }, 15000)
    return () => clearInterval(t)
  }, [wiki.id, page.id, editing, saver])

  // Feed the sidebar outline.
  useEffect(() => {
    setOutline({ source: saver.content, jump: (it) => editorHandle.current?.jumpTo(it.textStart) })
  }, [saver.content, setOutline])
  useEffect(() => () => setOutline(null), [setOutline])

  const wikiNames = useMemo(() => [...pages].sort((a, b) => b.updatedAt - a.updatedAt).map((p) => p.name), [pages])
  const childPages = useMemo(() => pages.filter((p) => p.name.startsWith(page.name + '/')), [pages, page.name])
  const openWiki = useCallback((t: string) => nav(pageUrl(wiki.slug, t)), [nav, wiki.slug])

  // Pages linking here; refreshed when the page list changes (creates, renames, deletes).
  const [backlinks, setBacklinks] = useState<PageSummary[]>([])
  useEffect(() => {
    let live = true
    api<{ pages: PageSummary[] }>('GET', `/api/wikis/${wiki.id}/pages/${page.id}/backlinks`)
      .then((r) => live && setBacklinks(r.pages))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [wiki.id, page.id, pages])

  return (
    <div className="page">
      <div className="page-head">
        <Breadcrumb name={page.name} />
        <div className="page-actions">
          <SaveIndicator saver={saver} onConflict={() => setShowConflict(true)} />
          <button className="btn btn-small" onClick={() => setDialog('history')} data-testid="history">
            履歴
          </button>
          {canEdit && <PageMenu onChild={() => openNewPage(page.name + '/')} onRename={() => setDialog('rename')} onDelete={() => setDialog('delete')} />}
        </div>
      </div>
      <h1 className="page-title">{page.name.split('/').pop()}</h1>
      {notice && (
        <div className="notice" role="status">
          {notice} <button className="link-btn" onClick={() => setNotice(null)}>閉じる</button>
        </div>
      )}
      <DocEditor
        source={saver.content}
        onChange={saver.onChange}
        readOnly={!canEdit}
        listMode={me.settings.listMode ?? 'list'}
        softBreak={me.settings.softBreak ?? 'break'}
        resolveWiki={resolveWiki}
        absoluteWiki={absoluteWiki}
        onOpenWiki={openWiki}
        onEditingChange={setEditing}
        handleRef={editorHandle}
        wikiNames={wikiNames}
        onUploadImage={canEdit ? (f) => uploadImage(wiki.id, f, f.name || 'image.png') : undefined}
        onReadOnlyAttempt={() => {
          setRoNotice(true)
          setTimeout(() => setRoNotice(false), 2000)
        }}
      />
      {childPages.length > 0 && (
        <section className="children">
          <h3>下位のページ</h3>
          <ul>
            {childPages.map((c) => (
              <li key={c.id}>
                <Link to={pageUrl(wiki.slug, c.name)}>{c.name.slice(page.name.length + 1)}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {backlinks.length > 0 && (
        <section className="backlinks" data-testid="backlinks">
          <h3>このページへのリンク</h3>
          <ul>
            {backlinks.map((b) => (
              <li key={b.id}>
                <Link to={pageUrl(wiki.slug, b.name)}>{b.name}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ModeBar editing={editing} canEdit={canEdit} roNotice={roNotice} onHelp={() => setHelp(true)} />
      {help && <HelpDialog onClose={() => setHelp(false)} />}
      {dialog === 'history' && (
        <HistoryDialog
          wikiId={wiki.id}
          pageId={page.id}
          current={saver.content}
          canRestore={canEdit && saver.status !== 'conflict'}
          onClose={() => setDialog(null)}
          onRestore={(content, version) => {
            saver.onChange(content)
            setDialog(null)
            setNotice(`版 ${version} の内容に戻しました（新しい版として保存されます。元に戻すときも履歴から選べます）。`)
          }}
        />
      )}
      {showConflict && saver.conflict && (
        <ConflictDialog
          conflict={saver.conflict}
          mine={saver.mine()}
          onResolve={async (text) => {
            setShowConflict(false)
            await saver.resolveConflict(text)
          }}
          onClose={() => setShowConflict(false)}
        />
      )}
      {dialog === 'rename' && (
        <RenameDialog
          page={page}
          onClose={() => setDialog(null)}
          onDone={async (newName) => {
            await reloadPages()
            setDialog(null)
            nav(pageUrl(wiki.slug, newName), { replace: true })
          }}
        />
      )}
      {dialog === 'delete' && (
        <Modal title="ページを削除" onClose={() => setDialog(null)}>
          <p>「{page.name}」を削除します。この操作は取り消せません。</p>
          {childPages.length > 0 && <p className="muted small">下位のページ（{childPages.length} 件）は削除されません。</p>}
          <div className="modal-actions">
            <button className="btn" onClick={() => setDialog(null)}>
              キャンセル
            </button>
            <button
              className="btn btn-danger"
              data-testid="confirm-delete"
              onClick={async () => {
                await api('DELETE', `/api/wikis/${wiki.id}/pages/${page.id}`)
                try {
                  localStorage.removeItem(`mw:draft:${page.id}`)
                } catch {}
                await reloadPages()
                nav(`/w/${wiki.slug}`)
              }}
            >
              削除する
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function SaveIndicator({ saver, onConflict }: { saver: ReturnType<typeof usePageSaver>; onConflict: () => void }) {
  const s = saver.status
  return (
    <span className={`save-status save-${s}`} data-testid="save-status" data-status={s} role="status" aria-live="polite">
      {s === 'saved' && '保存済み'}
      {s === 'dirty' && '未保存の変更'}
      {s === 'saving' && '保存中…'}
      {s === 'error' && (
        <>
          保存失敗{' '}
          <button className="link-btn" onClick={saver.retry} data-testid="retry-save">
            再試行
          </button>
          {saver.error && <span className="save-error-detail">{saver.error}</span>}
        </>
      )}
      {s === 'conflict' && (
        <>
          更新が競合しています{' '}
          <button className="link-btn" onClick={onConflict}>
            解決する
          </button>
        </>
      )}
    </span>
  )
}

function ModeBar({ editing, canEdit, roNotice, onHelp }: { editing: boolean; canEdit: boolean; roNotice: boolean; onHelp: () => void }) {
  const mod = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'
  const help = (
    <button className="mode-help" onClick={onHelp} data-testid="help-button" title="操作一覧（?）">
      ? 操作一覧
    </button>
  )
  return (
    <div className={`mode-bar ${editing ? 'mode-edit' : 'mode-view'}`} data-testid="mode-bar">
      {editing ? (
        <>
          <span className="mode-dot" /> 編集中 — <kbd>Esc</kbd> か「完了」で表示に戻る（自動保存） · <kbd>[[</kbd> でページ名を補完
        </>
      ) : canEdit ? (
        <>
          表示中 — <kbd>Enter</kbd> / ダブルクリックで編集 · <kbd>{mod}+Z</kbd> で取り消し {help}
        </>
      ) : (
        <>
          {roNotice ? <strong>閲覧者のため編集できません</strong> : '閲覧のみ'} — 選択して右クリックでコピー {help}
        </>
      )}
    </div>
  )
}

function PageMenu({ onChild, onRename, onDelete }: { onChild: () => void; onRename: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])
  const item = (label: string, fn: () => void, extra?: { danger?: boolean; testid?: string }) => (
    <button
      role="menuitem"
      className={extra?.danger ? 'danger' : ''}
      data-testid={extra?.testid}
      onClick={() => {
        setOpen(false)
        fn()
      }}
    >
      {label}
    </button>
  )
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="btn btn-small" aria-haspopup="menu" aria-expanded={open} aria-label="ページの操作" title="ページの操作" onClick={() => setOpen((o) => !o)} data-testid="page-menu">
        …
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {item('子ページを作成', onChild)}
          {item('名前を変更', onRename, { testid: 'rename' })}
          {item('削除', onDelete, { danger: true, testid: 'delete' })}
        </div>
      )}
    </div>
  )
}

function RenameDialog({ page, onClose, onDone }: { page: Page; onClose: () => void; onDone: (name: string) => Promise<void> }) {
  const { wiki } = useWiki()
  const [name, setName] = useState(page.name)
  const [children, setChildren] = useState(true)
  const [rewrite, setRewrite] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  return (
    <Modal title="名前を変更" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          try {
            const r = await api<{ page: Page }>('POST', `/api/wikis/${wiki.id}/pages/${page.id}/rename`, { name, includeChildren: children, rewriteLinks: rewrite })
            await onDone(r.page?.name ?? normalizePageName(name))
          } catch (e) {
            const b = (e as ApiError).body
            setErr(b?.error === 'exists' ? `「${b.name}」は既に存在します` : b?.error === 'invalid_name' ? 'このページ名は使えません' : '変更に失敗しました')
          }
        }}
      >
        <input autoFocus className="input-block" value={name} onChange={(e) => setName(e.target.value)} data-testid="rename-input" />
        <label className="check">
          <input type="checkbox" checked={children} onChange={(e) => setChildren(e.target.checked)} /> 下位のページも一緒に移動する
        </label>
        <label className="check">
          <input type="checkbox" checked={rewrite} onChange={(e) => setRewrite(e.target.checked)} /> wiki 内の <code>[[{page.name}]]</code> を新しい名前に書き換える
        </label>
        <p className="muted small">書き換えない場合も、旧名へのリンクは自動的にこのページへ転送されるため切れません。</p>
        {err && <p className="error small">{err}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" className="btn btn-primary">
            変更
          </button>
        </div>
      </form>
    </Modal>
  )
}
