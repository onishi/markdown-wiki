import type { Root } from 'mdast'
import { parseMarkdown } from '../../shared/markdown/parse'
import { sliceMarkdown } from '../../shared/markdown/copy'
import { markdownToHtml, type SoftBreak, type WikiResolver } from '../../shared/markdown/render'

export type CopyFormat = 'plain' | 'markdown' | 'rich'

export interface CopyPayload {
  plain: string
  markdown: string
  html: string
}

export function buildPayload(
  tree: Root,
  src: string,
  a: number,
  b: number,
  visibleText: string,
  absoluteWiki: WikiResolver,
  softBreak: SoftBreak = 'gfm',
): CopyPayload {
  const markdown = sliceMarkdown(tree, src, Math.min(a, b), Math.max(a, b))
  const html = markdownToHtml(parseMarkdown(markdown), markdown, absoluteWiki, softBreak)
  const plain = visibleText.replace(/​/g, '')
  return { plain, markdown, html }
}

/** Write to the async clipboard (used from menus, outside a copy event). */
export async function writeClipboard(format: CopyFormat, p: CopyPayload): Promise<void> {
  if (format === 'rich' && typeof ClipboardItem !== 'undefined') {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([p.html], { type: 'text/html' }),
        'text/plain': new Blob([p.plain], { type: 'text/plain' }),
      }),
    ])
    return
  }
  await navigator.clipboard.writeText(format === 'markdown' ? p.markdown : p.plain)
}
