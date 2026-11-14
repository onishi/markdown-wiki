import { useRef, useState } from 'react'
import { api, ApiError } from '../api'
import { applyHunks, charDiff, diffHunks, type Hunk, type Segment } from '../../shared/diff'
import { Modal } from './Modal'
import { isImeKey } from '../editor/SourceEditor'

const PRESETS: { key: string; label: string }[] = [
  { key: 'auto', label: 'お任せで改善' },
  { key: 'typo', label: '誤字脱字だけ' },
  { key: 'clarify', label: '読みやすく' },
  { key: 'trim', label: '簡潔に' },
  { key: 'expand', label: '項目を増やす' },
  { key: 'tbd', label: '(TBD) を埋める' },
  { key: 'table', label: '表に整理' },
  { key: 'summary', label: '冒頭に要約' },
]

const VOLUMES: { key: string; label: string }[] = [
  { key: 'auto', label: 'おまかせ' },
  { key: 'short', label: '短く' },
  { key: 'same', label: '同じくらい' },
  { key: 'long', label: '長く' },
]

const ERRORS: Record<string, string> = {
  ai_disabled: 'この wiki では AI が有効になっていません（共有設定でオーナーが有効にできます）。',
  ai_unavailable: 'サーバーに AI の API キーが設定されていません。',
  rate_limited: '今日の AI の利用回数の上限に達しました。明日またお試しください。',
  too_large: '対象が長すぎます。範囲を選んで、一部ずつ試してください。',
  ai_failed: 'AI の応答を取得できませんでした。もう一度お試しください。',
}

type Phase =
  | { kind: 'ask' }
  | { kind: 'loading' }
  | { kind: 'review'; segments: Segment[]; summary: string; remaining: number }
  | { kind: 'error'; message: string }

/**
 * Ask Gemini for a revision of the selection (or the whole page), then review it as a
 * diff and adopt changes one by one.  Adopting is an ordinary, undoable edit.
 */
export function AiDialog({
  wikiId,
  pageId,
  content,
  selection,
  onApply,
  onClose,
}: {
  wikiId: string
  pageId: string
  /** The text at the time the dialog opened. */
  content: string
  /** Selected range widened to whole blocks or lines (null: no selection); `editing`: taken from the source editor. */
  selection: { start: number; end: number; editing?: boolean } | null
  onApply: (next: string) => void
  onClose: () => void
}) {
  const [scope, setScope] = useState<'selection' | 'page'>(selection ? 'selection' : 'page')
  const [preset, setPreset] = useState('auto')
  const [volume, setVolume] = useState('auto')
  const [instruction, setInstruction] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'ask' })
  const [accepted, setAccepted] = useState<Set<number>>(new Set())
  const compEnd = useRef(-1e9)
  const reqId = useRef(0)

  const range = scope === 'selection' && selection ? selection : { start: 0, end: content.length }
  const target = content.slice(range.start, range.end)

  const run = async () => {
    const id = ++reqId.current
    setPhase({ kind: 'loading' })
    try {
      const r = await api<{ revised: string; summary: string; remaining: number }>('POST', `/api/wikis/${wikiId}/pages/${pageId}/ai/revise`, {
        content,
        start: range.start,
        end: range.end,
        preset,
        volume,
        instruction,
      })
      if (id !== reqId.current) return
      const segments = diffHunks(target, r.revised)
      setAccepted(new Set(segments.flatMap((s) => ('id' in s ? [s.id] : []))))
      setPhase({ kind: 'review', segments, summary: r.summary, remaining: r.remaining })
    } catch (e) {
      if (id !== reqId.current) return
      const err = e as ApiError
      setPhase({ kind: 'error', message: ERRORS[err.body?.error] ?? (err.status === 0 ? 'ネットワークに接続できません。' : 'AI の提案を取得できませんでした。') })
    }
  }

  const hunks = phase.kind === 'review' ? (phase.segments.filter((s) => 'id' in s) as Hunk[]) : []
  const apply = () => {
    if (phase.kind !== 'review') return
    const next = content.slice(0, range.start) + applyHunks(phase.segments, accepted) + content.slice(range.end)
    onApply(next)
  }
  const toggle = (id: number) =>
    setAccepted((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <Modal title="AI に手伝ってもらう" onClose={() => ((reqId.current = -1), onClose())} wide>
      <div className="ai-dialog" data-testid="ai-dialog">
        {(phase.kind === 'ask' || phase.kind === 'error' || phase.kind === 'loading') && (
          <>
            <div className="ai-scope" role="radiogroup" aria-label="対象">
              <label>
                <input type="radio" checked={scope === 'selection'} disabled={!selection} onChange={() => setScope('selection')} />
                {selection?.editing ? '編集中の部分' : '選択した部分'}
                {selection && <span className="muted small">（{content.slice(selection.start, selection.end).split('\n').length} 行）</span>}
              </label>
              <label>
                <input type="radio" checked={scope === 'page'} onChange={() => setScope('page')} />
                ページ全体
              </label>
              {!selection && <span className="muted small">範囲を選んでから開くと、その部分だけを対象にできます</span>}
            </div>
            <div className="ai-presets" role="radiogroup" aria-label="やること">
              {PRESETS.map((p) => (
                <button key={p.key} type="button" role="radio" aria-checked={preset === p.key} className={'chip' + (preset === p.key ? ' on' : '')} onClick={() => setPreset(p.key)}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="ai-volume" role="radiogroup" aria-label="分量">
              <span className="muted small">分量</span>
              {VOLUMES.map((v) => (
                <button key={v.key} type="button" role="radio" aria-checked={volume === v.key} className={'chip' + (volume === v.key ? ' on' : '')} onClick={() => setVolume(v.key)}>
                  {v.label}
                </button>
              ))}
            </div>
            <textarea
              className="input-block ai-instruction"
              rows={2}
              placeholder="追加の指示（任意）例: 箇条書きにして、敬体にそろえて"
              value={instruction}
              data-testid="ai-instruction"
              onChange={(e) => setInstruction(e.target.value)}
              onCompositionEnd={() => (compEnd.current = performance.now())}
              onKeyDown={(e) => {
                if (isImeKey(e, compEnd.current)) return
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  if (phase.kind !== 'loading') void run()
                }
              }}
            />
            {phase.kind === 'error' && <div className="notice">{phase.message}</div>}
            <p className="muted small">
              選んだ部分（とページ全体の文脈）が Google の Gemini に送られます。提案は保存されず、採用した変更だけが通常の編集として保存されます。
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={onClose}>
                閉じる
              </button>
              <button className="btn btn-primary" onClick={run} disabled={phase.kind === 'loading'} data-testid="ai-run">
                {phase.kind === 'loading' ? '考えています…' : '提案を作成'}
              </button>
            </div>
          </>
        )}

        {phase.kind === 'review' && (
          <>
            {phase.summary && <p className="ai-summary" data-testid="ai-summary">{phase.summary}</p>}
            {hunks.length === 0 ? (
              <p className="muted">変更の提案はありませんでした。</p>
            ) : (
              <>
                <div className="ai-bulk muted small">
                  {hunks.length} か所の変更 · {accepted.size} か所を採用
                  <button className="link-btn" onClick={() => setAccepted(new Set(hunks.map((h) => h.id)))}>
                    すべて選ぶ
                  </button>
                  <button className="link-btn" onClick={() => setAccepted(new Set())}>
                    すべて外す
                  </button>
                </div>
                <ReviewDiff segments={phase.segments} accepted={accepted} onToggle={toggle} />
              </>
            )}
            <div className="modal-actions">
              <span className="muted small ai-remaining">今日の残り {phase.remaining} 回</span>
              <button className="btn" onClick={() => setPhase({ kind: 'ask' })} data-testid="ai-back">
                指示を変える
              </button>
              <button className="btn" onClick={onClose}>
                採用しない
              </button>
              <button className="btn btn-primary" onClick={apply} disabled={accepted.size === 0} data-testid="ai-apply">
                選んだ変更を採用
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/** Unchanged lines (collapsed) and each hunk with a checkbox; changed characters highlighted. */
function ReviewDiff({ segments, accepted, onToggle }: { segments: Segment[]; accepted: Set<number>; onToggle: (id: number) => void }) {
  const rows = segments
  return (
    <div className="ai-diff" data-testid="ai-diff">
      {rows.map((s, i) => {
        if ('same' in s) {
          const first = i === 0
          const last = i === rows.length - 1
          const ctx = 2
          if (s.same.length <= ctx * 2 + 1 || (first && s.same.length <= ctx) || (last && s.same.length <= ctx))
            return <Same key={i} lines={s.same} />
          return (
            <div key={i}>
              {!first && <Same lines={s.same.slice(0, ctx)} />}
              <div className="ai-skip muted small">…</div>
              {!last && <Same lines={s.same.slice(-ctx)} />}
            </div>
          )
        }
        const on = accepted.has(s.id)
        const pair = s.del.length === s.add.length
        return (
          <label key={i} className={'ai-hunk' + (on ? ' on' : '')} data-testid="ai-hunk">
            <input type="checkbox" checked={on} onChange={() => onToggle(s.id)} aria-label="この変更を採用" />
            <div className="ai-hunk-body">
              {s.del.map((t, j) => (
                <div key={'d' + j} className="ai-line del">
                  {pair ? <Marked parts={charDiff(t, s.add[j]).del} /> : t || ' '}
                </div>
              ))}
              {s.add.map((t, j) => (
                <div key={'a' + j} className="ai-line add">
                  {pair ? <Marked parts={charDiff(s.del[j], t).add} /> : t || ' '}
                </div>
              ))}
            </div>
          </label>
        )
      })}
    </div>
  )
}

function Same({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((t, i) => (
        <div key={i} className="ai-line same">
          {t || ' '}
        </div>
      ))}
    </>
  )
}

function Marked({ parts }: { parts: { text: string; changed: boolean }[] }) {
  if (parts.length === 0) return <> </>
  return <>{parts.map((p, i) => (p.changed ? <mark key={i}>{p.text}</mark> : p.text))}</>
}
