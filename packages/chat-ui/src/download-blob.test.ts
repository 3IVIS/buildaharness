import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadBlob } from './download-blob'

afterEach(() => { vi.useRealTimers() })

describe('downloadBlob', () => {
  it('clicks a download anchor and revokes the object URL only after a delay', () => {
    vi.useFakeTimers()
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    let name = ''
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { name = this.download })
    downloadBlob(new Blob(['hi']), 'a.md')
    expect(click).toHaveBeenCalledTimes(1)
    expect(name).toBe('a.md')
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x')
    expect(document.querySelector('a[download]')).toBeNull()
  })
})
