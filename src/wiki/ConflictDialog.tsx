import { useMemo, useState } from 'react'
import { threeWayMerge } from '../../shared/merge'
import type { Conflict } from './usePageSaver'
import { Modal } from './Modal'

/**
 * Shown when the server rejects a save because someone else saved first.
 * Nothing is lost: "your version" stays available (and in the local draft) until the
 * user picks or edits a resolution, which is then saved on top of the latest version.
 */
export function ConflictDialog({ conflict, mine, onResolve, onClose }: { conflict: Conflict; mine: string; onResolve: (text: string) => void; onClose: () => void }) {
  const theirs = conflict.current.content
  const merged = useMemo(() => (conflict.base !== null ? threeWayMerge(conflict.base, mine, theirs) : { text: mine, conflict: true }), [conflict.base, mine, theirs])
  const [text, setText] = useState(merged.text)
  const who = conflict.current.updatedByName ?? '他のメンバー'
  return (
    <Modal title="編集が競合しました" onClose={onClose} wide>
      <p>
        {who} さんがこのページを先に更新しました（版 {conflict.current.version}）。あなたの変更はまだ保存されておらず、このブラウザに保持されています。
      </p>
      <p className="muted small">
        {conflict.base === null
          ? '共通の元の版が見つからないため、自動マージできませんでした。'
          : merged.conflict
            ? '同じ箇所が両方で変更されています。下の「解決後の内容」の <<<<<<< 〜 >>>>>>> を編集してください。'
            : '変更箇所が重ならないため、自動でマージできました。内容を確認して保存してください。'}
      </p>
      <div className="conflict-grid">
        <label>
          あなたの版
          <textarea readOnly value={mine} data-testid="conflict-mine" />
        </label>
        <label>
          最新の版（{who}）
          <textarea readOnly value={theirs} data-testid="conflict-theirs" />
        </label>
      </div>
      <label className="conflict-result">
        解決後の内容
        <textarea value={text} onChange={(e) => setText(e.target.value)} data-testid="conflict-result" />
      </label>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          あとで
        </button>
        <button className="btn" onClick={() => setText(theirs)}>
          最新の版を採用
        </button>
        <button className="btn" onClick={() => setText(mine)}>
          自分の版を採用
        </button>
        <button className="btn btn-primary" onClick={() => onResolve(text)} data-testid="conflict-save" disabled={/^(<<<<<<<|>>>>>>>)/m.test(text)}>
          この内容で保存
        </button>
      </div>
    </Modal>
  )
}
