import { groupTodo, recordCorrection, TODO_GROUPS, type ScoredTodo, type TodoCorrection, type TodoGroup } from '@buildaharness/aielia'

/** The smart folders shown in the folder tree (U6). They are views over the to-do list, not stored folders. */
export type SmartFolderId = 'smart:todo' | 'smart:needs-reply' | 'smart:waiting'
export interface SmartFolder { id: SmartFolderId; name: string; count: number; threadIds: string[] }

const open = (items: readonly ScoredTodo[]) => items.filter((i) => i.status === 'open')
const threads = (items: readonly ScoredTodo[]) => [...new Set(items.flatMap((i) => (i.threadId ? [i.threadId] : [])))]

/** To do (everything open), Needs reply and Waiting on others, each with the threads it holds. */
export function smartFolders(items: readonly ScoredTodo[]): SmartFolder[] {
  const o = open(items)
  const mk = (id: SmartFolderId, name: string, list: ScoredTodo[]): SmartFolder => ({ id, name, count: list.length, threadIds: threads(list) })
  return [
    mk('smart:todo', 'To do', o),
    mk('smart:needs-reply', 'Needs reply', o.filter((i) => i.kind === 'reply')),
    mk('smart:waiting', 'Waiting on others', o.filter((i) => i.kind === 'waiting')),
  ]
}

/** The four groups of A3 for the folder chosen; the reply and waiting folders keep the same four-group layout. */
export function folderGroups(items: readonly ScoredTodo[], folder: SmartFolderId) {
  const keep = folder === 'smart:todo' ? items : items.filter((i) => i.kind === (folder === 'smart:waiting' ? 'waiting' : 'reply'))
  return groupTodo(keep)
}

/** The reason strip text above the reader: why this thread is on the list, and where it sits. */
export function reasonFor(items: readonly ScoredTodo[], threadId: string): { group: TodoGroup; text: string } | undefined {
  const i = open(items).find((x) => x.threadId === threadId)
  return i ? { group: i.group, text: i.reason } : undefined
}

/** A drag to another group is a correction; dropping on its own group records nothing. */
export function dropCorrection(
  corrections: readonly TodoCorrection[], item: ScoredTodo, target: TodoGroup, at: string,
): TodoCorrection[] {
  if (!item.threadId || item.group === target || !TODO_GROUPS.includes(target)) return [...corrections]
  return recordCorrection(corrections, { threadId: item.threadId, kind: 'move', group: target, at })
}
