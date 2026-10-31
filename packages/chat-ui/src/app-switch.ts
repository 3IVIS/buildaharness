import { isTauri } from '@tauri-apps/api/core'

/** The two screens of Aielia: the chat and the article writer. */
export type AppId = 'chat' | 'write'

export const APP_LABEL: Record<AppId, string> = { chat: 'Chat', write: 'Write' }

type Env = Record<string, unknown>

/**
 * Where the other page lives when the app runs as hosted web pages (myaielia.com/chat and /write). The deploy workflows set
 * VITE_APP_URL_CHAT on the Write build and VITE_APP_URL_WRITE on the chat build. Only a path on the same site is accepted
 * ("/write/", not "//host" or a full URL), so a build setting cannot send people elsewhere. Unset for every other build.
 */
export function webSwitchUrl(target: AppId, env: Env = import.meta.env as Env): string | undefined {
  const raw = env[target === 'write' ? 'VITE_APP_URL_WRITE' : 'VITE_APP_URL_CHAT']
  return typeof raw === 'string' && /^\/(?!\/)[\w\-./]*$/.test(raw) ? raw : undefined
}

export interface AppSwitchOptions {
  /** Desktop: switches the screen inside the app. */
  desktop?: (target: AppId) => void
  /** Web: how to go to a page. Defaults to a normal navigation. */
  navigate?: (url: string) => void
  env?: Env
  /** Defaults to the real check; tests pass a value. */
  desktopApp?: boolean
}

/**
 * The function that switches from the `current` screen to the other one, or undefined when there is nowhere to switch to
 * (a self-hosted or embedded build with no sibling page). The desktop app switches in place; the hosted pages navigate.
 */
export function appSwitchHandler(current: AppId, options: AppSwitchOptions = {}): ((target: AppId) => void) | undefined {
  const { desktop, navigate = (url: string) => window.location.assign(url), env, desktopApp = isTauri() } = options
  if (desktopApp) return desktop ? (target) => { if (target !== current) desktop(target) } : undefined
  const other: AppId = current === 'chat' ? 'write' : 'chat'
  const url = webSwitchUrl(other, env)
  return url ? (target) => { if (target !== current) navigate(url) } : undefined
}
