import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { copyText } from "../editor/copyButtons";
import { fullTime, relTime } from "../time";
import { useWiki } from "./WikiLayout";

interface Grant {
  id: string;
  clientName: string;
  access: "read" | "write";
  createdAt: number;
  lastUsedAt: number | null;
}

/** Settings section: the wiki's MCP URL and the apps you have connected to it. */
export function McpSettings({
  wikiId,
  slug,
}: {
  wikiId: string;
  slug: string;
}) {
  const { wiki, role, reloadWiki } = useWiki();
  const enabled = wiki.mcpEnabled !== false;
  const [busy, setBusy] = useState(false);
  const url = `${location.origin}/mcp/${slug}`;
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const load = useCallback(() => {
    api<{ grants: Grant[] }>("GET", `/api/wikis/${wikiId}/mcp/grants`)
      .then((r) => setGrants(r.grants))
      .catch(() => setGrants([]));
  }, [wikiId]);
  useEffect(load, [load]);

  const revoke = async (g: Grant) => {
    if (!confirm(`「${g.clientName}」の接続を取り消しますか？`)) return;
    await api("DELETE", `/api/wikis/${wikiId}/mcp/grants/${g.id}`).catch(
      () => {},
    );
    load();
  };

  return (
    <section data-testid="mcp-settings">
      <h3>AI アプリから使う（MCP）</h3>
      {role === "owner" && (
        <label className="check-row">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            data-testid="mcp-enabled"
            onChange={async (e) => {
              const on = e.target.checked;
              if (
                !on &&
                !confirm(
                  "AI アプリからの接続を止めますか？ 接続中のアプリもすべて使えなくなります（もう一度有効にすると、そのまま使えるようになります）。",
                )
              )
                return;
              setBusy(true);
              await api("PATCH", `/api/wikis/${wikiId}`, {
                mcpEnabled: on,
              }).catch(() => {});
              await reloadWiki();
              setBusy(false);
            }}
          />
          メンバーが AI アプリ（MCP）からこの wiki を使えるようにする
        </label>
      )}
      {!enabled ? (
        <p className="muted small" data-testid="mcp-disabled">
          {role === "owner"
            ? "止めています。"
            : "この wiki では、オーナーが AI アプリからの接続を止めています。"}
        </p>
      ) : (
        <>
          <p className="muted small">
            Claude などの AI アプリにこの URL を MCP
            サーバー（コネクタ）として追加すると、AI がこの wiki
            のページを読んだり、検索したり、書き換えたりできます。追加すると
            Google ログインと許可の画面が開き、あなたの権限の範囲で使えます。
          </p>
          <div className="mcp-url">
            <code data-testid="mcp-url">{url}</code>
            <button
              className="btn btn-small"
              onClick={(e) => copyText(url, e.currentTarget)}
            >
              コピー
            </button>
          </div>
          <ul className="muted small mcp-howto">
            <li>
              claude.ai: 設定 → コネクタ → 「カスタムコネクタを追加」に URL
              を入れる
            </li>
            <li>
              Claude Code:{" "}
              <code>
                claude mcp add --transport http {slug} {url}
              </code>
              （追加後に <code>/mcp</code> で認証）
            </li>
          </ul>
          <h4 className="mcp-sub">あなたが接続しているアプリ</h4>
          {!grants ? (
            <p className="muted small">読み込み中…</p>
          ) : grants.length === 0 ? (
            <p className="muted small">まだありません。</p>
          ) : (
            <ul className="list list-compact" data-testid="mcp-grants">
              {grants.map((g) => (
                <li key={g.id} className="list-row">
                  <span className="list-name">
                    {g.clientName}
                    <span className="tag">
                      {g.access === "write" ? "読み書き" : "読むだけ"}
                    </span>
                  </span>
                  <span
                    className="list-meta"
                    title={fullTime(g.lastUsedAt ?? g.createdAt)}
                  >
                    {g.lastUsedAt
                      ? `${relTime(g.lastUsedAt)}に使用`
                      : `${relTime(g.createdAt)}に許可`}
                  </span>
                  <button
                    className="link-btn"
                    onClick={() => revoke(g)}
                    data-testid="mcp-revoke"
                  >
                    取り消す
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
