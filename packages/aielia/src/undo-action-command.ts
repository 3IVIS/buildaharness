/**
 * `/undo-action [id]` for every surface: no argument lists the revertible filesystem effects, an id stages a
 * revert of that one (which then goes through the ordinary approval card or prompt). Pure: the surface calls the
 * assistant and renders; this only decides which of the two was asked for.
 */
export type UndoActionCommand = { kind: 'list' } | { kind: 'stage'; id: string }

export function parseUndoActionCommand(args: readonly string[]): UndoActionCommand {
  return args.length === 0 ? { kind: 'list' } : { kind: 'stage', id: args[0] }
}
