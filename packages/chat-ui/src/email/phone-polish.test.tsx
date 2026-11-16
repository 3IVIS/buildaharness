// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { resolve } from 'node:path'
import { PhoneSheet, SwipeRow, PhoneTodoFlow, FloatingAielia, ConfirmBar } from './PhoneParts'
import { settleSheet, swipeOutcome, applySwipe, undoSwipe, emptySwipeLog, startTodoFlow, stepTodoFlow } from './phone-gestures'
import { registerEmailServiceWorker } from './register-sw'

afterEach(() => { cleanup() })

/** Loads public/email-sw.js into a sandbox with a fake cache and returns what a fetch event does. */
function loadWorker(origin = 'https://app.example') {
  const store = new Map<string, unknown>()
  const handlers: Record<string, (e: any) => void> = {}
  const caches = {
    open: async () => ({ addAll: async (urls: string[]) => { for (const u of urls) store.set(u, 'shell') }, put: async (r: { url: string }) => { store.set(new URL(r.url).pathname, 'put') } }),
    match: async (r: { url: string }) => store.get(new URL(r.url).pathname),
    keys: async () => [], delete: async () => true,
  }
  const fetched: string[] = []
  const fetchFn = async (r: { url: string }) => { fetched.push(r.url); return { ok: true, clone() { return this }, url: r.url } }
  const self = { location: { origin }, addEventListener: (t: string, h: (e: any) => void) => { handlers[t] = h } }
  vm.runInNewContext(readFileSync(resolve(__dirname, '../../public/email-sw.js'), 'utf8'), { self, caches, fetch: fetchFn, URL, Promise })
  async function request(url: string, method = 'GET') {
    let responded: Promise<unknown> | undefined
    handlers.fetch({ request: { url, method }, respondWith: (p: Promise<unknown>) => { responded = p } })
    if (responded) await responded
    await new Promise((r) => setTimeout(r, 0))
    return { handled: !!responded }
  }
  return { store, request, handlers, fetched }
}

describe('service worker', () => {
  it('precaches the shell only', async () => {
    const w = loadWorker()
    await new Promise<void>((res) => { w.handlers.install({ waitUntil: (p: Promise<unknown>) => p.then(() => res()) }) })
    expect([...w.store.keys()].sort()).toEqual(['/email', '/email.webmanifest', '/favicon.svg'])
  })

  it('caches a build asset but no mail response', async () => {
    const w = loadWorker()
    expect((await w.request('https://app.example/assets/index-abc.js')).handled).toBe(true)
    expect(w.store.has('/assets/index-abc.js')).toBe(true)
    for (const url of [
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/1',
      'https://graph.microsoft.com/v1.0/me/messages',
      'https://app.example/api/mail/messages/1',
      'https://app.example/assets/other-1.js?x=1',
      'https://app.example/mail/thread/9',
    ]) {
      expect((await w.request(url)).handled).toBe(false)
      expect(w.store.has(new URL(url).pathname)).toBe(false)
    }
    expect((await w.request('https://app.example/assets/x.js', 'POST')).handled).toBe(false)
    expect([...w.store.keys()].some((k) => /message|mail|api/.test(k))).toBe(false)
  })

  it('negative control: a worker that cached everything would fail the check', async () => {
    const w = loadWorker()
    const leaky = (url: string) => { w.store.set(new URL(url).pathname, 'put') }
    leaky('https://app.example/api/mail/messages/1')
    expect([...w.store.keys()].some((k) => /message|mail|api/.test(k))).toBe(true)
  })

  it('registers only where service workers exist', async () => {
    expect(registerEmailServiceWorker(undefined)).toBeUndefined()
    const register = vi.fn().mockResolvedValue({})
    await registerEmailServiceWorker({ serviceWorker: { register } } as never)
    expect(register).toHaveBeenCalledWith('/email-sw.js', { scope: '/' })
  })

  it('the manifest is installable', () => {
    const m = JSON.parse(readFileSync(resolve(__dirname, '../../public/email.webmanifest'), 'utf8'))
    expect(m.display).toBe('standalone'); expect(m.start_url).toBe('/email'); expect(m.icons.length).toBeGreaterThan(0)
  })
})

describe('sheet', () => {
  it('settles by position and velocity', () => {
    expect(settleSheet(0.1)).toBe('closed'); expect(settleSheet(0.5)).toBe('half'); expect(settleSheet(0.9)).toBe('full')
    expect(settleSheet(0.5, 1)).toBe('full'); expect(settleSheet(0.5, -1)).toBe('closed')
  })
  it('a drag up on the handle changes the state; the fab opens it', () => {
    const onState = vi.fn()
    const { rerender } = render(<><FloatingAielia onOpen={() => onState('half')} /><PhoneSheet state="closed" onState={onState}>chat</PhoneSheet></>)
    fireEvent.click(screen.getByLabelText('Ask Aielia'))
    expect(onState).toHaveBeenCalledWith('half')
    rerender(<PhoneSheet state="half" onState={onState}>chat</PhoneSheet>)
    const h = screen.getByLabelText('Drag to resize the chat')
    fireEvent.pointerDown(h, { clientY: 500 }); fireEvent.pointerUp(h, { clientY: 0 })
    expect(onState).toHaveBeenLastCalledWith('full')
  })
})

describe('swipe', () => {
  it('thresholds', () => { expect(swipeOutcome(100)).toBe('archive'); expect(swipeOutcome(-100)).toBe('later'); expect(swipeOutcome(30)).toBeNull() })
  it('a long swipe acts, a short one does not; undo reverses the last', () => {
    const onAction = vi.fn()
    render(<SwipeRow onAction={onAction}><span>row</span></SwipeRow>)
    const row = screen.getByText('row').parentElement!
    fireEvent.pointerDown(row, { clientX: 200 }); fireEvent.pointerUp(row, { clientX: 230 })
    expect(onAction).not.toHaveBeenCalled()
    fireEvent.pointerDown(row, { clientX: 200 }); fireEvent.pointerUp(row, { clientX: 320 })
    expect(onAction).toHaveBeenCalledWith('archive')
    let log = applySwipe(emptySwipeLog(), { messageId: 'm1', action: 'archive' })
    const r = undoSwipe(log); log = r.log
    expect(r.undone?.messageId).toBe('m1'); expect(log.done).toHaveLength(0)
    expect(undoSwipe(log).undone).toBeUndefined()
  })
  it('the confirm bar offers undo', () => {
    const onUndo = vi.fn(); render(<ConfirmBar text="Archived" onUndo={onUndo} />)
    fireEvent.click(screen.getByText('Undo')); expect(onUndo).toHaveBeenCalled()
  })
})

describe('To do flow', () => {
  it('approve, edit then skip, in order', () => {
    let f = startTodoFlow([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }])
    const Harness = () => <PhoneTodoFlow flow={f} onStep={(s) => { f = stepTodoFlow(f, s) }} />
    const { rerender } = render(<Harness />)
    fireEvent.click(screen.getByText('Edit')); rerender(<Harness />)
    expect(f.editing).toBe('a')
    expect(stepTodoFlow(f, 'approve')).toBe(f) // cannot approve while editing
    fireEvent.click(screen.getByText('Done editing')); rerender(<Harness />)
    fireEvent.click(screen.getByText('Approve')); rerender(<Harness />)
    fireEvent.click(screen.getByText('Skip')); rerender(<Harness />)
    expect(f.approved).toEqual(['a']); expect(f.skipped).toEqual(['b'])
    expect(screen.getByText('Nothing left to review.')).toBeTruthy()
  })
})
