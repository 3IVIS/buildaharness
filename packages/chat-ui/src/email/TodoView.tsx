import { TODO_GROUP_LABEL, type ScoredTodo, type TodoGroup } from '@buildaharness/aielia'
import { folderGroups, reasonFor, smartFolders, type SmartFolderId } from './todo-view'

interface ViewProps {
  items: readonly ScoredTodo[]
  folder?: SmartFolderId
  onOpenThread?: (threadId: string) => void
  /** A drag to another group, or the keyboard move; the caller records the correction. */
  onMove?: (item: ScoredTodo, group: TodoGroup) => void
  onNotUrgent?: (item: ScoredTodo) => void
}

/** The to-do list as the four groups; each item shows its reason, and can be dragged (or moved with the select) to another group. */
export function TodoView({ items, folder = 'smart:todo', onOpenThread, onMove, onNotUrgent }: ViewProps): React.JSX.Element {
  const groups = folderGroups(items, folder)
  return (
    <div className="email-todo">
      {groups.map((g) => (
        <section
          key={g.group} aria-label={g.label} data-group={g.group}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const dragged = items.find((i) => i.id === e.dataTransfer.getData('text/plain'))
            if (dragged) onMove?.(dragged, g.group)
          }}
        >
          <h3>{g.label} ({g.items.length})</h3>
          <ul>
            {g.items.map((i) => (
              <li key={i.id} draggable data-item={i.id} onDragStart={(e) => e.dataTransfer.setData('text/plain', i.id)}>
                <button type="button" className="email-todo__title" onClick={() => i.threadId && onOpenThread?.(i.threadId)}>{i.title}</button>
                <span className="email-todo__reason">{i.reason}</span>
                <select aria-label={`Move ${i.title}`} value={i.group} onChange={(e) => onMove?.(i, e.target.value as TodoGroup)}>
                  {(Object.keys(TODO_GROUP_LABEL) as TodoGroup[]).map((k) => <option key={k} value={k}>{TODO_GROUP_LABEL[k]}</option>)}
                </select>
                {i.group !== 'can_wait' && <button type="button" aria-label={`Not urgent: ${i.title}`} onClick={() => onNotUrgent?.(i)}>Not urgent</button>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** The smart folders for the folder tree. */
export function SmartFolders({ items, active, onSelect }: { items: readonly ScoredTodo[]; active?: SmartFolderId; onSelect: (id: SmartFolderId) => void }): React.JSX.Element {
  return (
    <ul aria-label="Smart folders">
      {smartFolders(items).map((f) => (
        <li key={f.id}>
          <button type="button" aria-current={active === f.id ? 'true' : undefined} onClick={() => onSelect(f.id)}>{f.name} ({f.count})</button>
        </li>
      ))}
    </ul>
  )
}

/** The strip above the reader saying why the open thread is on the list. Renders nothing when it is not. */
export function ReasonStrip({ items, threadId }: { items: readonly ScoredTodo[]; threadId?: string }): React.JSX.Element | null {
  const r = threadId ? reasonFor(items, threadId) : undefined
  if (!r) return null
  return <div className="email-reason" role="note" data-group={r.group}><strong>{TODO_GROUP_LABEL[r.group]}.</strong> {r.text}</div>
}
