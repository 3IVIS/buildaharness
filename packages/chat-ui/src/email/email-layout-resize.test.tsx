import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { EmailLayout } from './EmailLayout'

const KEY = 'aielia-email-layout'
const layout = (over: Partial<React.ComponentProps<typeof EmailLayout>> = {}) => (
  <EmailLayout mode="desktop" folders={<p>folders</p>} list={<p>list</p>} reader={<p>reader</p>} aielia={<p>chat</p>} {...over} />
)
const listEl = (): HTMLElement => document.querySelector('.email__list') as HTMLElement

beforeEach(() => { localStorage.clear(); Object.defineProperty(window, 'innerWidth', { value: 1700, configurable: true }) })
afterEach(() => { cleanup(); localStorage.clear() })

describe('resizable panes', () => {
  it('offers a handle between the list and the reader, and for the aielia column', () => {
    render(layout())
    expect(screen.getByRole('separator', { name: 'Message list width' })).toBeTruthy()
    expect(screen.getByRole('separator', { name: 'Aielia column width' })).toBeTruthy()
  })
  it('the folder column handle appears only when the folders are pinned open', () => {
    render(layout())
    expect(screen.queryByRole('separator', { name: 'Folder list width' })).toBeNull()
    fireEvent.mouseEnter(document.querySelector('.email__rail')!)
    fireEvent.click(screen.getByRole('button', { name: 'Pin folders open' }))
    expect(screen.getByRole('separator', { name: 'Folder list width' })).toBeTruthy()
  })
  it('the keyboard moves a handle, the size is remembered, and a double-click puts it back', () => {
    render(layout())
    const handle = screen.getByRole('separator', { name: 'Message list width' })
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(listEl().style.width).toMatch(/px$/)
    expect(JSON.parse(localStorage.getItem(KEY)!).list).toBeGreaterThan(0)
    fireEvent.doubleClick(handle)
    expect(listEl().style.width).toBe('')
    expect(JSON.parse(localStorage.getItem(KEY)!).list).toBeUndefined()
  })
  it('starts from the sizes saved last time, and ignores a garbled record', () => {
    localStorage.setItem(KEY, JSON.stringify({ list: 512, chat: 400, rail: 'wide' }))
    render(layout())
    expect(listEl().style.width).toBe('512px')
    expect((document.querySelector('.email__aielia') as HTMLElement).style.width).toBe('400px')
    cleanup()
    localStorage.setItem(KEY, '{not json')
    render(layout())
    expect(listEl().style.width).toBe('')
  })
  it('a phone has no handles: the panes are not side by side there', () => {
    render(layout({ mode: 'phone' }))
    expect(screen.queryAllByRole('separator')).toHaveLength(0)
  })
  it('a narrow window puts the reader below the list, and then the handle changes the list height', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
    render(layout({ readerOpen: true }))
    const handle = screen.getByRole('separator', { name: 'Message list height' })
    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(listEl().style.height).toMatch(/px$/)
  })
})
