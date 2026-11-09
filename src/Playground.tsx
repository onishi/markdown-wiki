import { useRef, useState } from 'react'
import { DocEditor, type DocEditorHandle } from './editor/DocEditor'
import { Outline } from './editor/Outline'
import type { ListMode } from '../shared/markdown/units'
import type { SoftBreak } from '../shared/markdown/render'

export const SAMPLE = `# Markdown Wiki プレイグラウンド

これは **太字の文章** と [リンクのテキスト](https://example.com) を含む段落です。
同じ段落の二行目には *強調* と \`inline code\` と ~~取り消し~~ があります。

> 引用の一行目
> 引用の二行目で **太字** も使えます。

- 項目 A
  - 子項目 A-1
  - [ ] タスク
- 項目 B

## 表

| 名前 | 説明 |
|:-----|-----:|
| foo  | 左寄せ |
| bar  | 右寄せ |

## コード

### JavaScript

\`\`\`js
const a = 1 // [[リンクにならない]]
\`\`\`

## リンク

[[開発/API/認証]] と [[存在しないページ]] への wiki リンク。https://example.org も自動リンク。
`

export function Playground() {
  const [src, setSrc] = useState(SAMPLE)
  const [listMode, setListMode] = useState<ListMode>('list')
  const [softBreak, setSoftBreak] = useState<SoftBreak>('break')
  const handle = useRef<DocEditorHandle | null>(null)
  return (
    <div className="playground">
      <aside className="playground-outline">
        <div className="side-title">アウトライン</div>
        <Outline source={src} onJump={(it) => handle.current?.jumpTo(it.textStart)} />
      </aside>
      <div className="playground-main">
        <DocEditor
          source={src}
          onChange={setSrc}
          listMode={listMode}
          softBreak={softBreak}
          handleRef={handle}
          resolveWiki={(t) => ({ href: `#${t}`, exists: t !== '存在しないページ' })}
          absoluteWiki={(t) => ({ href: `${location.origin}/#${t}`, exists: true })}
          onOpenWiki={(t) => console.log('open wiki', t)}
        />
      </div>
      <aside className="playground-side">
        <label>
          リスト編集単位{' '}
          <select value={listMode} onChange={(e) => setListMode(e.target.value as ListMode)} data-testid="list-mode">
            <option value="list">リスト全体</option>
            <option value="item">一項目とその配下</option>
          </select>
        </label>
        <label>
          段落内の改行{' '}
          <select value={softBreak} onChange={(e) => setSoftBreak(e.target.value as SoftBreak)} data-testid="soft-break">
            <option value="break">改行として表示</option>
            <option value="join">GFM のまま空白を詰める</option>
          </select>
        </label>
        <pre data-testid="source">{src}</pre>
      </aside>
    </div>
  )
}
