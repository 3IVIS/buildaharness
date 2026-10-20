import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DialogProvider, useDialogs } from './dialogs'
import { answerDialog, declineDialog } from './dialog-test-utils'

function Probe({ onResult }: { onResult: (v: unknown) => void }): React.JSX.Element {
  const d = useDialogs()
  return (
    <>
      <button type="button" onClick={() => void d.ask('Name?', { initial: 'Ann' }).then(onResult)}>ask</button>
      <button type="button" onClick={() => void d.confirm('Sure?').then(onResult)}>confirm</button>
    </>
  )
}

describe('questions put to the writer', () => {
  it('ask returns the typed text, starts from the given one, and returns undefined when cancelled', async () => {
    const results: unknown[] = []
    render(<DialogProvider><Probe onResult={(v) => results.push(v)} /></DialogProvider>)
    await userEvent.click(screen.getByRole('button', { name: 'ask' }))
    expect(screen.getByLabelText('Your answer')).toHaveValue('Ann')
    await answerDialog('Bo')
    await userEvent.click(screen.getByRole('button', { name: 'ask' }))
    await declineDialog()
    await userEvent.click(screen.getByRole('button', { name: 'ask' }))
    await userEvent.keyboard('{Escape}')
    expect(results).toEqual(['Bo', undefined, undefined])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('confirm is true only when the writer agrees', async () => {
    const results: unknown[] = []
    render(<DialogProvider><Probe onResult={(v) => results.push(v)} /></DialogProvider>)
    await userEvent.click(screen.getByRole('button', { name: 'confirm' }))
    await declineDialog()
    await userEvent.click(screen.getByRole('button', { name: 'confirm' }))
    await answerDialog()
    expect(results).toEqual([false, true])
  })
  it('does not work without a provider, rather than falling back to the browser dialogs', () => {
    expect(() => render(<Probe onResult={() => undefined} />)).toThrow(/DialogProvider/)
  })
})

describe('the Write page and the browser dialogs', () => {
  // A desktop webview answers prompt with null and confirm with a Promise (which is truthy), so a question would go unasked or be answered
  // "yes" for the writer. Nothing under src/write may call them.
  it('no source file calls window.prompt, window.confirm or window.alert', () => {
    const dir = __dirname
    const offenders = readdirSync(dir)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => /\b(window|globalThis)\.(prompt|confirm|alert)\(/.test(readFileSync(join(dir, f), 'utf8')))
    expect(offenders).toEqual([])
  })
})
