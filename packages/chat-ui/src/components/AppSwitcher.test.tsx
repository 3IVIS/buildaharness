import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppSwitcher } from './AppSwitcher'

afterEach(cleanup)

describe('AppSwitcher', () => {
  it('shows the open screen and keeps the list closed', () => {
    render(<AppSwitcher current="chat" onSelect={() => undefined} />)
    const button = screen.getByRole('button', { name: /^Chat/ })
    expect(button).toHaveAttribute('aria-haspopup', 'menu')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('lists both screens with the open one marked', async () => {
    render(<AppSwitcher current="write" onSelect={() => undefined} />)
    await userEvent.click(screen.getByRole('button', { name: /^Write/ }))
    expect(screen.getByRole('menu', { name: 'Switch app' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /Aielia Chat/ })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('menuitemradio', { name: /Aielia Write/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('switches to the other screen and closes', async () => {
    const onSelect = vi.fn()
    render(<AppSwitcher current="chat" onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: /^Chat/ }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Aielia Write/ }))
    expect(onSelect).toHaveBeenCalledWith('write')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('does nothing when the open screen is picked again', async () => {
    const onSelect = vi.fn()
    render(<AppSwitcher current="chat" onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: /^Chat/ }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Aielia Chat/ }))
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens on the current item, moves with the arrow keys, and closes on Escape with focus back on the button', async () => {
    render(<AppSwitcher current="chat" onSelect={() => undefined} />)
    const button = screen.getByRole('button', { name: /^Chat/ })
    await userEvent.click(button)
    expect(screen.getByRole('menuitemradio', { name: /Aielia Chat/ })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitemradio', { name: /Aielia Write/ })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitemradio', { name: /Aielia Chat/ })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(button).toHaveFocus()
  })

  it('closes when the page is clicked elsewhere', async () => {
    render(<div><span>elsewhere</span><AppSwitcher current="chat" onSelect={() => undefined} /></div>)
    await userEvent.click(screen.getByRole('button', { name: /^Chat/ }))
    await userEvent.click(screen.getByText('elsewhere'))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('cannot be opened while disabled (a turn or a command is running)', async () => {
    render(<AppSwitcher current="chat" onSelect={() => undefined} disabled />)
    expect(screen.getByRole('button', { name: /^Chat/ })).toBeDisabled()
  })
})
