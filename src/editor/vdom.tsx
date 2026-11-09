import { createElement, type ReactNode } from 'react'
import type { VNode } from '../../shared/markdown/render'

export interface Run {
  offs: number[]
}

/**
 * Convert render vnodes to React elements.  Every text vnode becomes
 * `<span class="r" data-r={i}>` and its source map is stored in `runs[i]`.
 */
export function toReact(nodes: VNode[], runs: Run[], slot: () => ReactNode, keyPrefix = ''): ReactNode[] {
  return nodes.map((n, i) => node(n, runs, slot, `${keyPrefix}${i}`))
}

function node(n: VNode, runs: Run[], slot: () => ReactNode, key: string): ReactNode {
  switch (n.k) {
    case 'text': {
      const id = runs.length
      runs.push({ offs: n.offs })
      return (
        <span className="r" data-r={id} key={key}>
          {n.text}
        </span>
      )
    }
    case 'raw':
      return <div className="raw" key={key} dangerouslySetInnerHTML={{ __html: n.html }} />
    case 'slot':
      return <SlotWrap key={key}>{slot()}</SlotWrap>
    case 'el': {
      const props: Record<string, unknown> = { key }
      for (const [k, v] of Object.entries(n.attrs ?? {})) {
        if (v === undefined || v === false) continue
        if (k === 'class') props.className = v
        else if (k === 'style') props.style = parseStyle(String(v))
        else if (k === 'checked') props.checked = true
        else props[k] = v
      }
      if (n.tag === 'input') {
        props.readOnly = true
        props.tabIndex = -1
        if (!('checked' in props)) props.checked = false
        return createElement('input', props)
      }
      if (n.tag === 'a') props.draggable = false
      if (n.tag === 'img') {
        props.draggable = false
        return createElement('img', props)
      }
      if (n.tag === 'br') return createElement('br', props)
      return createElement(n.tag, props, ...toReact(n.children, runs, slot, `${key}.`))
    }
  }
}

function SlotWrap({ children }: { children: ReactNode }) {
  return <>{children}</>
}

function parseStyle(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of s.split(';')) {
    const [k, v] = part.split(':')
    if (k && v) out[k.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v.trim()
  }
  return out
}
