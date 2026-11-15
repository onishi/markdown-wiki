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

/**
 * Index of the heading currently at the top of the viewport (scroll spy).  At the bottom
 * of the page the last headings can never reach the top, so there the last heading on
 * screen counts.
 */
function useActiveHeading(count: number): [number, (i: number) => void] {
  const [active, setActive] = useState(0)
  // After a click the clicked heading stays active until the user scrolls by hand.
  const pinned = useRef(false)
  const pin = useCallback((i: number) => {
    pinned.current = true
    setActive(i)
  }, [])
  useEffect(() => {
    let raf = 0
    const update = () => {
      if (pinned.current) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const hs = document.querySelectorAll('[data-testid=doc] [data-h]')
        const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4
        let idx = 0
        hs.forEach((h, i) => {
          const top = h.getBoundingClientRect().top
          if (top < 120 || (atBottom && top < window.innerHeight - 40)) idx = i
        })
        setActive(idx)
      })
    }
    const byHand = () => {
      if (!pinned.current) return
      pinned.current = false
      update()
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    for (const ev of ['wheel', 'touchmove', 'keydown', 'mousedown'] as const) window.addEventListener(ev, byHand, { passive: true, capture: true })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      for (const ev of ['wheel', 'touchmove', 'keydown', 'mousedown'] as const) window.removeEventListener(ev, byHand, { capture: true })
    }
  }, [count])
  return [active, pin]
}
