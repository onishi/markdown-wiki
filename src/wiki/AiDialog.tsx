import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import {
  applyHunks,
  charDiff,
  diffHunks,
  type Hunk,
  type Segment,
} from "../../shared/diff";
import { Modal } from "./Modal";
import { isImeKey } from "../editor/SourceEditor";
import { applyLinks, type SuggestedLink } from "../../shared/markdown/wikilinks";

const PRESET_GROUPS: {
  name: string;
  items: { key: string; label: string; hint: string }[];
}[] = [
  {
    name: "直す",
    items: [
      {
        key: "auto",
        label: "お任せで改善",
        hint: "誤字脱字、わかりにくい表現、見出しや箇条書きの構成をまとめて直します。",
      },
      {
        key: "typo",
        label: "誤字脱字だけ",
        hint: "誤字脱字・表記ゆれ・文法の誤りだけを直します。表現や構成は変えません。",
      },
      {
        key: "factcheck",
        label: "誤情報の訂正",
        hint: "事実・数値・日付・名前などの誤りや古い情報を Google 検索で確かめて正します。",
      },
      {
        key: "clarify",
        label: "読みやすく",
        hint: "長い文を分け、順序や見出し・箇条書きを整理します。情報は減らしません。",
      },
      {
        key: "trim",
        label: "簡潔に",
        hint: "重複や冗長な言い回しを削ります。",
      },
    ],
  },
  {
    name: "足す・まとめる",
    items: [
      {
        key: "expand",
        label: "項目を増やす",
        hint: "足りない観点を見出しや項目として足します。",
      },
      {
        key: "tbd",
        label: "(TBD) を埋める",
        hint: "「(TBD)」「TODO」など書きかけの箇所を埋めます。",
      },
      {
        key: "summary",
        label: "冒頭に要約",
        hint: "冒頭に 2〜4 行の要約を足します。",
      },
      {
        key: "table",
        label: "表に整理",
        hint: "列挙されている情報を表にまとめます。",
      },
      {
        key: "links",
        label: "リンクを張る",
        hint: "本文に出てくる、wiki にあるページの名前を [[リンク]] にします。",
      },
      {
        key: "keywords",
        label: "特徴語をリンクに",
        hint: "本文の特徴語（固有名詞・専門用語など）を [[リンク]] にします。まだないページへのリンクも作ります。1 語ずつ選べます。",
      },
    ],
  },
];
const PRESETS = PRESET_GROUPS.flatMap((g) => g.items);
/** Tasks that always look things up (the server forces web mode too). */
const NEEDS_WEB = new Set(["factcheck"]);
/** Tasks about the wiki itself, where searching the web is pointless (the server turns it off). */
const NO_WEB = new Set(["links", "keywords"]);
/** Tasks where a target length means nothing. */
const NO_VOLUME = new Set(["typo", "factcheck", "links", "keywords"]);

const VOLUMES: { key: string; label: string }[] = [
  { key: "auto", label: "おまかせ" },
  { key: "short", label: "短く" },
  { key: "same", label: "同じくらい" },
  { key: "long", label: "長く" },
];

const ERRORS: Record<string, string> = {
  ai_disabled:
    "この wiki では AI が有効になっていません（共有設定でオーナーが有効にできます）。",
  ai_unavailable: "サーバーに AI の API キーが設定されていません。",
  rate_limited:
    "今日の AI の利用回数の上限に達しました。明日またお試しください。",
  too_large: "対象が長すぎます。範囲を選んで、一部ずつ試してください。",
  invalid_range:
    "対象の範囲が正しくありません。ページを開き直してお試しください。",
  ai_failed: "AI の応答を取得できませんでした。もう一度お試しください。",
};

interface AiAnswer {
  revised: string;
  summary: string;
  sources?: { uri: string; title?: string }[];
  /** Wiki pages sent as background. */
  related?: string[];
  /** Uses left today (null: this answer did not use one). */
  remaining: number | null;
  /** Linking tasks: each link to add, adopted one by one instead of by diff. */
  links?: LinkSuggestion[];
}
type LinkSuggestion = SuggestedLink & { exists: boolean };

/** What can be shown of a partial tagged answer (`<summary>…</summary><revised>…`). */
export function partialAnswer(text: string): { summary: string; revised: string } {
  const s = /<summary>([\s\S]*?)(<\/summary>|$)/.exec(text);
  const a = text.indexOf("<revised>");
  let revised = a < 0 ? "" : text.slice(a + "<revised>".length).replace(/^\n/, "");
  const b = revised.indexOf("</revised>");
  if (b >= 0) revised = revised.slice(0, b);
  // Hide a closing tag that is still arriving ("</rev").
  revised = revised.replace(/<\/?[a-z]*$/, "");
  return { summary: s ? s[1].trim() : "", revised };
}

/** POST with `stream: true` and read the NDJSON lines; resolves with the final answer. */
async function streamRevise(url: string, body: object, onText: (t: string) => void, signal: AbortSignal): Promise<AiAnswer> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-requested-with": "markdown-wiki" },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new ApiError(0, { error: "network" });
  }
  if (!res.ok || !res.body) throw new ApiError(res.status, await res.json().catch(() => null));
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += value;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new ApiError(502, { error: msg.error });
      if (msg.done) return msg.done as AiAnswer;
      if (typeof msg.text === "string") onText(msg.text);
    }
    if (done) throw new ApiError(502, { error: "ai_failed" });
  }
}

type Phase =
  | { kind: "ask" }
  /** `text`: the model's answer so far (streamed), `started`: when the request was sent. */
  | { kind: "loading"; text: string; started: number }
  | { kind: "review"; segments: Segment[]; links?: LinkSuggestion[]; summary: string; related: string[]; remaining: number | null }
  | { kind: "error"; message: string };

/** While the model writes: elapsed time and the revised text so far. */
function AiProgress({ text, started, web }: { text: string; started: number; web: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const box = useRef<HTMLPreElement>(null);
  const { summary, revised } = partialAnswer(text);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [revised]);
  const sec = Math.floor((now - started) / 1000);
  return (
    <div className="ai-progress" data-testid="ai-progress" aria-live="polite">
      <div className="ai-progress-head">
        <span className="ai-spinner" aria-hidden />
        <span>{revised ? "書いています…" : web ? "調べています…" : "考えています…"}</span>
        <span className="muted small">{sec} 秒</span>
      </div>
      {summary && <p className="ai-progress-summary small">{summary}</p>}
      {revised && (
        <pre className="ai-progress-text" ref={box} data-testid="ai-progress-text">
          {revised}
        </pre>
      )}
    </div>
  );
}

/**
 * Ask Gemini for a revision of the selection (or the whole page), then review it as a
 * diff and adopt changes one by one.  Adopting is an ordinary, undoable edit.
 */
export function AiDialog({
  wikiId,
  pageId,
  pageName,
  content,
  selection,
  onApply,
  onClose,
  autoStart,
}: {
  wikiId: string;
  pageId: string;
  pageName: string;
  /** The text at the time the dialog opened. */
  content: string;
  /** Selected range widened to whole blocks or lines (null: no selection); `editing`: taken from the source editor. */
  selection: { start: number; end: number; editing?: boolean } | null;
  onApply: (next: string) => void;
  onClose: () => void;
  /** Start right away with the defaults (お任せ), without the form first. */
  autoStart?: boolean;
}) {
  const [scope, setScope] = useState<"selection" | "page">(
    selection ? "selection" : "page",
  );
  const [preset, setPreset] = useState("auto");
  const [volume, setVolume] = useState("auto");
  const [instruction, setInstruction] = useState("");
  const [web, setWeb] = useState(() => {
    try {
      return localStorage.getItem("mw:aiWeb") !== "0";
    } catch {
      return true;
    }
  });
  const toggleWeb = (on: boolean) => {
    setWeb(on);
    try {
      localStorage.setItem("mw:aiWeb", on ? "1" : "0");
    } catch {}
  };
  const [wikiCtx, setWikiCtx] = useState(() => {
    try {
      return localStorage.getItem("mw:aiWiki") !== "0";
    } catch {
      return true;
    }
  });
  const toggleWikiCtx = (on: boolean) => {
    setWikiCtx(on);
    try {
      localStorage.setItem("mw:aiWiki", on ? "1" : "0");
    } catch {}
  };
  const [phase, setPhase] = useState<Phase>({ kind: "ask" });
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const compEnd = useRef(-1e9);
  const reqId = useRef(0);

  const useWeb = !NO_WEB.has(preset) && (web || NEEDS_WEB.has(preset));
  const blankPage = content.trim() === "";
  const volumeOff = NO_VOLUME.has(preset);
  const range =
    scope === "selection" && selection
      ? selection
      : { start: 0, end: content.length };
  const target = content.slice(range.start, range.end);

  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const stop = () => {
    reqId.current++;
    abort.current?.abort();
    setPhase({ kind: "ask" });
  };

  const run = async () => {
    const id = ++reqId.current;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setPhase({ kind: "loading", text: "", started: Date.now() });
    try {
      const r = await streamRevise(
        `/api/wikis/${wikiId}/pages/${pageId}/ai/revise`,
        {
          content,
          start: range.start,
          end: range.end,
          preset,
          volume: volumeOff ? "auto" : volume,
          instruction,
          web: useWeb,
          wiki: wikiCtx,
        },
        (text) => {
          if (id === reqId.current) setPhase((p) => (p.kind === "loading" ? { ...p, text } : p));
        },
        ctl.signal,
      );
      if (id !== reqId.current) return;
      const segments = reviewSegments(target, r.revised, r.sources ?? []);
      setAccepted(
        new Set(
          r.links
            ? r.links.map((_, i) => i)
            : segments.flatMap((s) => ("id" in s ? [s.id] : [])),
        ),
      );
      setPhase({
        kind: "review",
        segments,
        links: r.links,
        summary: r.summary,
        related: r.related ?? [],
        remaining: r.remaining,
      });
    } catch (e) {
      if (id !== reqId.current) return;
      const err = e as ApiError;
      setPhase({
        kind: "error",
        message:
          ERRORS[err.body?.error] ??
          (err.status === 0
            ? "ネットワークに接続できません。"
            : "AI の提案を取得できませんでした。"),
      });
    }
  };

  // (Re-run after a remount: unmounting aborts the request in flight.)
  useEffect(() => {
    if (autoStart) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  const links = phase.kind === "review" ? phase.links : undefined;
  /** What can be adopted: diff hunks, or for linking tasks each link (by index). */
  const choices: number[] =
    phase.kind !== "review"
      ? []
      : links
        ? links.map((_, i) => i)
        : (phase.segments.filter((s) => "id" in s) as Hunk[]).map((h) => h.id);
  const apply = () => {
    if (phase.kind !== "review") return;
    const next =
      content.slice(0, range.start) +
      (links
        ? applyLinks(target, links.filter((_, i) => accepted.has(i)))
        : applyHunks(phase.segments, accepted)) +
      content.slice(range.end);
    onApply(next);
  };
  const toggle = (id: number) =>
    setAccepted((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Modal
      title="AI に手伝ってもらう"
      onClose={() => ((reqId.current = -1), abort.current?.abort(), onClose())}
      wide
    >
      <div className="ai-dialog" data-testid="ai-dialog">
        {(phase.kind === "ask" ||
          phase.kind === "error" ||
          phase.kind === "loading") && (
          <>
            <div className="ai-form">
              <div className="ai-label">対象</div>
              {blankPage ? (
                <div className="ai-target-note" data-testid="ai-blank">
                  空のページ — タイトル「{pageName}」から本文を書き起こします。
                </div>
              ) : (
                <div>
                  <div className="seg" role="radiogroup" aria-label="対象">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={scope === "selection"}
                      className={scope === "selection" ? "on" : ""}
                      disabled={!selection}
                      onClick={() => setScope("selection")}
                    >
                      {selection?.editing ? "編集中の部分" : "選択した部分"}
                      {selection && (
                        <span className="seg-sub">
                          {
                            content
                              .slice(selection.start, selection.end)
                              .split("\n").length
                          }{" "}
                          行
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={scope === "page"}
                      className={scope === "page" ? "on" : ""}
                      onClick={() => setScope("page")}
                    >
                      ページ全体
                    </button>
                  </div>
                  {!selection && (
                    <div className="ai-hint">
                      範囲を選んでから開くと、その部分だけを対象にできます。
                    </div>
                  )}
                </div>
              )}

              <div className="ai-label">やること</div>
              <div>
                {PRESET_GROUPS.map((g) => (
                  <div
                    key={g.name}
                    className="ai-group"
                    role="radiogroup"
                    aria-label={g.name}
                  >
                    <span className="ai-group-name">{g.name}</span>
                    {g.items.map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        role="radio"
                        aria-checked={preset === p.key}
                        className={"chip" + (preset === p.key ? " on" : "")}
                        onClick={() => setPreset(p.key)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                ))}
                <div className="ai-hint" data-testid="ai-preset-hint">
                  {PRESETS.find((p) => p.key === preset)?.hint}
                </div>
              </div>

              <div className="ai-label">分量</div>
              <div>
                <div
                  className={"seg" + (volumeOff ? " off" : "")}
                  role="radiogroup"
                  aria-label="分量"
                >
                  {VOLUMES.map((v) => (
                    <button
                      key={v.key}
                      type="button"
                      role="radio"
                      aria-checked={!volumeOff && volume === v.key}
                      className={!volumeOff && volume === v.key ? "on" : ""}
                      disabled={volumeOff}
                      onClick={() => setVolume(v.key)}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
                {volumeOff && (
                  <div className="ai-hint">
                    この作業では分量は変わりません。
                  </div>
                )}
              </div>

              <div className="ai-label">調べる</div>
              <div>
                <label className="check-row">
                  <input type="checkbox" checked={wikiCtx} onChange={(e) => toggleWikiCtx(e.target.checked)} data-testid="ai-wiki" />
                  wiki 全体（関連ページとページ一覧）
                </label>
                <div className="ai-hint">リンク先・リンク元・親ページ、このページの話題に触れているページ、トップページ、ページ一覧を参考にし、内容が食い違わないようにします。</div>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={useWeb}
                    disabled={NEEDS_WEB.has(preset) || NO_WEB.has(preset)}
                    onChange={(e) => toggleWeb(e.target.checked)}
                    data-testid="ai-web"
                  />
                  Web で調べる
                </label>
                <div className="ai-hint">
                  {NEEDS_WEB.has(preset)
                    ? "誤情報の訂正では、常に Google 検索で確かめます。"
                    : NO_WEB.has(preset)
                    ? "リンクを張るときは Web は使いません。"
                    : "Google 検索で確認できた事実だけを足し、出典を付けます。"}
                </div>
              </div>

              <div className="ai-label">指示</div>
              <textarea
                className="input-block ai-instruction"
                rows={2}
                placeholder="追加の指示（任意）例: 箇条書きにして、敬体にそろえて"
                value={instruction}
                data-testid="ai-instruction"
                onChange={(e) => setInstruction(e.target.value)}
                onCompositionEnd={() => (compEnd.current = performance.now())}
                onKeyDown={(e) => {
                  if (isImeKey(e, compEnd.current)) return;
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (phase.kind !== "loading") void run();
                  }
                }}
              />
            </div>
            {phase.kind === "error" && (
              <div className="notice">{phase.message}</div>
            )}
            {phase.kind === "loading" && <AiProgress text={phase.text} started={phase.started} web={useWeb} />}
            <p className="ai-privacy">
              対象（とページ全体の文脈{wikiCtx && "、関連ページ"}）が Google の Gemini に送られます
              {useWeb && "。ページの内容をもとに Google 検索も行われます"}
              。提案は保存されず、採用した変更だけが通常の編集として保存されます。
            </p>
            <div className="modal-actions">
              {phase.kind === "loading" ? (
                <button className="btn" onClick={stop} data-testid="ai-stop">
                  中止
                </button>
              ) : (
                <button className="btn" onClick={onClose}>
                  閉じる
                </button>
              )}
              <button
                className="btn btn-primary"
                onClick={run}
                disabled={phase.kind === "loading"}
                data-testid="ai-run"
              >
                {phase.kind === "loading" ? "作成中…" : "提案を作成"}
              </button>
            </div>
          </>
        )}

        {phase.kind === "review" && (
          <>
            {phase.summary && (
              <p className="ai-summary" data-testid="ai-summary">
                {phase.summary}
              </p>
            )}
            {phase.related.length > 0 && (
              <p className="ai-related muted small" data-testid="ai-related">
                参考にしたページ: {phase.related.map((n) => `「${n}」`).join("")}
              </p>
            )}
            {choices.length === 0 ? (
              <p className="muted">変更の提案はありませんでした。</p>
            ) : (
              <>
                <div className="ai-bulk muted small">
                  {links
                    ? `${links.length} 語のリンク · ${accepted.size} 語を採用`
                    : `${choices.length} か所の変更 · ${accepted.size} か所を採用`}
                  <button
                    className="link-btn"
                    onClick={() => setAccepted(new Set(choices))}
                  >
                    すべて選ぶ
                  </button>
                  <button
                    className="link-btn"
                    onClick={() => setAccepted(new Set())}
                  >
                    すべて外す
                  </button>
                </div>
                {links ? (
                  <LinkChoices
                    text={target}
                    links={links}
                    accepted={accepted}
                    onToggle={toggle}
                  />
                ) : (
                  <ReviewDiff
                    segments={phase.segments}
                    accepted={accepted}
                    onToggle={toggle}
                  />
                )}
              </>
            )}
            <div className="modal-actions">
              <span className="muted small ai-remaining">
                {phase.remaining !== null && `今日の残り ${phase.remaining} 回`}
              </span>
              <button
                className="btn"
                onClick={() => setPhase({ kind: "ask" })}
                data-testid="ai-back"
              >
                指示を変える
              </button>
              <button className="btn" onClick={onClose}>
                採用しない
              </button>
              <button
                className="btn btn-primary"
                onClick={apply}
                disabled={accepted.size === 0}
                data-testid="ai-apply"
              >
                {links ? "選んだリンクを採用" : "選んだ変更を採用"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Append a 出典 list to a web-grounded revision (only when something changed). */
export function withSources(
  target: string,
  revised: string,
  sources: { uri: string; title?: string }[],
): string {
  if (!sources.length || revised === target) return revised;
  const trail = /\n*$/.exec(revised)![0];
  const label = (s: { uri: string; title?: string }) =>
    (s.title || new URL(s.uri).hostname).replace(/[[\]]/g, "");
  const list = sources
    .map(
      (s) =>
        `- [${label(s)}](${s.uri.replace(/[()\s]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))})`,
    )
    .join("\n");
  return revised.replace(/\n*$/, "") + "\n\n出典:\n\n" + list + trail;
}

/**
 * Diff for review.  Sources (web mode) are split off into a hunk of their own at the
 * end, so they can be adopted or left out separately from the last edit.
 */
export function reviewSegments(
  target: string,
  revised: string,
  sources: { uri: string; title?: string }[],
): Segment[] {
  const full = withSources(target, revised, sources);
  const trail = (t: string) => /\n*$/.exec(t)![0];
  if (full === revised || trail(target) !== trail(revised))
    return diffHunks(target, full);
  // Diff the bodies without their trailing newlines, then: sources hunk, trailing newlines.
  const k = trail(target).length;
  const segments = diffHunks(
    target.slice(0, target.length - k),
    revised.slice(0, revised.length - k),
  );
  const id =
    Math.max(-1, ...segments.flatMap((s) => ("id" in s ? [s.id] : []))) + 1;
  const body = revised.length - k;
  segments.push({
    id,
    del: [],
    add: full
      .slice(body, full.length - k)
      .split("\n")
      .slice(1),
  }); // "\n\n出典:…" → ['', '出典:', '', '- …']
  if (k) segments.push({ same: new Array<string>(k).fill("") });
  return segments;
}

/** Each suggested link with a checkbox: the words around it, its page, and whether that page exists. */
function LinkChoices({
  text,
  links,
  accepted,
  onToggle,
}: {
  text: string;
  links: LinkSuggestion[];
  accepted: Set<number>;
  onToggle: (i: number) => void;
}) {
  const around = (l: LinkSuggestion) => {
    const ls = text.lastIndexOf("\n", l.at - 1) + 1;
    const le = text.indexOf("\n", l.at) < 0 ? text.length : text.indexOf("\n", l.at);
    const a = Math.max(ls, l.at - 24);
    const b = Math.min(le, l.at + l.label.length + 24);
    return {
      before: (a > ls ? "…" : "") + text.slice(a, l.at),
      after: text.slice(l.at + l.label.length, b) + (b < le ? "…" : ""),
    };
  };
  return (
    <ul className="ai-links" data-testid="ai-links">
      {links.map((l, i) => {
        const on = accepted.has(i);
        const { before, after } = around(l);
        return (
          <li key={i}>
            <label className={"ai-link" + (on ? " on" : "")} data-testid="ai-link">
              <input
                type="checkbox"
                checked={on}
                onChange={() => onToggle(i)}
                aria-label={`「${l.label}」をリンクにする`}
              />
              <span className="ai-link-body">
                <span className="ai-link-head">
                  <strong>{l.label}</strong>
                  {l.target !== l.label && <span className="muted"> → {l.target}</span>}
                  <span className={"tag" + (l.exists ? "" : " tag-new")}>
                    {l.exists ? "既存のページ" : "新しいページ"}
                  </span>
                </span>
                <span className="ai-link-ctx muted small">
                  {before}
                  <mark>{l.label}</mark>
                  {after}
                </span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/** Unchanged lines (collapsed) and each hunk with a checkbox; changed characters highlighted. */
function ReviewDiff({
  segments,
  accepted,
  onToggle,
}: {
  segments: Segment[];
  accepted: Set<number>;
  onToggle: (id: number) => void;
}) {
  const rows = segments;
  return (
    <div className="ai-diff" data-testid="ai-diff">
      {rows.map((s, i) => {
        if ("same" in s) {
          const first = i === 0;
          const last = i === rows.length - 1;
          const ctx = 2;
          if (
            s.same.length <= ctx * 2 + 1 ||
            (first && s.same.length <= ctx) ||
            (last && s.same.length <= ctx)
          )
            return <Same key={i} lines={s.same} />;
          return (
            <div key={i}>
              {!first && <Same lines={s.same.slice(0, ctx)} />}
              <div className="ai-skip muted small">…</div>
              {!last && <Same lines={s.same.slice(-ctx)} />}
            </div>
          );
        }
        const on = accepted.has(s.id);
        const pair = s.del.length === s.add.length;
        return (
          <label
            key={i}
            className={"ai-hunk" + (on ? " on" : "")}
            data-testid="ai-hunk"
          >
            <input
              type="checkbox"
              checked={on}
              onChange={() => onToggle(s.id)}
              aria-label="この変更を採用"
            />
            <div className="ai-hunk-body">
              {s.del.map((t, j) => (
                <div key={"d" + j} className="ai-line del">
                  {pair ? (
                    <Marked parts={charDiff(t, s.add[j]).del} />
                  ) : (
                    t || " "
                  )}
                </div>
              ))}
              {s.add.map((t, j) => (
                <div key={"a" + j} className="ai-line add">
                  {pair ? (
                    <Marked parts={charDiff(s.del[j], t).add} />
                  ) : (
                    t || " "
                  )}
                </div>
              ))}
            </div>
          </label>
        );
      })}
    </div>
  );
}

function Same({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((t, i) => (
        <div key={i} className="ai-line same">
          {t || " "}
        </div>
      ))}
    </>
  );
}

function Marked({ parts }: { parts: { text: string; changed: boolean }[] }) {
  if (parts.length === 0) return <> </>;
  return (
    <>
      {parts.map((p, i) =>
        p.changed ? <mark key={i}>{p.text}</mark> : p.text,
      )}
    </>
  );
}
