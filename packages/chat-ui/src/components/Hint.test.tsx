import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Hint } from './Hint'

describe('Hint', () => {
  it('shows its text on hover and hides it on leave', async () => {
    const user = userEvent.setup()
    render(<Hint text="Explains this." />)
    const h = screen.getByRole('img', { name: 'Explains this.' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    await user.hover(h)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Explains this.')
    await user.unhover(h)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
  it('shows on keyboard focus and hides on Escape', async () => {
    const user = userEvent.setup()
    render(<Hint text="Explains this." />)
    await user.tab()
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
  it('does not tick the checkbox of the label it sits in when clicked', async () => {
    const user = userEvent.setup()
    render(<label><input type="checkbox" /> Option <Hint text="Explains this." /></label>)
    await user.click(screen.getByRole('img', { name: 'Explains this.' }))
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })
})
