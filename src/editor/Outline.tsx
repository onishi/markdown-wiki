import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseMarkdown } from '../../shared/markdown/parse'
import { extractOutline, type OutlineItem } from '../../shared/markdown/outline'

/** Headings of the source as an outline; clicking one jumps there. */
export function Outline({ source, onJump }: { source: string; onJump: (item: OutlineItem) => void }) {
  const items = useMemo(() => extractOutline(parseMarkdown(source)), [source])
  const [active, pin] = useActiveHeading(items.length)
  if (!items.length) return <div className="outline-empty muted small">見出しがありません。<code>#</code> で始まる行が見出しになります。</div>
  const minDepth = Math.min(...items.map((i) => i.depth))
  return (
    <ol className="outline" aria-label="アウトライン" data-testid="outline">
      {items.map((it, i) => (
        <li key={`${it.start}:${i}`}>
          <button
            className={`outline-item ${i === active ? 'active' : ''}`}
            style={{ paddingLeft: 8 + (it.depth - minDepth) * 14 }}
            onClick={() => {
              pin(i)
              onJump(it)
            }}
            title={it.text}
          >
            {it.text}
          </button>
        </li>
      ))}
    </ol>
  )
}

/** Index of the heading currently at the top of the viewport (scroll spy). */
function useActiveHeading(count: number): [number, (i: number) => void] {
  const [active, setActive] = useState(0)
  // After a click the clicked heading stays active until the user scrolls by hand.
  const pinnedUntil = useRef(0)
  const pin = useCallback((i: number) => {
    pinnedUntil.current = performance.now() + 400
    setActive(i)
  }, [])
  useEffect(() => {
    let raf = 0
    const update = () => {
      if (performance.now() < pinnedUntil.current) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const hs = document.querySelectorAll('[data-testid=doc] [data-h]')
        let idx = 0
        hs.forEach((h, i) => {
          if (h.getBoundingClientRect().top < 120) idx = i
        })
        setActive(idx)
      })
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [count])
  return [active, pin]
}
