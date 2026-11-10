/**
 * Wiki identifier used in URLs: /w/<slug>/p/<page>.
 * Lowercase letters, digits and inner hyphens, 2–32 chars (never a UUID, so it can't
 * be confused with a wiki id).
 */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

export function normalizeSlug(s: string): string {
  return s.trim().toLowerCase()
}

export function validateSlug(s: string): string | null {
  if (s.length < 2) return '2 文字以上にしてください。'
  if (s.length > 32) return '32 文字以内にしてください。'
  if (!SLUG_RE.test(s)) return '半角英小文字・数字・ハイフンが使えます（先頭と末尾は英数字）。'
  return null
}
