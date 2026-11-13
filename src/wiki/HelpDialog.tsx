import { Modal } from './Modal'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const M = isMac ? '⌘' : 'Ctrl'
const A = isMac ? '⌥' : 'Alt'

export const GROUPS: { title: string; rows: [keys: string[], what: string][] }[] = [
  {
    title: '表示中',
    rows: [
      [['Enter', 'i', 'ダブルクリック'], 'カーソル位置のブロックを編集'],
      [['a'], '次の文字の後ろから編集'],
      [['o', 'O'], '下 / 上に新しい行を開いて編集'],
      [['最後の行で ↓'], '文末の下の空き行へ（Enter で新しい段落）'],
      [['←↓↑→', 'h j k l'], 'カーソル移動（Shift で選択）'],
      ...(isMac ? ([[['Ctrl+A / E / F / B / N / P'], 'Emacs 風の移動']] as [string[], string][]) : []),
      [[`${M}+Z`, 'u'], '直前の編集を取り消す'],
      [[`${M}+Shift+Z`], 'やり直す'],
      [[`${M}+A`], 'すべて選択'],
      [['選択 → Enter'], '選んだ範囲をまとめて編集'],
      [['右クリック'], 'コピー形式の選択（プレーン / Markdown / リッチ）'],
      [['左端の縦線'], 'ブロックを選択して行へのリンクを取得'],
    ],
  },
  {
    title: '編集中',
    rows: [
      [['Esc', '完了'], '表示に戻る（変更は自動保存）'],
      [['[['], 'ページ名を補完（↑↓ で選んで Enter）'],
      [['Enter'], '引用・リスト・表の行を続ける（記号だけの行で Enter すると終わる）'],
      [['Shift+Enter'], 'ただの改行'],
      [['Tab', 'Shift+Tab'], 'インデント / 戻す'],
      [['画像を貼り付け'], 'アップロードして挿入'],
    ],
  },
  {
    title: 'リンクとページ',
    rows: [
      [['クリック'], 'リンクを開く'],
      [[`${M}+クリック`], '新しいタブで開く'],
      [[`${A}+クリック`], 'リンクの文字の中にカーソルを置く'],
      [[`${M}+K`], 'ページを開く・本文を検索・作成'],
      [['?'], 'この一覧'],
    ],
  },
]

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="操作一覧" onClose={onClose} wide>
      <div className="help" data-testid="help">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3>{g.title}</h3>
            <dl>
              {g.rows.map(([keys, what]) => (
                <div key={what} className="help-row">
                  <dt>
                    {keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <div className="modal-actions">
        <a className="btn" href="/help" target="_blank" rel="noopener">
          詳しい使い方
        </a>
        <button className="btn" onClick={onClose}>
          閉じる
        </button>
      </div>
    </Modal>
  )
}
