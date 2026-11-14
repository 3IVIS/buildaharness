/**
 * Layout states of the Email page, rebased on Write's two breakpoints (640 and 960 px): a phone below 640, a tablet from 640, a desktop from 960.
 * The functions are pure so each state can be tested without a browser.
 */
export type LayoutMode = 'phone' | 'tablet' | 'desktop'
export type PhonePanel = 'email' | 'todo' | 'aielia'

export const TABLET_MIN = 640
export const DESKTOP_MIN = 960
/** The Aielia column: about 340 px, resizable between these limits. */
export const CHAT_DEFAULT = 340
export const CHAT_MIN = 260
export const CHAT_MAX = 640
/** The folder rail is an icon strip when collapsed and a tree when open. */
export const RAIL_COLLAPSED = 48
export const RAIL_OPEN = 220
/** Below this width the mail area puts the reader under the list instead of beside it. */
export const READER_BESIDE_MIN = 720

export function layoutFor(width: number): LayoutMode {
  return width >= DESKTOP_MIN ? 'desktop' : width >= TABLET_MIN ? 'tablet' : 'phone'
}

/** Read the mode from matchMedia, so a test that mocks only matchMedia drives the layout. No matchMedia reads as a phone, as in Write. */
export function layoutNow(): LayoutMode {
  if (typeof window === 'undefined' || !window.matchMedia) return 'phone'
  if (window.matchMedia(`(min-width: ${DESKTOP_MIN}px)`).matches) return 'desktop'
  if (window.matchMedia(`(min-width: ${TABLET_MIN}px)`).matches) return 'tablet'
  return 'phone'
}

export const clampChat = (px: number, room = Infinity): number => Math.round(Math.min(Math.max(px, CHAT_MIN), Math.max(CHAT_MIN, Math.min(CHAT_MAX, room))))

/** Where the reader goes: beside the list when the mail area is wide enough, otherwise below it. On a phone the reader replaces the list. */
export function readerPlacement(mode: LayoutMode, viewportWidth: number, chatWidth: number, railPinned: boolean): 'beside' | 'below' | 'replace' {
  if (mode === 'phone') return 'replace'
  const chat = mode === 'desktop' ? chatWidth : 0 // a tablet's Aielia column is a slide-over, it takes no room
  const rail = railPinned ? RAIL_OPEN : RAIL_COLLAPSED
  return viewportWidth - chat - (mode === 'desktop' ? rail : 0) >= READER_BESIDE_MIN ? 'beside' : 'below'
}
