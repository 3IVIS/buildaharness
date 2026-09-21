import { describe, it, expect } from 'vitest'
import { parseCliArgs, cliHelpText } from './cli-args.js'

describe('parseCliArgs', () => {
  it('defaults to the REPL with no args', () => {
    expect(parseCliArgs([])).toEqual({ command: 'repl' })
  })

  it('ignores unrecognized args, preserving today\'s behavior', () => {
    expect(parseCliArgs(['hello', '--whatever'])).toEqual({ command: 'repl' })
  })

  it.each([['--version'], ['-v'], ['version']])('recognizes %s as version', (arg) => {
    expect(parseCliArgs([arg])).toEqual({ command: 'version' })
  })

  it.each([['--help'], ['-h'], ['help']])('recognizes %s as help', (arg) => {
    expect(parseCliArgs([arg])).toEqual({ command: 'help' })
  })

  it('parses update, with and without --dry-run', () => {
    expect(parseCliArgs(['update'])).toEqual({ command: 'update', dryRun: false })
    expect(parseCliArgs(['update', '--dry-run'])).toEqual({ command: 'update', dryRun: true })
  })

  it('does not treat --dry-run alone as update', () => {
    expect(parseCliArgs(['--dry-run'])).toEqual({ command: 'repl' })
  })
})

describe('cliHelpText', () => {
  it('includes the version and the site', () => {
    const text = cliHelpText('1.2.3')
    expect(text).toContain('1.2.3')
    expect(text).toContain('https://myaielia.com')
  })
})
