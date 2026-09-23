import type { GoalGraphState, GoalThreadView, GoalThreadVisibility } from '@buildaharness/aielia'

interface Props {
  /** Bound to assistant.getGoalGraphState(sessionId) — see App.tsx's handleOpenGoals. `null` means "still loading", distinct from an empty (but loaded) graph. */
  state: GoalGraphState | null
  onCancel: () => void
}

const VISIBILITY_LABEL: Record<GoalThreadVisibility, string> = {
  suggested_not_committed: 'Suggested, not committed',
  done: 'Done',
  freshly_computed: 'Freshly computed',
  carried_over: 'Carried over',
}

function TaskSummary({ tasks }: { tasks: GoalThreadView['tasks'] }): React.JSX.Element {
  if (tasks.total === 0) return <span className="goals-panel__tasks">No tasks yet</span>
  return (
    <span className="goals-panel__tasks">
      {tasks.complete}/{tasks.total} complete
      {tasks.failed > 0 ? `, ${tasks.failed} failed` : ''}
      {tasks.pending > 0 ? `, ${tasks.pending} pending` : ''}
    </span>
  )
}

function ThreadRow({ thread }: { thread: GoalThreadView }): React.JSX.Element {
  return (
    <li className="goals-panel__thread">
      <div className="goals-panel__thread-header">
        <span className="goals-panel__status" data-status={thread.status}>{thread.status}</span>
        {thread.isActive && <span className="goals-panel__active-badge">ACTIVE</span>}
        <span className="goals-panel__visibility" data-visibility={thread.visibility}>{VISIBILITY_LABEL[thread.visibility]}</span>
      </div>
      <div className="goals-panel__success-criteria">{thread.successCriteria}</div>
      <div className="goals-panel__thread-footer">
        <TaskSummary tasks={thread.tasks} />
        {thread.relationToSiblings && (
          <span className="goals-panel__siblings">
            {thread.relationToSiblings} sibling{thread.siblingIds && thread.siblingIds.length > 1 ? 's' : ''}
          </span>
        )}
        <span className="goals-panel__updated-at">updated {thread.updatedAt}</span>
      </div>
    </li>
  )
}

/**
 * R5's review surface (see plans/hierarchical_goal_tree_and_steering_plan.html Phase 7) — the GUI
 * equivalent of the CLI's `/goals`, both reading through the same `getGoalGraphState()` query
 * layer (goal-graph-service.ts) so the two surfaces never drift into two descriptions of the same
 * facts. Modeled on SettingsScreen's full-screen-swap header/body layout (like Diagnostics, this
 * queries the whole session's goal graph rather than one message), reusing SearchPanel's
 * back-button header pattern rather than the per-bubble "Sources" toggle.
 */
export function GoalsPanel({ state, onCancel }: Props): React.JSX.Element {
  return (
    <div className="goals-panel">
      <div className="goals-panel__header">
        <button type="button" className="goals-panel__back" onClick={onCancel}>← Back</button>
        <div className="goals-panel__title">Goals</div>
      </div>

      <div className="goals-panel__body">
        {state === null && <div className="goals-panel__empty">Loading…</div>}
        {state !== null && state.threads.length === 0 && (
          <div className="goals-panel__empty">No goal threads yet.</div>
        )}
        {state !== null && state.threads.length > 0 && (
          <ul className="goals-panel__threads">
            {state.threads.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
