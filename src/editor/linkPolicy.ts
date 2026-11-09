/**
 * How mouse gestures on links behave in display mode.  This is an open design
 * question in the spec, so it is isolated here and easy to change.
 */
export type LinkGesture = 'click' | 'modClick' | 'doubleClick'
export type LinkAction = 'placeCaret' | 'open' | 'edit'

export const linkPolicy: Record<LinkGesture, LinkAction> & { showLinkMenu: boolean } = {
  click: 'placeCaret',
  modClick: 'open', // Cmd (mac) / Ctrl (others) + click
  doubleClick: 'edit',
  /** Show a small popover with "open" when the caret is placed inside a link. */
  showLinkMenu: true,
}

export function gestureOf(e: { metaKey: boolean; ctrlKey: boolean; detail: number }): LinkGesture {
  if (e.metaKey || e.ctrlKey) return 'modClick'
  if (e.detail >= 2) return 'doubleClick'
  return 'click'
}
