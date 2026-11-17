import { useEffect, useState } from 'react'

/** Whether a CSS media query matches, kept up to date. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches)
  useEffect(() => {
    const m = matchMedia(query)
    const h = () => setOn(m.matches)
    h()
    m.addEventListener('change', h)
    return () => m.removeEventListener('change', h)
  }, [query])
  return on
}

/** Wide screens get the app header; phones get the compact bar and a drawer (same breakpoint as the CSS). */
export const DESKTOP = '(min-width: 761px)'
