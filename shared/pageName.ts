/** Page names use `/` for hierarchy: `開発/API/認証`. */
export const MAX_PAGE_NAME = 200

export function normalizePageName(raw: string): string {
  return raw
    .normalize('NFC')
    .split('/')
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => s.length > 0)
    .join('/')
}

export function validatePageName(raw: string): string | null {
  const n = normalizePageName(raw)
  if (!n) return null
  if (n.length > MAX_PAGE_NAME) return null
  if (/[\[\]|#\u0000-\u001f]/.test(n)) return null
  return n
}

export function parentName(name: string): string | null {
  const i = name.lastIndexOf('/')
  return i < 0 ? null : name.slice(0, i)
}

export function baseName(name: string): string {
  const i = name.lastIndexOf('/')
  return i < 0 ? name : name.slice(i + 1)
}

export interface TreeNode {
  name: string // full path
  label: string
  pageId: string | null // null => virtual folder (no page with this exact name)
  children: TreeNode[]
}

export function buildTree(pages: { id: string; name: string }[]): TreeNode[] {
  const root: TreeNode = { name: '', label: '', pageId: null, children: [] }
  const index = new Map<string, TreeNode>([['', root]])
  const sorted = [...pages].sort((a, b) => a.name.localeCompare(b.name, 'ja'))
  for (const p of sorted) {
    const segs = p.name.split('/')
    let path = ''
    let parent = root
    segs.forEach((seg, i) => {
      path = path ? `${path}/${seg}` : seg
      let n = index.get(path)
      if (!n) {
        n = { name: path, label: seg, pageId: null, children: [] }
        index.set(path, n)
        parent.children.push(n)
      }
      if (i === segs.length - 1) n.pageId = p.id
      parent = n
    })
  }
  return root.children
}
