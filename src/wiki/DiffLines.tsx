import type { lineDiff } from '../../shared/diff'

/** The lines of a `lineDiff` result (unchanged runs collapsed). */
export function DiffLines({ diff }: { diff: ReturnType<typeof lineDiff> }) {
  if (diff.added + diff.removed === 0) return <p className="muted">変更はありません。</p>
  return (
    <>
      {diff.lines.map((l, i) =>
        l.kind === 'skip' ? (
          <div key={i} className="diff-skip">
            ⋯ {l.count} 行
          </div>
        ) : (
          <div key={i} className={`diff-line diff-${l.kind}`}>
            <span className="diff-mark">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
            {l.text || ' '}
          </div>
        ),
      )}
    </>
  )
}
