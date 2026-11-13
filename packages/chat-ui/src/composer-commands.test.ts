import { describe, it, expect } from 'vitest'
import { dispatchKeysFor, explainCommand } from '@buildaharness/aielia'
import { COMPOSER_COMMANDS } from './composer-commands'

describe('composer commands', () => {
  it('match the registry commands that include the apps', () => {
    expect([...COMPOSER_COMMANDS].sort()).toEqual(dispatchKeysFor('gui').sort())
  })

  it('each explain command is answered by explainCommand; /project and /undo-action have their own handlers', () => {
    for (const command of COMPOSER_COMMANDS.filter((c) => c !== '/project' && c !== '/undo-action' && c !== '/email')) expect(explainCommand(command, {})).toBeDefined()
    expect(explainCommand('/project', {})).toBeUndefined()
    expect(explainCommand('/undo-action', {})).toBeUndefined()
    expect(explainCommand('/email', {})).toBeUndefined()
  })
})
