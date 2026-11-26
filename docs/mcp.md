# MCP サーバー

Markdown Wiki は wiki ごとに MCP（Model Context Protocol）サーバーを持ちます。Claude などの AI アプリから、wiki のページを読む・検索する・作る・書き換えることができます。

利用者向けの手順はヘルプ（`/help#mcp`）にあります。この文書は、できることの一覧と仕様のまとめです。実装は `server/mcp.ts`、テストは `tests/mcp.test.ts` と `e2e/wiki.spec.ts`（「MCP:」）にあります。

## 接続先

| 項目 | 値 |
| --- | --- |
| エンドポイント | `https://<ホスト>/mcp/<wiki の識別子>`（wiki の id や、変更前の識別子でも可） |
| トランスポート | Streamable HTTP（`POST` に JSON で応答するだけで、セッションも SSE もない） |
| プロトコル版 | `2025-06-18`、`2025-03-26`、`2024-11-05`（クライアントが求めた版を返し、知らない版なら最新を返す） |
| 認証 | OAuth 2.1（Bearer トークン。下記） |
| 対応メソッド | `initialize`、`ping`、`tools/list`、`tools/call`（`resources/list`、`prompts/list` は空を返す） |

`GET` / `DELETE` は 405 を返します。通知（`id` のないメッセージ）には 202 を返し、本文は付けません。JSON-RPC のバッチ（配列）も受け付けます。

`initialize` の応答には、wiki の名前と書き方の約束（`/` で階層を作る、`[[ページ名]]` でリンクする、編集の前に読む、など）を `instructions` として入れています。

## ツール一覧

| ツール | 種類 | 引数 | 内容 |
| --- | --- | --- | --- |
| `list_pages` | 読む | `prefix?` | ページ名、最終更新日時、更新した人の一覧（名前順）。`prefix`（例 `開発/`）で始まるものだけに絞れる |
| `read_page` | 読む | `name` | ページの Markdown 本文。先頭に名前、版番号、更新日時と更新した人、URL を付ける。変更前の名前でも見つかる |
| `read_image` | 読む | `url` | ページに書かれた画像 URL（`/api/wikis/<id>/files/<id>`、ホスト付きでも可）の画像を `image` コンテンツ（base64）で返す。この wiki の画像だけで、5 MB まで |
| `search` | 読む | `query` | ページ名と本文の全文検索。空白で区切った語をすべて含むページを、新しい順に最大 50 件、抜粋付きで返す |
| `recent_changes` | 読む | `limit?`（1〜100、既定 20） | 最近更新されたページの一覧 |
| `create_page` | 書く | `name`、`content` | ページを新しく作る。同じ名前のページがあるときはエラー |
| `edit_page` | 書く | `name`、`old_text`、`new_text`、`replace_all?` | 本文中の `old_text` を `new_text` に置き換える。`old_text` が見つからないときや、2 か所以上あるのに `replace_all` でないときはエラー。`old_text` が空なら、`new_text` を末尾に足す |
| `update_page` | 書く | `name`、`content`、`base_version` | 本文全体を置き換える。`base_version`（`read_page` で得た版）がいまの版と違えば保存せず、読み直すよう求めるエラーを返す（同じ内容なら成功） |

| `rename_page` | 書く | `name`、`new_name`、`include_children?`（既定 true）、`rewrite_links?`（既定 true） | 名前（階層）を変える。下の階層のページも一緒に移す。古い名前は別名として残り、`rewrite_links` ならほかのページの `[[リンク]]` も書き換える（履歴には「リンク更新」と残る）。同じ名前のページがある、または自分の下に移そうとするとエラー |
| `delete_page` | 書く | `name`、`base_version` | ページを履歴ごと削除する（元に戻せない）。下の階層のページは残す。`base_version` がいまの版と違えばエラー。説明文で、削除の前に利用者に確認するよう AI に求めている |

- 「書く」ツールは、書き込みが許された接続にだけ `tools/list` で見せます（下の「権限」を参照）。
- 各ツールには MCP のヒント（`readOnlyHint`、`destructiveHint` など）を付けています。
- エラーは JSON-RPC のエラーではなく、`isError: true` のツール結果として返します。AI が読んで直せるように、日本語で理由を書いています。
- 書き込みはページの版として保存され、履歴と「最近の更新」に「MCP」と表示されます。ブラウザから編集したときと同じく版が上がるので、開いている画面にも反映されます。

### MCP からできないこと

- ページの公開と非公開
- 画像のアップロード
- 履歴の閲覧と復元
- メンバーや wiki の設定の変更
- 複数の wiki をまたぐ操作（1 つの接続で使えるのは 1 つの wiki だけ）

## 権限

- 接続（グラント）は、クライアント、利用者、wiki の組ごとに 1 つ作ります。
- 許可の画面で「読み書き」（`wiki:read wiki:write`）か「読むだけ」（`wiki:read`）を選びます。閲覧者は読むだけしか選べません。
- リクエストのたびに、いまのメンバーシップを確かめます。
  - メンバーから外れると、すぐに 401 になります。
  - 閲覧者に変わると、書くツールが消えます。
- 利用者は「共有設定・メンバー」の「あなたが接続しているアプリ」で接続を一覧し、取り消せます。取り消すと、アクセストークンもリフレッシュトークンも無効になります。
- 別の wiki のエンドポイントにトークンを使うと 401 を返します。
- オーナーは「共有設定・メンバー」で wiki ごとに MCP を止められます（`wikis.mcp_enabled`、既定はオン）。
  - 止めている間は、MCP エンドポイントが 403（JSON-RPC エラー -32001）を返します。
  - 新しい接続の許可もできません。止めている wiki は、同意画面の wiki の選択肢にも出ません。
  - 接続（グラント）は消さないので、もう一度有効にすれば、そのまま使えるようになります。

## OAuth

MCP の認可仕様（OAuth 2.1、RFC 9728、RFC 8414、RFC 7591、PKCE）に沿っています。

| エンドポイント | 内容 |
| --- | --- |
| `GET /.well-known/oauth-protected-resource/mcp/<wiki>` | 保護リソースのメタデータ（`resource` と `authorization_servers`） |
| `GET /.well-known/oauth-authorization-server` | 認可サーバーのメタデータ（`/.well-known/openid-configuration` も同じ内容） |
| `POST /oauth/register` | 動的クライアント登録。公開クライアントだけ（`token_endpoint_auth_method: none`） |
| `GET /oauth/authorize` | クライアントとリダイレクト先を確かめてから、同意画面 `/connect` に渡す（未ログインならログインを挟む） |
| `POST /oauth/token` | `authorization_code`（PKCE S256 は必須）と `refresh_token` に対応 |

- トークンが無効なとき、MCP エンドポイントは 401 と `WWW-Authenticate: Bearer resource_metadata="…"` を返します。
- `resource` パラメータ（`https://<ホスト>/mcp/<wiki>`）があれば、その wiki に接続します。なければ、同意画面で利用者が自分の wiki から選びます。
- リダイレクト先として登録できるのは、https、http のループバック（ポートは問わない）、アプリのスキーム（`cursor://` など）です。`javascript:`、`data:`、`file:` は登録できません。
- 有効期限:

  | 種類 | 期限 |
  | --- | --- |
  | 認可コード | 10 分（1 回だけ使える） |
  | アクセストークン | 1 時間 |
  | リフレッシュトークン | 60 日（使うたびにアクセストークンと一緒に新しくなり、古いものは無効になる） |

- トークンとコードは、SHA-256 のハッシュだけを保存します。
- 一度も接続まで進まなかったクライアント登録は、1 日で消します。
- `/mcp/*`、`/oauth/token`、`/oauth/register`、`/.well-known/*` は Cookie を使わないので、CSRF のヘッダ検査から外し、CORS を許可しています。

## 接続例

```sh
# Claude Code
claude mcp add --transport http team https://markdown-wiki.wagaya.workers.dev/mcp/team
# Claude Code の中で /mcp を開いて認証する
```

claude.ai では、設定 → コネクタ →「カスタムコネクタを追加」に URL を入れます。
