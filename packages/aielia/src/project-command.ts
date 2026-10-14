/**
 * `/project [name]` for every surface: no argument shows the active project, `clear` reverts to the workspace
 * default, anything else switches to that name. Pure: the surface persists the config change and shows the message.
 */
export type ProjectCommand =
  | { kind: 'show'; message: string }
  | { kind: 'set'; project: string; message: string }
  | { kind: 'clear'; message: string }

export function parseProjectCommand(args: readonly string[], currentProject: string | undefined): ProjectCommand {
  if (args.length === 0) return { kind: 'show', message: currentProject || '(none)' }
  if (args[0] === 'clear') return { kind: 'clear', message: 'Project reset to the workspace default.' }
  const project = args.join(' ')
  return { kind: 'set', project, message: `Active project: ${project}` }
}
