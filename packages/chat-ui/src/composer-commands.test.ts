import { describe, it, expect } from 'vitest'
import { dispatchKeysFor, explainCommand } from '@buildaharness/aielia'
import { COMPOSER_COMMANDS } from './composer-commands'

describe('composer commands', () => {
  it('match the registry commands that include the apps', () => {
    expect([...COMPOSER_COMMANDS].sort()).toEqual(dispatchKeysFor('gui').sort())
  })

  it('each explain command is answered by explainCommand; /project has its own handler', () => {
    for (const command of COMPOSER_COMMANDS.filter((c) => c !== '/project')) expect(explainCommand(command, {})).toBeDefined()
    expect(explainCommand('/project', {})).toBeUndefined()
  })
})
