import { useEffect, useState } from 'react'
import type { Highlighter, HlNode } from '../shared/markdown/render'

/**
 * Syntax highlighting for fenced code blocks with a language (```perl).  The highlighter
 * (lowlight / highlight.js common languages) is loaded lazily, only for pages that need it.
 */
let loaded: Highlighter | null = null
let loading: Promise<Highlighter> | null = null

function load(): Promise<Highlighter> {
  loading ??= import('lowlight').then(({ createLowlight, common }) => {
    const low = createLowlight(common)
    type H = { type: string; value?: string; properties?: { className?: unknown }; children?: H[] }
    const conv = (ns: H[]): HlNode[] =>
      ns.flatMap((n): HlNode[] => {
        if (n.type === 'text') return [n.value ?? '']
        if (n.type !== 'element') return []
        const cn = n.properties?.className
        const cls = (Array.isArray(cn) ? cn : [cn]).filter((c): c is string => typeof c === 'string' && /^hljs-[\w-]+$/.test(c)).join(' ')
        const kids = conv(n.children ?? [])
        return cls ? [{ cls, children: kids }] : kids
      })
    loaded = (code, lang) => {
      const l = lang.toLowerCase()
      if (!low.registered(l)) return null
      return conv(low.highlight(l, code).children as H[])
    }
    return loaded
  })
  return loading
}

/** True when the Markdown has a fenced code block naming a language. */
export function wantsHighlight(src: string): boolean {
  return /^[ \t>]*(?:[-*+]\s+|\d+[.)]\s+)?(```|~~~)[ \t]*[\w+#.-]/m.test(src)
}

/** The highlighter once loaded (undefined until then, or when the text has no such block). */
export function useHighlighter(src: string): Highlighter | undefined {
  const need = wantsHighlight(src)
  const [hl, setHl] = useState<Highlighter | undefined>(() => loaded ?? undefined)
  useEffect(() => {
    if (!need || hl) return
    let live = true
    load().then((h) => live && setHl(() => h), () => {})
    return () => {
      live = false
    }
  }, [need, hl])
  return hl
}
