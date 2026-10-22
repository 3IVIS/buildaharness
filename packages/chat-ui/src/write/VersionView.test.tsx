import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { VersionView } from './VersionView'

describe('VersionView', () => {
  it('says so when the version has no text, instead of showing an empty box', () => {
    render(<VersionView viewing={{ mode: 'view', index: 0, markdown: '  \n' }} statusLabel={{}} onRestore={() => undefined} />)
    expect(screen.getByText(/That version has no text/)).toBeInTheDocument()
  })
})
