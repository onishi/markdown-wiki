/**
 * How mouse gestures on links behave in display mode.  This is an open design
 * question in the spec, so it is isolated here and easy to change.
 */
export type LinkGesture = 'click' | 'modClick' | 'altClick' | 'doubleClick'
export type LinkAction = 'placeCaret' | 'open' | 'openNewTab' | 'edit'

export const linkPolicy: Record<LinkGesture, LinkAction> & { showLinkMenu: boolean } = {
  click: 'open', // a plain click opens the link (a drag or Shift+click still selects)
  modClick: 'openNewTab', // Cmd (mac) / Ctrl (others) + click
  altClick: 'placeCaret', // Alt/Option + click puts the caret inside the link text
  doubleClick: 'edit', // only reachable with Alt held (a plain first click already opened the link)
  /** Show a small popover with "open" when the caret is inside a link (keyboard / Alt+click). */
  showLinkMenu: true,
}

export function gestureOf(e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; detail: number }): LinkGesture {
  if (e.metaKey || e.ctrlKey) return 'modClick'
  if (e.detail >= 2) return 'doubleClick'
  if (e.altKey) return 'altClick'
  return 'click'
}
