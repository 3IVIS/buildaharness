import { useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { DESKTOP_TERMS_BODY, PRIVACY_URL, TERMS_URL, TERMS_VERSION } from '@buildaharness/aielia'

export const TERMS_STORAGE_KEY = 'aielia.termsAccepted'

function readAccepted(): boolean {
  try {
    return localStorage.getItem(TERMS_STORAGE_KEY) === TERMS_VERSION
  } catch {
    return false
  }
}

interface Props {
  children: React.ReactNode
  /** Test seam: defaults to "running inside the desktop app". The hosted pages are not gated; they show a notice instead. */
  desktop?: boolean
}

/**
 * First-launch dialog for the desktop app. Nothing renders behind it until "Agree and continue" is pressed;
 * the accepted terms version is remembered, so a new TERMS_VERSION asks once more. Not shown in a browser tab.
 */
export function TermsGate({ children, desktop = isTauri() }: Props): React.JSX.Element {
  const [accepted, setAccepted] = useState(() => !desktop || readAccepted())
  if (accepted) return <>{children}</>

  function accept(): void {
    try {
      localStorage.setItem(TERMS_STORAGE_KEY, TERMS_VERSION)
    } catch {
      // Storage unavailable: the dialog just returns on the next launch.
    }
    setAccepted(true)
  }

  return (
    <div className="terms-gate" role="dialog" aria-modal="true" aria-labelledby="terms-gate-title">
      <div className="terms-gate__card">
        <h1 id="terms-gate-title">Welcome to Aielia</h1>
        <p>{DESKTOP_TERMS_BODY}</p>
        <p className="terms-gate__links">
          <a href={TERMS_URL} target="_blank" rel="noreferrer">Terms of Use</a> ·{' '}
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer">Privacy Policy</a>
        </p>
        <button type="button" className="terms-gate__button" onClick={accept}>Agree and continue</button>
        <p className="terms-gate__small">You can reread these any time at myaielia.com.</p>
      </div>
    </div>
  )
}
