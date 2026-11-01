import { PRIVACY_URL, TERMS_URL } from '@buildaharness/aielia'

/** True on the hosted builds, where web search and page fetches are routed through the 3IVIS proxy. */
export function usesHostedProxy(env: ImportMetaEnv = import.meta.env): boolean {
  return env.VITE_ASSISTANT_WEB_BACKEND === 'proxy'
}

/** One line on the hosted pages saying what the proxy logs. Renders nothing on builds that don't use it. */
/** `bare` drops the links and the page margin, for a screen that already carries its own Terms and Privacy line. */
export function ProxyNotice({ env, bare = false }: { env?: ImportMetaEnv; bare?: boolean }): React.JSX.Element | null {
  if (!usesHostedProxy(env)) return null
  return (
    <p className="proxy-notice" style={bare ? { margin: 0 } : undefined}>
      Searches and page fetches from this page pass through the 3IVIS proxy. It logs only the time, route, destination host, status and size; never your IP or what you searched.
      {!bare && (
        <>
          {' '}
          <a href={TERMS_URL} target="_blank" rel="noreferrer">Terms</a> · <a href={PRIVACY_URL} target="_blank" rel="noreferrer">Privacy</a>
        </>
      )}
    </p>
  )
}
