import { EXPLAIN_COMMANDS } from '@buildaharness/aielia'

/**
 * The slash commands the composer answers itself instead of sending to the model (App.tsx's
 * showExplanation, handleProjectCommand and handleUndoActionCommand). composer-commands.test.ts checks this list against COMMAND_REGISTRY, so a command
 * added here needs a registry entry, and a registry command marked for the apps needs a handler here.
 */
export const COMPOSER_COMMANDS: readonly string[] = [...EXPLAIN_COMMANDS, '/project', '/undo-action']
