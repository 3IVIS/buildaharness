import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TERMS_VERSION } from '@buildaharness/aielia'
import { TermsGate, TERMS_STORAGE_KEY } from './TermsGate'

describe('TermsGate', () => {
  beforeEach(() => localStorage.clear())

  it('blocks the app on desktop until Agree and continue is pressed, then remembers it', () => {
    render(<TermsGate desktop><p>the app</p></TermsGate>)
    expect(screen.queryByText('the app')).toBeNull()
    expect(screen.getByRole('link', { name: 'Terms of Use' }).getAttribute('href')).toContain('/terms.html')
    expect(screen.getByRole('link', { name: 'Privacy Policy' }).getAttribute('href')).toContain('/privacy.html')
    fireEvent.click(screen.getByRole('button', { name: 'Agree and continue' }))
    expect(screen.getByText('the app')).toBeTruthy()
    expect(localStorage.getItem(TERMS_STORAGE_KEY)).toBe(TERMS_VERSION)
  })

  it('does not ask again for an accepted version, but does for an older one', () => {
    localStorage.setItem(TERMS_STORAGE_KEY, TERMS_VERSION)
    const { unmount } = render(<TermsGate desktop><p>the app</p></TermsGate>)
    expect(screen.getByText('the app')).toBeTruthy()
    unmount()
    localStorage.setItem(TERMS_STORAGE_KEY, '2020-01-01')
    render(<TermsGate desktop><p>the app</p></TermsGate>)
    expect(screen.queryByText('the app')).toBeNull()
  })

  it('never gates a browser tab', () => {
    render(<TermsGate desktop={false}><p>the app</p></TermsGate>)
    expect(screen.getByText('the app')).toBeTruthy()
  })
})
