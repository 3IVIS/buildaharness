import { describe, it, expect, vi } from 'vitest'
import { appSwitchHandler, webSwitchUrl } from './app-switch'

describe('webSwitchUrl', () => {
  it('reads the other page from the build settings', () => {
    expect(webSwitchUrl('write', { VITE_APP_URL_WRITE: '/write/' })).toBe('/write/')
    expect(webSwitchUrl('chat', { VITE_APP_URL_CHAT: '/try/' })).toBe('/try/')
  })
  it('is undefined when the build sets nothing', () => {
    expect(webSwitchUrl('write', {})).toBeUndefined()
    expect(webSwitchUrl('chat', { VITE_APP_URL_WRITE: '/write/' })).toBeUndefined()
  })
  it('accepts a full https URL on the Aielia sites only (the Email subdomain reaches Chat and Write that way)', () => {
    expect(webSwitchUrl('chat', { VITE_APP_URL_CHAT: 'https://myaielia.com/chat/' })).toBe('https://myaielia.com/chat/')
    expect(webSwitchUrl('write', { VITE_APP_URL_WRITE: 'https://email.myaielia.com/' })).toBe('https://email.myaielia.com/')
    for (const bad of ['http://myaielia.com/chat/', 'https://myaielia.com.evil.example/chat/', 'https://evil.example/myaielia.com/', 'https://myaielia.com@evil.example/', 'https://myaielia.com//evil.example/', 'https://myaielia.com']) {
      expect(webSwitchUrl('chat', { VITE_APP_URL_CHAT: bad })).toBeUndefined()
    }
  })
  it('only accepts a path on the same site', () => {
    for (const bad of ['https://evil.example/', '//evil.example/', 'write/', 'javascript:alert(1)', '/a b', '']) {
      expect(webSwitchUrl('write', { VITE_APP_URL_WRITE: bad })).toBeUndefined()
    }
  })
})

describe('appSwitchHandler', () => {
  it('on the desktop switches in place, and only to the other screen', () => {
    const desktop = vi.fn()
    const go = appSwitchHandler('chat', { desktopApp: true, desktop })!
    go('chat')
    expect(desktop).not.toHaveBeenCalled()
    go('write')
    expect(desktop).toHaveBeenCalledWith('write')
  })
  it('on the desktop has nothing to offer without a desktop handler', () => {
    expect(appSwitchHandler('chat', { desktopApp: true })).toBeUndefined()
  })
  it('on the hosted pages goes to the other page', () => {
    const navigate = vi.fn()
    const fromChat = appSwitchHandler('chat', { desktopApp: false, navigate, env: { VITE_APP_URL_WRITE: '/write/' } })!
    fromChat('write')
    expect(navigate).toHaveBeenCalledWith('/write/')
    const fromWrite = appSwitchHandler('write', { desktopApp: false, navigate, env: { VITE_APP_URL_CHAT: '/try/' } })!
    fromWrite('chat')
    expect(navigate).toHaveBeenLastCalledWith('/try/')
  })
  it('does not navigate to the screen that is already open', () => {
    const navigate = vi.fn()
    appSwitchHandler('chat', { desktopApp: false, navigate, env: { VITE_APP_URL_WRITE: '/write/' } })!('chat')
    expect(navigate).not.toHaveBeenCalled()
  })
  it('is undefined for a build with no other page (self-hosted)', () => {
    expect(appSwitchHandler('chat', { desktopApp: false, env: {} })).toBeUndefined()
    expect(appSwitchHandler('write', { desktopApp: false, env: {} })).toBeUndefined()
  })
})
