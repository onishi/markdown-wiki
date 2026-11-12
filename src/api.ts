export class ApiError extends Error {
  constructor(
    public status: number,
    public body: any,
  ) {
    super(body?.error ?? `HTTP ${status}`)
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'markdown-wiki' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (e) {
    throw new ApiError(0, { error: 'network' })
  }
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, json)
  return json as T
}

export type Role = 'owner' | 'editor' | 'viewer'

export interface Me {
  user: { id: string; email: string; name: string; picture: string }
  settings: { listMode?: 'list' | 'item'; softBreak?: 'break' | 'join' }
}
export interface WikiSummary {
  id: string
  /** URL identifier: /w/<slug> */
  slug: string
  name: string
  role: Role
  /** Page shown at /w/:wid (null: the page list). */
  topPageId?: string | null
  topPage?: string | null
  pageCount?: number
  memberCount?: number
}
export interface PageSummary {
  id: string
  name: string
  updatedAt: number
}
export interface Page extends PageSummary {
  content: string
  version: number
  updatedByName: string | null
}

export const encodePath = (name: string) => name.split('/').map(encodeURIComponent).join('/')
export const wikiUrl = (slug: string) => `/w/${slug}`
export const pageUrl = (slug: string, name: string) => `/w/${slug}/p/${encodePath(name)}`

export const ROLE_LABEL: Record<Role, string> = { owner: 'オーナー', editor: '編集者', viewer: '閲覧者' }

/** Upload an image to the wiki; returns its URL (members-only). */
export async function uploadImage(wikiId: string, file: Blob, name: string): Promise<{ url: string; name: string }> {
  let res: Response
  try {
    res = await fetch(`/api/wikis/${wikiId}/files?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream', 'x-requested-with': 'markdown-wiki' },
      body: file,
    })
  } catch {
    throw new ApiError(0, { error: 'network' })
  }
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, json)
  return json.file
}
