/** Registers the Email service worker (app shell only, never mail content). A no-op where service workers do not exist. */
export function registerEmailServiceWorker(nav: Pick<Navigator, 'serviceWorker'> | undefined = typeof navigator === 'undefined' ? undefined : navigator): Promise<unknown> | undefined {
  if (!nav || !('serviceWorker' in nav) || !nav.serviceWorker) return undefined
  return nav.serviceWorker.register('/email-sw.js', { scope: '/' }).catch(() => undefined)
}
