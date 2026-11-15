/**
 * AI editing suggestions (Gemini, as in the ai-wiki project).
 *
 * The model returns the *whole revised target text*; the client diffs it against the
 * original itself, so every change — including ones the model was not asked to make —
 * is visible and can be rejected hunk by hunk.  Nothing is saved here.
 */
import { GoogleGenAI } from '@google/genai'

const MODEL = 'gemini-2.5-flash'

export const AI_PRESETS = {
  auto: 'お任せで改善: 誤字脱字、わかりにくい表現、見出しや箇条書きの構成を直す。',
  typo: '誤字脱字・表記ゆれ・文法の誤りだけを直す。表現や構成は変えない。',
  factcheck:
    '誤情報の訂正: 事実・数値・日付・固有名詞・用語の誤りや古くなった情報を Google 検索で確認し、正しい内容に直す。検索で誤りと確認できない箇所は変えない。表現や構成は変えない。summary には直した箇所を「誤 → 正」の形で挙げる（誤りがなければそう書く）。',
  clarify: '読みやすくする: 長い文を分け、順序や見出し・箇条書きを整理する。情報は減らさない。',
  trim: '簡潔にする: 重複や冗長な言い回しを削る。必要な情報は残す。',
  expand: '項目を増やす: 足りない観点を見出しや箇条として追加する。内容が本文から分からない項目は「(TBD)」とだけ書く。',
  tbd: '「(TBD)」「TODO」など書きかけの箇所を、本文から分かる範囲で埋める。分からない箇所はそのまま残す。それ以外は変えない。',
  table: '列挙されている情報を、適切な列を持つ Markdown の表に整理する。',
  summary: '冒頭に 2〜4 行の要約（箇条書き）を追加する。本文は変えない。',
} as const
export type AiPreset = keyof typeof AI_PRESETS
export const isAiPreset = (p: unknown): p is AiPreset => typeof p === 'string' && p in AI_PRESETS
/** Tasks that only make sense with Google Search (web mode is forced on). */
export const AI_NEEDS_WEB: ReadonlySet<AiPreset> = new Set(['factcheck'])

/** How long the result should be compared with the target ("auto": whatever the task needs). */
export const AI_VOLUMES = {
  auto: '',
  short: '分量: 対象のおよそ半分を目安に短くする。要点は残す。',
  same: '分量: 対象とほぼ同じ長さに保つ。',
  long: '分量: 対象の 1.5〜2 倍まで（それ以上にはしない）。足してよいのは、本文にすでにある内容の説明・理由・つながり・順序だけ。一般論の解説や、本文にない手順・コマンド・バージョン・URL・例は足さない。',
} as const
export type AiVolume = keyof typeof AI_VOLUMES
export const isAiVolume = (v: unknown): v is AiVolume => typeof v === 'string' && v in AI_VOLUMES

export interface ReviseRequest {
  wikiName: string
  pageName: string
  /** The whole page (context). */
  page: string
  /** The part to rewrite (the whole page when start = 0, end = page.length). */
  start: number
  end: number
  preset: AiPreset
  /** Target length (default "auto"). */
  volume?: AiVolume
  instruction: string
  /** Let the model look things up with Google Search (grounding). */
  web?: boolean
}
export interface AiSource {
  uri: string
  title?: string
}
export interface ReviseResult {
  revised: string
  summary: string
  /** Web pages the answer was grounded on (web mode only). */
  sources?: AiSource[]
}
/** `onText` (optional) receives the raw answer as it streams in (the whole text so far). */
export type Reviser = (r: ReviseRequest, onText?: (soFar: string) => void) => Promise<ReviseResult>

const COMMON_RULES = `- 書き換えるのは「対象」だけです。返す revised は、書き換え後の「対象」部分の全文です（ページ全体ではありません。対象の外の文章を含めないでください）。
- 指示に関係しない箇所は一字一句変えないでください。好みで言い回しを変えないでください。
- 文体（です・ます／である）、用語、表記は元の文章に合わせてください。
- Markdown の構造を保ってください。[[ページ名]] や [[ページ名|表示名]] の wiki リンク、URL、画像、コードブロックの中身は変えないでください。`

/**
 * The answer comes in tags rather than JSON: it streams (the revised text can be shown
 * as it is written) and Google Search grounding cannot be combined with JSON output.
 */
const FORMAT = (summary: string) => `【出力形式】次の形式だけを出力してください。前後に説明やコードフェンスを付けないでください。
<summary>${summary}</summary>
<revised>
書き換え後の対象部分の全文（変更が不要なら対象をそのまま）
</revised>`

const SYSTEM = `あなたはチームで使う Markdown wiki の編集を手伝うアシスタントです。
指定された「対象」の部分を、指示に従って書き換えた結果を返します。

【ルール】
${COMMON_RULES}
- 本文に書かれていない事実・数値・固有名詞を作らないでください。推測で補わないでください。ただし対象が空で本文を新しく書くときは、確実に知っている事実だけを書き、不確かな数値・日付・固有名詞は「(TBD)」としてください。
- 本文にない URL、[[リンク]]、コマンド、設定値を新しく作らないでください。
- 変更が不要なら revised に対象をそのまま入れ、summary にその旨を書いてください。

${FORMAT('何をどう変えたか（日本語 1〜2 文）')}`

const SYSTEM_WEB = `あなたはチームで使う Markdown wiki の編集を手伝うアシスタントです。
指定された「対象」の部分を、指示に従って書き換えた結果を返します。必要に応じて Google 検索で調べてください。

【ルール】
${COMMON_RULES}
- 本文にない事実・数値・固有名詞は、Google 検索の結果で確認できたものだけを追加してください。確認できないことは書かず、推測で補わないでください。「(TBD)」は検索で確認できた場合だけ埋めてください。
- ページタイトル（主題）について調べてください。同名の別のものと取り違えないでください。
- 本文に URL や出典は書かないでください（出典は別に表示されます）。本文にない [[リンク]]、コマンド、設定値も作らないでください。

${FORMAT('何をどう変えたか（日本語 1〜2 文。検索で確認した内容を足した場合はそのことも）')}`

/** Pull summary / revised out of the tagged web-mode answer. */
export function parseTagged(text: string): { revised: string; summary: string } {
  const a = text.indexOf('<revised>')
  const b = text.lastIndexOf('</revised>')
  if (a < 0 || b < a) throw new Error('bad_response')
  let revised = text.slice(a + '<revised>'.length, b)
  if (revised.startsWith('\n')) revised = revised.slice(1)
  if (revised.endsWith('\n')) revised = revised.slice(0, -1)
  const m = /<summary>([\s\S]*?)<\/summary>/.exec(text)
  return { revised, summary: m ? m[1].trim() : '' }
}

/** Grounding links are redirects through Google; resolve them to the real page (best effort). */
async function resolveSource(uri: string, title?: string): Promise<AiSource> {
  // Only follow Google's own redirector; never fetch arbitrary hosts from the server.
  if (!/^https:\/\/vertexaisearch\.cloud\.google\.com\//.test(uri)) return { uri, title }
  try {
    const res = await fetch(uri, { redirect: 'follow', signal: AbortSignal.timeout(5000) })
    await res.body?.cancel()
    return { uri: res.url || uri, title }
  } catch {
    return { uri, title }
  }
}

/** What the page is about: its title is the subject, and `/` in it is the hierarchy. */
export function pageInfo(wikiName: string, pageName: string): string {
  const parts = pageName.split('/').filter(Boolean)
  const leaf = parts[parts.length - 1] ?? pageName
  const lines = [`【ページ情報】`, `- wiki: ${wikiName}`, `- ページタイトル: ${pageName}`]
  if (parts.length > 1) lines.push(`- 階層: ${parts.map((p) => `「${p}」`).join(' > ')}（「${parts.slice(0, -1).join('/')}」の下にある「${leaf}」のページ）`)
  lines.push(
    `- このページの主題は「${leaf}」です。何を書くべきか・何が足りないか・どこまでが関係する内容かは、タイトル（と階層）を手がかりに判断してください。`,
    `- タイトルは画面に別に表示されるので、本文の先頭にタイトルの見出しを足す必要はありません。`,
  )
  return lines.join('\n')
}

export function buildPrompt(r: ReviseRequest): string {
  const whole = r.start === 0 && r.end === r.page.length
  const target = r.page.slice(r.start, r.end)
  const blank = target.trim() === ''
  const task = [
    blank && 'ページは空です。ページタイトル（主題）について、以下の指示に沿って本文を新しく書いてください。見出しは「##」から始め、タイトルの見出しは付けないでください。',
    AI_PRESETS[r.preset], AI_VOLUMES[r.volume ?? 'auto'], r.instruction.trim() && `追加の指示: ${r.instruction.trim()}`]
    .filter(Boolean)
    .join('\n')
  return `${pageInfo(r.wikiName, r.pageName)}

【指示】
${task}

${
  blank
    ? `【対象】（空のページ。書いた本文全体を revised として返してください）
<target>
</target>`
    : whole
    ? `【対象】（ページ全体）
<target>
${target}
</target>`
    : `【ページ全体】（参考。対象以外は変更しません）
<page>
${r.page}
</page>

【対象】（ページの一部）
<target>
${target}
</target>`
}`
}

export function geminiReviser(apiKey: string): Reviser {
  // systemInstruction needs v1beta (v1 rejects "Developer instruction").
  const ai = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' })
  return async (r, onText) => {
    const stream = await ai.models.generateContentStream({
      model: MODEL,
      contents: buildPrompt(r),
      config: r.web ? { systemInstruction: SYSTEM_WEB, tools: [{ googleSearch: {} }] } : { systemInstruction: SYSTEM },
    })
    let text = ''
    const chunks: { uri: string; title?: string }[] = []
    for await (const res of stream) {
      let t = ''
      try {
        t = res.text ?? ''
      } catch {
        // blocked or empty chunk
      }
      if (t) {
        text += t
        onText?.(text)
      }
      for (const c of res.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) if (c.web?.uri) chunks.push({ uri: c.web.uri, title: c.web.title })
    }
    const out = parseTagged(text)
    if (!r.web) return out
    const seen = new Set<string>()
    const unique = chunks.filter((c) => !seen.has(c.uri) && seen.add(c.uri))
    const sources = await Promise.all(unique.slice(0, 8).map((c) => resolveSource(c.uri, c.title)))
    return { ...out, sources }
  }
}

/**
 * Deterministic stand-in for automated tests (enabled only together with dev login):
 * fixes "teh" → "the" and appends a line to the target.
 */
export const fakeReviser: Reviser = async (r, onText) => {
  const target = r.page.slice(r.start, r.end)
  const revised = target.replace(/teh/g, 'the') + '\n\n（AI 追記）'
  const summary = `テスト用の提案（${r.preset}${r.volume && r.volume !== 'auto' ? ', ' + r.volume : ''}${r.web ? ', web' : ''}）`
  if (onText) {
    // Stream it like the model does: partway, a pause, then the rest.
    const whole = `<summary>${summary}</summary>\n<revised>\n${revised}\n</revised>`
    const cut = whole.indexOf('<revised>') + '<revised>\n'.length + Math.ceil(revised.length / 2)
    onText(whole.slice(0, cut))
    await new Promise((res) => setTimeout(res, r.instruction.includes('[slow]') ? 1500 : 50))
    onText(whole)
  }
  return { revised, summary, sources: r.web ? [{ uri: 'https://example.com/source', title: 'example.com' }] : undefined }
}
