import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { createSampleMailbox } from './sample-mode'
import { SampleMailboxView } from './SampleMailboxView'

afterEach(() => { cleanup() })

describe('search in the sample view', () => {
  it('offers the server only for a typed query, and adds server hits that the Inbox does not hold', async () => {
    const sample = await createSampleMailbox()
    const sent = (await sample.provider.search({ text: 'Invoice details' })).items.find((m) => m.folderIds.includes('fld-sent'))!
    expect(sample.inbox.some((m) => m.id === sent.id)).toBe(false)
    render(<SampleMailboxView sample={sample} onConnect={() => undefined} />)
    expect(screen.queryByRole('button', { name: /on the server too/ })).toBeNull()
    fireEvent.change(screen.getByLabelText('Search mail'), { target: { value: 'Invoice details' } })
    fireEvent.click(screen.getByRole('button', { name: /on the server too/ }))
    await waitFor(() => expect(screen.getByText(/from the server\)/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /on the server too/ })).toBeNull()
  })
})
