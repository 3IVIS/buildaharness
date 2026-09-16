import { describe, it, expect, afterEach } from 'vitest'
import { startCapture, type CaptureEvent } from './tui-output-capture.js'

// Every sequence below is copied verbatim from reading cli.ts's writeProgress/clearProgress
// (lines ~782-802), writeToolStep (~808-812), and writeToken (~1004-1010) — not guessed — plus
// a couple of representative plain console.log/console.error calls from the same file.

let restore: (() => void) | undefined

afterEach(() => {
  restore?.()
  restore = undefined
})

function capture(run: () => void): CaptureEvent[] {
  const events: CaptureEvent[] = []
  restore = startCapture((event) => events.push(event))
  run()
  return events
}

describe('startCapture', () => {
  it('classifies writeProgress\'s \\r-prefixed line as a progress event', () => {
    // writeProgress with lastProgressLineLength === 0 (first call, no padEnd filler yet).
    const events = capture(() => {
      process.stdout.write('\r[step 1/5] Gathering evidence…')
    })
    expect(events).toEqual([{ type: 'progress', text: '[step 1/5] Gathering evidence…' }])
  })

  it('strips padEnd filler from a shorter progress line following a longer one', () => {
    // writeProgress pads the new line to the previous line's length so it fully overwrites it
    // on a real terminal — Ink re-renders the whole frame, so that filler is not real content.
    const events = capture(() => {
      process.stdout.write(`\r${'foo'.padEnd(30)}`)
    })
    expect(events).toEqual([{ type: 'progress', text: 'foo' }])
  })

  it('classifies clearProgress\'s \\r-spaces-\\r as an empty progress event', () => {
    const events = capture(() => {
      process.stdout.write(`\r${' '.repeat(20)}\r`)
    })
    expect(events).toEqual([{ type: 'progress', text: '' }])
  })

  it('classifies writeToolStep\'s console.log line as a committed line event', () => {
    const events = capture(() => {
      console.log('  ⚙ Listing .')
    })
    expect(events).toEqual([{ type: 'line', lines: ['  ⚙ Listing .'] }])
  })

  it('classifies writeToken\'s opening "\\nAielia> " write as a token event', () => {
    const events = capture(() => {
      process.stdout.write('\nAielia> ')
    })
    expect(events).toEqual([{ type: 'token', text: '\nAielia> ' }])
  })

  it('classifies writeToken\'s subsequent raw-token writes as token events, even with an embedded newline', () => {
    const events = capture(() => {
      process.stdout.write('Hello')
      process.stdout.write(' there')
      process.stdout.write('foo\nbar')
    })
    expect(events).toEqual([
      { type: 'token', text: 'Hello' },
      { type: 'token', text: ' there' },
      { type: 'token', text: 'foo\nbar' },
    ])
  })

  it('splits a multi-line console.log call (leading/trailing blank-line spacing) into separate committed lines', () => {
    const events = capture(() => {
      console.log('\nAielia> Hello there\n')
    })
    expect(events).toEqual([{ type: 'line', lines: ['', 'Aielia> Hello there', ''] }])
  })

  it('classifies console.error the same as console.log — a committed line', () => {
    const events = capture(() => {
      console.error('boom')
    })
    expect(events).toEqual([{ type: 'line', lines: ['boom'] }])
  })

  it('classifies the post-streaming tail write (trailing \\n\\n, no leading \\n) as a committed line plus one blank line', () => {
    const events = capture(() => {
      process.stdout.write(' (2 sources — /sources)\n\n')
    })
    expect(events).toEqual([{ type: 'line', lines: [' (2 sources — /sources)', ''] }])
  })

  it('reproduces a full turn sequence: progress, then a tool step clearing it, then streamed tokens, then the final line', () => {
    const events = capture(() => {
      process.stdout.write('\r[step 1/5] Gathering evidence…') // writeProgress
      process.stdout.write(`\r${' '.repeat(31)}\r`) // clearProgress, called from writeToolStep
      console.log('  ⚙ Listing .') // writeToolStep's own line
      process.stdout.write('\nAielia> ') // writeToken, first call
      process.stdout.write('Hi') // writeToken, subsequent call
      process.stdout.write(' there!\n\n') // the post-streaming tail write
    })
    expect(events).toEqual([
      { type: 'progress', text: '[step 1/5] Gathering evidence…' },
      { type: 'progress', text: '' },
      { type: 'line', lines: ['  ⚙ Listing .'] },
      { type: 'token', text: '\nAielia> ' },
      { type: 'token', text: 'Hi' },
      { type: 'line', lines: [' there!', ''] },
    ])
  })

  it('restores the original console.log/console.error/process.stdout.write on the returned restore function', () => {
    const originalLog = console.log
    const originalError = console.error
    const originalWrite = process.stdout.write
    const stop = startCapture(() => {})
    expect(console.log).not.toBe(originalLog)
    expect(console.error).not.toBe(originalError)
    expect(process.stdout.write).not.toBe(originalWrite)
    stop()
    expect(console.log).toBe(originalLog)
    expect(console.error).toBe(originalError)
    expect(process.stdout.write).toBe(originalWrite)
  })
})
