import { describe, it, expect } from 'vitest'
import { dispatchKeysFor, explainCommand } from '@buildaharness/aielia'
import { COMPOSER_COMMANDS } from './composer-commands'

describe('composer commands', () => {
  it('match the registry commands that include the apps', () => {
    expect([...COMPOSER_COMMANDS].sort()).toEqual(dispatchKeysFor('gui').sort())
  })

  it('each one is answered by explainCommand', () => {
    for (const command of COMPOSER_COMMANDS) expect(explainCommand(command, {})).toBeDefined()
  })
})
