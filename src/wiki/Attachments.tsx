import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, pageUrl } from '../api'
import { fullTime, relTime } from '../time'
import { useWiki, HeaderTitle } from './WikiLayout'

export interface Attachment {
  id: string
  name: string
  type: string
  size: number
  createdAt: number
  byName: string | null
  url: string
  /** Pages whose text refers to the file. */
  pages: { id: string; name: string }[]
}

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** Every uploaded file in the wiki, with the pages that show it. */
export function Attachments() {
  const { wiki } = useWiki()
  const [files, setFiles] = useState<Attachment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unused, setUnused] = useState(false)

  useEffect(() => {
    setFiles(null)
    api<{ files: Attachment[] }>('GET', `/api/wikis/${wiki.id}/files`)
      .then((r) => setFiles(r.files))
      .catch(() => setError('添付ファイルを読み込めませんでした。'))
  }, [wiki.id])

  const unusedCount = files?.filter((f) => !f.pages.length).length ?? 0
  const shown = unused ? files?.filter((f) => !f.pages.length) : files
  const total = files?.reduce((n, f) => n + f.size, 0) ?? 0

  return (
    <div className="page">
      <HeaderTitle>添付ファイル</HeaderTitle>
      <h1 className="page-title">添付ファイル</h1>
      {error && <div className="notice">{error}</div>}
      {!files ? (
        !error && <p className="muted">読み込み中…</p>
      ) : files.length === 0 ? (
        <p className="muted">まだ添付ファイルはありません。編集中に画像を貼り付けるかドロップすると、ここに並びます。</p>
      ) : (
        <>
          <div className="section-head">
            <span className="muted small section-count">
              {files.length} 件・{kb(total)}
            </span>
            <span className="seg small" role="group" aria-label="絞り込み">
              <button className={!unused ? 'on' : ''} onClick={() => setUnused(false)}>
                すべて
              </button>
              <button className={unused ? 'on' : ''} onClick={() => setUnused(true)} data-testid="files-unused">
                どこからも使われていない（{unusedCount}）
              </button>
            </span>
          </div>
          <ul className="files" data-testid="files">
            {shown!.map((f) => (
              <li key={f.id} className="file-row" data-testid="file-row">
                <a href={f.url} target="_blank" rel="noopener" className="file-thumb" title="元の画像を開く">
                  {f.type.startsWith('image/') ? <img src={f.url} alt={f.name} loading="lazy" /> : <span>{f.type}</span>}
                </a>
                <div className="file-body">
                  <div className="file-name">{f.name}</div>
                  <div className="muted small" title={fullTime(f.createdAt)}>
                    {kb(f.size)} · {f.byName ? `${f.byName} さんが` : ''}
                    {relTime(f.createdAt)}に追加
                  </div>
                  <div className="file-refs small" data-testid="file-refs">
                    {f.pages.length ? (
                      <>
                        <span className="muted">使っているページ:</span>
                        {f.pages.map((p) => (
                          <Link key={p.id} to={pageUrl(wiki.slug, p.name)}>
                            {p.name}
                          </Link>
                        ))}
                      </>
                    ) : (
                      <span className="tag tag-stale">どのページからも使われていません</span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
