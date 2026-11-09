import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type Page } from '../api'

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

export interface Conflict {
  current: Page
  base: string | null
}

interface Draft {
  content: string
  baseVersion: number
  at: number
}

const draftKey = (pageId: string) => `mw:draft:${pageId}`

export function readDraft(pageId: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(pageId))
    return raw ? (JSON.parse(raw) as Draft) : null
  } catch {
    return null
  }
}

/**
 * Autosave with optimistic concurrency.
 *  - Every change is written to a local draft first (survives reloads / failures).
 *  - Saves are debounced and serialised; the server rejects stale base versions (409).
 *  - Network/server errors retry with backoff and can be retried manually.
 *  - On conflict saving stops (nothing is overwritten) until the user resolves it.
 */
export function usePageSaver(wikiId: string, page: Page, initialContent: string, initialConflict: Conflict | null) {
  const [content, setContent] = useState(initialContent)
  const [status, setStatus] = useState<SaveStatus>(initialConflict ? 'conflict' : initialContent !== page.content ? 'dirty' : 'saved')
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(initialConflict)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const base = useRef({ version: page.version, content: page.content })
  const latest = useRef(initialContent)
  const inflight = useRef(false)
  const blocked = useRef(!!initialConflict)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const backoff = useRef(2000)
  const pageId = page.id

  const writeDraft = useCallback(
    (c: string) => {
      try {
        localStorage.setItem(draftKey(pageId), JSON.stringify({ content: c, baseVersion: base.current.version, at: Date.now() } satisfies Draft))
      } catch {}
    },
    [pageId],
  )
  const clearDraft = useCallback(() => {
    try {
      localStorage.removeItem(draftKey(pageId))
    } catch {}
  }, [pageId])

  const flushRef = useRef<() => Promise<void>>(async () => {})
  const schedule = useCallback((ms: number) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flushRef.current(), ms)
  }, [])

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    if (inflight.current || blocked.current) return
    const sending = latest.current
    if (sending === base.current.content) {
      clearDraft()
      setStatus('saved')
      return
    }
    inflight.current = true
    setStatus('saving')
    try {
      const r = await api<{ page: Page }>('PUT', `/api/wikis/${wikiId}/pages/${pageId}`, { content: sending, baseVersion: base.current.version })
      base.current = { version: r.page.version, content: r.page.content }
      backoff.current = 2000
      inflight.current = false
      setError(null)
      setSavedAt(Date.now())
      if (latest.current !== sending) {
        writeDraft(latest.current)
        setStatus('dirty')
        schedule(300)
      } else {
        clearDraft()
        setStatus('saved')
      }
    } catch (e) {
      inflight.current = false
      const err = e as ApiError
      if (err.status === 409 && err.body?.current) {
        blocked.current = true
        setConflict({ current: err.body.current, base: err.body.base ?? null })
        setStatus('conflict')
        return
      }
      setStatus('error')
      if (err.status === 403) setError('編集権限がありません。内容はこのブラウザに保持されています。')
      else if (err.status === 404) setError('ページが見つかりません（削除された可能性があります）。内容はこのブラウザに保持されています。')
      else if (err.status === 401) setError('ログインが切れました。再ログイン後に再試行してください（内容は保持されています）。')
      else {
        setError(err.status === 0 ? 'ネットワークに接続できません。自動で再試行します。' : '保存に失敗しました。自動で再試行します。')
        schedule(backoff.current)
        backoff.current = Math.min(backoff.current * 2, 30000)
      }
    }
  }, [wikiId, pageId, clearDraft, writeDraft, schedule])
  flushRef.current = flush

  const onChange = useCallback(
    (c: string) => {
      latest.current = c
      setContent(c)
      writeDraft(c)
      if (blocked.current) return
      setStatus((s) => (s === 'error' ? s : 'dirty'))
      schedule(800)
    },
    [writeDraft, schedule],
  )

  /** Save `resolved` on top of the latest server version. */
  const resolveConflict = useCallback(
    async (resolved: string) => {
      if (!conflict) return
      base.current = { version: conflict.current.version, content: conflict.current.content }
      blocked.current = false
      setConflict(null)
      latest.current = resolved
      setContent(resolved)
      writeDraft(resolved)
      await flushRef.current()
    },
    [conflict, writeDraft],
  )

  /** Apply a newer server version when there are no local changes. */
  const applyRemote = useCallback(
    (p: Page) => {
      if (latest.current !== base.current.content || inflight.current || blocked.current) return false
      base.current = { version: p.version, content: p.content }
      latest.current = p.content
      setContent(p.content)
      return true
    },
    [],
  )

  // Initial draft → save it.
  useEffect(() => {
    if (status === 'dirty') schedule(500)
    return () => {
      clearTimeout(timer.current)
      // Best effort on navigation; the local draft protects against loss anyway.
      if (latest.current !== base.current.content && !blocked.current && !inflight.current) void flushRef.current()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (latest.current !== base.current.content) e.preventDefault()
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [])

  return {
    content,
    onChange,
    status,
    error,
    savedAt,
    conflict,
    retry: () => {
      backoff.current = 2000
      void flush()
    },
    resolveConflict,
    applyRemote,
    baseVersion: () => base.current.version,
    mine: () => latest.current,
  }
}
