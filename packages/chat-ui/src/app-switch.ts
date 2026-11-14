import { isTauri } from '@tauri-apps/api/core'

/** The screens of Aielia: the chat, the article writer and the mail page. */
export type AppId = 'chat' | 'write' | 'email'

export const APP_LABEL: Record<AppId, string> = { chat: 'Chat', write: 'Write', email: 'Email' }

const ENV_KEY: Record<AppId, string> = { chat: 'VITE_APP_URL_CHAT', write: 'VITE_APP_URL_WRITE', email: 'VITE_APP_URL_EMAIL' }

type Env = Record<string, unknown>

/**
 * Where the other page lives when the app runs as hosted web pages (myaielia.com/chat and /write). The deploy workflows set
 * VITE_APP_URL_CHAT on the Write build and VITE_APP_URL_WRITE on the chat build. Only a path on the same site is accepted
 * ("/write/" or "/email/", not "//host" or a full URL), so a build setting cannot send people elsewhere. Unset for every other build.
 */
export function webSwitchUrl(target: AppId, env: Env = import.meta.env as Env): string | undefined {
  const raw = env[ENV_KEY[target]]
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
  const reachable = ALL_APPS.filter((a) => a !== current && webSwitchUrl(a, env))
  if (reachable.length === 0) return undefined
  return (target) => {
    const url = target !== current ? webSwitchUrl(target, env) : undefined
    if (url) navigate(url)
  }
}

const ALL_APPS: AppId[] = ['chat', 'write', 'email']

/** The screens the drop-down offers: on the desktop all of them; on hosted pages the open one and those whose address the build names. */
export function availableApps(current: AppId, options: { env?: Env; desktopApp?: boolean } = {}): AppId[] {
  const { env, desktopApp = isTauri() } = options
  return ALL_APPS.filter((a) => a === current || desktopApp || !!webSwitchUrl(a, env))
}
