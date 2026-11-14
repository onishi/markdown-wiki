import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { GROUPS } from './wiki/HelpDialog'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const M = isMac ? '⌘' : 'Ctrl'

const SYNTAX: [src: string, what: string][] = [
  ['# 見出し 1\n## 見出し 2', '見出し（目次に出ます）'],
  ['**太字** *斜体* ~~取り消し~~', '文字の装飾'],
  ['`コード`', 'インラインコード'],
  ['- 項目\n  - 子項目\n1. 番号付き', 'リスト（2 文字下げで入れ子）'],
  ['- [ ] やること\n- [x] 済み', 'タスク（表示中にクリックで切り替え）'],
  ['> 引用', '引用'],
  ['| 名前 | 説明 |\n|------|-----:|\n| foo  | 右寄せ |', '表（:で左右寄せ）'],
  ['```js\nconst a = 1\n```', 'コードブロック'],
  ['[[ページ名]]\n[[ページ名|表示名]]', 'wiki 内のページへのリンク'],
  ['[文字](https://example.com)', '外部リンク（URL だけでも自動リンク）'],
  ['![説明](画像の URL)', '画像'],
  ['---', '区切り線'],
]

/** A static user guide, readable without logging in: /help */
export function Help() {
  useEffect(() => {
    document.title = 'ヘルプ - Markdown Wiki'
    // Jump to #section when opened with a hash.
    const id = decodeURIComponent(location.hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView()
  }, [])
  return (
    <div className="help-page" data-testid="help-page">
      <header className="help-page-head">
        <Link to="/">Markdown Wiki</Link>
        <span className="muted">/ ヘルプ</span>
      </header>
      <h1>Markdown Wiki の使い方</h1>
      <p className="lead">読んでいる画面のまま書ける、チーム向けの Markdown wiki です。書いた内容は自動で保存され、すべての変更が履歴に残ります。</p>

      <nav className="help-toc" aria-label="目次">
        <a href="#start">はじめる</a>
        <a href="#pages">ページ</a>
        <a href="#write">書く</a>
        <a href="#syntax">記法</a>
        <a href="#links">リンク</a>
        <a href="#images">画像</a>
        <a href="#find">探す</a>
        <a href="#ai">AI</a>
        <a href="#history">履歴</a>
        <a href="#share">共有</a>
        <a href="#mobile">スマホ</a>
        <a href="#keys">キー操作</a>
      </nav>

      <section id="start">
        <h2>はじめる</h2>
        <ol>
          <li>Google アカウントでログインします。</li>
          <li>「新しい wiki」で名前と URL（<code>/w/識別子</code>）を決めて作成します。識別子はあとから変えられ、古い URL もそのまま使えます。</li>
          <li>「＋ 新しいページ」か <kbd>{M}+K</kbd> でページを作り、書き始めます。</li>
        </ol>
        <p>
          ログインせずに書き心地を試すなら <a href="/playground">プレイグラウンド</a> へ（保存はされません）。
        </p>
      </section>

      <section id="pages">
        <h2>ページ</h2>
        <ul>
          <li>
            ページ名の <code>/</code> は階層になります。<code>開発/API/認証</code> は「開発」→「API」の下に並びます。親ページがなくても子ページは作れます。
          </li>
          <li>ページ名は大文字・小文字や全角・半角を区別します（<code>Foo</code> と <code>foo</code> は別のページ）。</li>
          <li>
            ページ右上の「…」から、子ページの作成・名前の変更・削除ができます。名前を変えても古い名前へのリンクは新しいページに届きます。リンクの書き換えも選べます。
          </li>
          <li>共有設定で「トップページ」を選ぶと、wiki を開いたときにそのページが表示されます。全ページの一覧はサイドバーの「すべてのページ」から。</li>
        </ul>
      </section>

      <section id="write">
        <h2>書く</h2>
        <p>ページは「表示」と「編集」の 2 つの状態を行き来します。</p>
        <ul>
          <li>
            直したいところを<strong>ダブルクリック</strong>（またはカーソルを置いて <kbd>Enter</kbd>）すると、その段落・リスト・表などのブロックだけが Markdown の編集欄になります。
          </li>
          <li>
            <kbd>Esc</kbd> で表示に戻ります。変更はすぐに自動保存されます（ページ右上に「保存済み」と出ます）。
          </li>
          <li>表示中でも <kbd>{M}+Z</kbd> で直前の編集を取り消せます。</li>
          <li>
            範囲を選んで <kbd>Enter</kbd> を押すと、複数のブロックをまとめて編集できます。<kbd>{M}+A</kbd> → <kbd>Enter</kbd> でページ全体を編集。
          </li>
          <li>最後の行で <kbd>↓</kbd> を押すと本文の下の空き行に移り、<kbd>Enter</kbd> で新しい段落を書き足せます。</li>
          <li>
            同じページを同時に編集して食い違ったときは、自動でまとめられない部分だけ、両方の内容を見比べて直す画面が出ます。オフラインで書いた内容はブラウザに残り、次に開いたときに復元されます。
          </li>
          <li>リストをどこまでまとめて編集するか（リスト全体 / 一項目とその配下）や、段落内の改行の表示は、サイドバー下のユーザーメニューで変えられます。</li>
        </ul>
      </section>

      <section id="syntax">
        <h2>記法</h2>
        <p>GitHub と同じ Markdown（GFM）に、wiki リンクを足したものです。</p>
        <table className="help-syntax">
          <thead>
            <tr>
              <th>書き方</th>
              <th>意味</th>
            </tr>
          </thead>
          <tbody>
            {SYNTAX.map(([src, what]) => (
              <tr key={src}>
                <td>
                  <pre>{src}</pre>
                </td>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          編集中は <kbd>Enter</kbd> でリスト・引用・表の行が続きます。記号だけの行で <kbd>Enter</kbd> を押すと終わります。<kbd>Tab</kbd> / <kbd>Shift+Tab</kbd> でインデント。
        </p>
      </section>

      <section id="links">
        <h2>リンク</h2>
        <ul>
          <li>
            <code>[[ページ名]]</code> で wiki 内のページにリンクします。編集中に <code>[[</code> と打つとページ名の候補が出ます。まだないページへのリンクは色が変わり、開くと作成できます。
          </li>
          <li>
            リンクは<strong>クリックで開きます</strong>。<kbd>{M}+クリック</kbd>で新しいタブ、<kbd>{isMac ? '⌥' : 'Alt'}+クリック</kbd>でリンクの文字の中にカーソルを置けます。
          </li>
          <li>
            本文の左端の細い縦線をクリックするとそのブロックが選ばれ、URL が <code>#L12</code> のような「行へのリンク」になります。Shift+クリックで範囲を広げられます。
          </li>
        </ul>
      </section>

      <section id="images">
        <h2>画像</h2>
        <p>
          画像をコピーして貼り付けるか、ドラッグ＆ドロップするとアップロードされ、<code>![](…)</code> として挿入されます。PNG・JPEG・GIF・WebP・AVIF に対応し、1 枚 10 MB まで。画像は wiki のメンバーだけが見られます。
        </p>
      </section>

      <section id="find">
        <h2>探す</h2>
        <ul>
          <li>
            <kbd>{M}+K</kbd> で検索窓が開きます。ページ名に加えて<strong>本文の全文検索</strong>もでき、一致した箇所が表示されます。スペースで区切ると、すべての言葉を含むページに絞り込みます。
          </li>
          <li>ページの一番下の「このページへのリンク」に、そのページを <code>[[リンク]]</code> しているページ（バックリンク）が並びます。</li>
          <li>サイドバーの絞り込み欄はページ名で階層を絞り込みます。見出しはサイドバーの目次から飛べます。</li>
        </ul>
      </section>

      <section id="ai">
        <h2>AI に手伝ってもらう</h2>
        <p>オーナーが共有設定で有効にすると、編集者のページ右上に「AI」ボタンが出ます。</p>
        <ol>
          <li>直したい範囲を選んでから「AI」を押します（選ばなければページ全体が対象）。</li>
          <li>「誤字脱字だけ」「読みやすく」「表に整理」などやることを選び、必要なら追加の指示を書いて「提案を作成」。</li>
          <li>提案は差分で表示されます。採用しない変更はチェックを外し、「選んだ変更を採用」。</li>
        </ol>
        <p>
          採用した内容は通常の編集として保存され、<kbd>{M}+Z</kbd> や履歴から元に戻せます。AI は本文に書かれていない事実を足さないよう指示されていますが、内容は必ず確認してください。提案を作るときは、対象の文章とページの内容が Google の Gemini API に送られます。
        </p>
      </section>

      <section id="history">
        <h2>履歴</h2>
        <p>
          ページ右上の「履歴」で、いつ誰がどこを変えたかを差分で確認できます。同じ人が続けて行った編集は 1 つにまとまります。「この版に戻す」で過去の内容を復元でき、復元も新しい版として残るので、いつでもやり直せます。
        </p>
      </section>

      <section id="share">
        <h2>共有とメンバー</h2>
        <p>wiki は作成した時点では本人だけが見られます。サイドバー下の「共有設定・メンバー」からメールアドレスで招待します。</p>
        <table className="help-roles">
          <tbody>
            <tr>
              <th>閲覧者</th>
              <td>読む・検索する・履歴を見る</td>
            </tr>
            <tr>
              <th>編集者</th>
              <td>上に加えて、ページの作成・編集・名前変更・削除、画像のアップロード</td>
            </tr>
            <tr>
              <th>オーナー</th>
              <td>上に加えて、メンバーの招待と権限変更、wiki の名前・URL・トップページの設定、wiki の削除</td>
            </tr>
          </tbody>
        </table>
        <p className="muted small">招待された人は、そのメールアドレスの Google アカウントでログインすると wiki に参加します。</p>
      </section>

      <section id="mobile">
        <h2>スマホ</h2>
        <p>
          左上の ☰ でページ一覧、右上の ⌕ で検索が開きます。ブロックをタップすると「編集」ボタンが出て、編集を終えるときは「完了」を押します。
        </p>
      </section>

      <section id="keys">
        <h2>キー操作</h2>
        <p>ページを表示中に <kbd>?</kbd> を押すと、いつでもこの一覧を出せます。</p>
        <div className="help">
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
      </section>
    </div>
  )
}
