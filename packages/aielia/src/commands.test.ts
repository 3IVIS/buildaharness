import { describe, it, expect } from 'vitest'
import { COMMAND_REGISTRY, commandKey, dispatchKeysFor } from './commands.js'
import { CLI_COMMANDS_HELP } from './cli-session.js'
import { EXPLAIN_COMMANDS } from './run-explain.js'

describe('COMMAND_REGISTRY', () => {
  it('has a reason for every command that is not on both surfaces', () => {
    const missing = COMMAND_REGISTRY.filter((c) => c.surfaces !== 'both' && !c.reason?.trim()).map((c) => c.name)
    expect(missing).toEqual([])
  })

  it('has unique names and no alias that collides with another key', () => {
    const names = COMMAND_REGISTRY.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    const aliases = COMMAND_REGISTRY.flatMap((c) => c.aliases ?? [])
    const keys = new Set(COMMAND_REGISTRY.map((c) => commandKey(c.name)))
    expect(aliases.filter((a) => keys.has(a))).toEqual([])
  })

  it('projects /help from the registry entries that include the CLI', () => {
    expect(CLI_COMMANDS_HELP.map((c) => c.command)).toEqual(COMMAND_REGISTRY.filter((c) => c.surfaces !== 'gui-only').map((c) => c.usage))
  })

  it('lists the explain commands and /project as the commands the apps handle', () => {
    expect(dispatchKeysFor('gui').sort()).toEqual([...EXPLAIN_COMMANDS, '/project'].sort())
  })

  it('keeps the apps-export reason for /memory export', () => {
    expect(COMMAND_REGISTRY.find((c) => c.name === '/memory export')).toMatchObject({ surfaces: 'cli-only', reason: 'apps export from the Memory panel' })
  })
})
