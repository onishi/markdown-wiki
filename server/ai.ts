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
  clarify: '読みやすくする: 長い文を分け、順序や見出し・箇条書きを整理する。情報は減らさない。',
  trim: '簡潔にする: 重複や冗長な言い回しを削る。必要な情報は残す。',
  expand: '項目を増やす: 足りない観点を見出しや箇条として追加する。内容が本文から分からない項目は「(TBD)」とだけ書く。',
  tbd: '「(TBD)」「TODO」など書きかけの箇所を、本文から分かる範囲で埋める。分からない箇所はそのまま残す。それ以外は変えない。',
  table: '列挙されている情報を、適切な列を持つ Markdown の表に整理する。',
  summary: '冒頭に 2〜4 行の要約（箇条書き）を追加する。本文は変えない。',
} as const
export type AiPreset = keyof typeof AI_PRESETS
export const isAiPreset = (p: unknown): p is AiPreset => typeof p === 'string' && p in AI_PRESETS

export interface ReviseRequest {
  wikiName: string
  pageName: string
  /** The whole page (context). */
  page: string
  /** The part to rewrite (the whole page when start = 0, end = page.length). */
  start: number
  end: number
  preset: AiPreset
  instruction: string
}
export interface ReviseResult {
  revised: string
  summary: string
}
export type Reviser = (r: ReviseRequest) => Promise<ReviseResult>

const SYSTEM = `あなたはチームで使う Markdown wiki の編集を手伝うアシスタントです。
指定された「対象」の部分を、指示に従って書き換えた結果を返します。

【ルール】
- 書き換えるのは「対象」だけです。返す revised は、書き換え後の「対象」部分の全文です（ページ全体ではありません。対象の外の文章を含めないでください）。
- 指示に関係しない箇所は一字一句変えないでください。好みで言い回しを変えないでください。
- 本文に書かれていない事実・数値・固有名詞を作らないでください。推測で補わないでください。
- 文体（です・ます／である）、用語、表記は元の文章に合わせてください。
- Markdown の構造を保ってください。[[ページ名]] や [[ページ名|表示名]] の wiki リンク、URL、画像、コードブロックの中身は変えないでください。
- summary には、何をどう変えたかを日本語 1〜2 文で書いてください。変更が不要なら revised に対象をそのまま入れ、summary にその旨を書いてください。`

export function buildPrompt(r: ReviseRequest): string {
  const whole = r.start === 0 && r.end === r.page.length
  const target = r.page.slice(r.start, r.end)
  const task = [AI_PRESETS[r.preset], r.instruction.trim() && `追加の指示: ${r.instruction.trim()}`].filter(Boolean).join('\n')
  return `wiki「${r.wikiName}」のページ「${r.pageName}」を編集します。

【指示】
${task}

${
  whole
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
  // systemInstruction / JSON schema need v1beta (v1 rejects "Developer instruction").
  const ai = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' })
  return async (r) => {
    const res = await ai.models.generateContent({
      model: MODEL,
      contents: buildPrompt(r),
      config: {
        systemInstruction: SYSTEM,
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          properties: {
            revised: { type: 'string', description: '書き換え後の対象部分の全文（Markdown）' },
            summary: { type: 'string', description: '変更内容の要約（日本語 1〜2 文）' },
          },
          required: ['revised', 'summary'],
        },
      },
    })
    let text = ''
    try {
      text = res.text ?? ''
    } catch {
      // blocked or empty response
    }
    const out = JSON.parse(text) as Partial<ReviseResult>
    if (typeof out.revised !== 'string') throw new Error('bad_response')
    return { revised: out.revised, summary: typeof out.summary === 'string' ? out.summary : '' }
  }
}

/**
 * Deterministic stand-in for automated tests (enabled only together with dev login):
 * fixes "teh" → "the" and appends a line to the target.
 */
export const fakeReviser: Reviser = async (r) => {
  const target = r.page.slice(r.start, r.end)
  return { revised: target.replace(/teh/g, 'the') + '\n\n（AI 追記）', summary: `テスト用の提案（${r.preset}）` }
}
