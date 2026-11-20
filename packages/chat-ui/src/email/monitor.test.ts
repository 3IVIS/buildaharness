// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { describeScreen, monitorLog, startEmailMonitor } from './monitor'
import type { Invoke } from './desktop-platform'

const lines: Array<Record<string, unknown>> = []
const invokeWith = (enabled: boolean): Invoke => (async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === 'email_monitor_enabled') return enabled
  if (cmd === 'email_monitor_log') { lines.push(JSON.parse(String(args?.line))); return undefined }
  throw new Error(`unexpected ${cmd}`)
}) as Invoke
afterEach(() => { lines.length = 0; document.body.replaceChildren() })

describe('the Email monitor', () => {
  it('is off unless the app says so: nothing is listened to or recorded', async () => {
    const stop = await startEmailMonitor(invokeWith(false))
    expect(stop).toBeUndefined()
    monitorLog('x', { a: 1 })
    document.body.innerHTML = '<button>Go</button>'
    document.querySelector('button')!.click()
    await new Promise((r) => setTimeout(r, 20))
    expect(lines).toEqual([])
  })
  it('an unavailable monitor command also means off (a browser tab, an old app)', async () => {
    const bad = (async () => { throw new Error('no such command') }) as unknown as Invoke
    expect(await startEmailMonitor(bad)).toBeUndefined()
  })
  it('records clicks by name, typed fields, host events and errors, then stops cleanly', async () => {
    document.body.innerHTML = '<h2>Use the mail</h2><div role="alert">Needs permission</div><input aria-label="Search mail"><button>Check again</button><button disabled>Move</button>'
    const stop = (await startEmailMonitor(invokeWith(true)))!
    expect(stop).toBeTypeOf('function')
    document.querySelector('button')!.click()
    const input = document.querySelector('input')!
    input.value = 'tax advisor'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    monitorLog('local_discover', { available: false, reason: 'permission_denied' })
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom' }))
    await vi.waitFor(() => expect(lines.some((l) => l.kind === 'screen')).toBe(true), { timeout: 2000 })
    const kinds = lines.map((l) => l.kind)
    expect(kinds).toEqual(expect.arrayContaining(['monitor_started', 'click', 'input', 'local_discover', 'error', 'screen']))
    expect(lines.find((l) => l.kind === 'click')).toMatchObject({ name: 'Check again' })
    expect(lines.find((l) => l.kind === 'input')).toMatchObject({ field: 'Search mail', value: 'tax advisor' })
    const screen = lines.filter((l) => l.kind === 'screen').pop()!
    expect(screen.notices).toEqual(['Needs permission'])
    expect(screen.disabled).toEqual(['Move'])
    stop()
    const n = lines.length
    document.querySelector('button')!.click()
    await new Promise((r) => setTimeout(r, 20))
    expect(lines.length).toBe(n)
  })
  it('never records a password field', async () => {
    document.body.innerHTML = '<input type="password" aria-label="Password">'
    const stop = (await startEmailMonitor(invokeWith(true)))!
    const i = document.querySelector('input')!
    i.value = 'secret'
    i.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(lines.some((l) => l.kind === 'input')).toBe(true))
    expect(JSON.stringify(lines)).not.toContain('secret')
    stop()
  })
  it('describeScreen reports headings, notices and which buttons are disabled', () => {
    document.body.innerHTML = '<h1>Email</h1><p role="status">Reading your mail…</p><button aria-label="Open">x</button><button disabled>Send</button>'
    expect(describeScreen(document)).toEqual({ headings: ['Email'], notices: ['Reading your mail…'], buttons: ['Open', 'Send'], disabled: ['Send'] })
  })
})
