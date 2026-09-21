import { useState } from 'react'
import type { AssistantTurnResult, PlanApprovalEdits } from '@buildaharness/aielia'

type PlanApprovalSnapshot = NonNullable<AssistantTurnResult['planApproval']>

interface Props {
  planApproval: PlanApprovalSnapshot
  resolution?: 'approved' | 'approved_trusted' | 'approved_with_edits' | 'declined'
  onApprove: () => void
  onApproveTrusted: () => void
  onApproveWithEdits: (edits: PlanApprovalEdits) => void
  onDecline: () => void
}

/**
 * P7 of the internal plan — the interactive counterpart to
 * `AssistantTurnResult.status === 'needs_plan_approval'` (P2's mandatory whole-plan approval
 * gate). Mirrors AskQuestionCard's "in-progress draft state, separate from the wire shape until
 * submit" pattern: `cancelled`/`edited` here is local UI state, collapsed into a
 * `PlanApprovalEdits` only when the user actually confirms edits, never sent implicitly.
 */
export function PlanApprovalCard({ planApproval, resolution, onApprove, onApproveTrusted, onApproveWithEdits, onDecline }: Props): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [cancelled, setCancelled] = useState<Set<string>>(new Set())
  const [edited, setEdited] = useState<Record<string, string>>({})

  if (resolution) {
    const label =
      resolution === 'declined'
        ? 'Declined.'
        : resolution === 'approved_with_edits'
          ? 'Approved with edits.'
          : resolution === 'approved_trusted'
            ? "Approved — won't re-prompt for this plan's disclosed actions."
            : 'Approved.'
    return (
      <div className="plan-approval-card plan-approval-card--resolved">
        <div className="plan-approval-card__header">Plan {planApproval.templateName ?? '(custom)'}</div>
        <div className="plan-approval-card__resolution">{label}</div>
      </div>
    )
  }

  function toggleCancel(taskId: string): void {
    setCancelled((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  function handleConfirmEdits(): void {
    const edits: PlanApprovalEdits = {
      cancelTaskIds: cancelled.size > 0 ? [...cancelled] : undefined,
      editedTasks: Object.entries(edited)
        .filter(([id, description]) => description.trim().length > 0 && !cancelled.has(id))
        .map(([id, description]) => ({ id, description: description.trim() })),
    }
    onApproveWithEdits(edits)
  }

  return (
    <div className="plan-approval-card" data-testid="plan-approval-card">
      <div className="plan-approval-card__header">Plan awaiting approval — {planApproval.templateName ?? '(custom)'}</div>
      {planApproval.rationale && <div className="plan-approval-card__rationale">{planApproval.rationale}</div>}
      <div className="plan-approval-card__criteria">Success criteria: {planApproval.successCriteria}</div>
      <ul className="plan-approval-card__tasks">
        {planApproval.tasks.map((task) => (
          <li key={task.id} className={`plan-approval-card__task${cancelled.has(task.id) ? ' plan-approval-card__task--cancelled' : ''}`}>
            {editing && (
              <input
                type="checkbox"
                checked={cancelled.has(task.id)}
                onChange={() => toggleCancel(task.id)}
                aria-label={`Drop task ${task.id}`}
              />
            )}
            {editing && !cancelled.has(task.id) ? (
              <input
                type="text"
                className="plan-approval-card__task-edit"
                value={edited[task.id] ?? task.description}
                onChange={(e) => setEdited((prev) => ({ ...prev, [task.id]: e.target.value }))}
              />
            ) : (
              <span className="plan-approval-card__task-description">{task.description}</span>
            )}
            {task.riskLevel && <span className={`plan-approval-card__risk plan-approval-card__risk--${task.riskLevel.toLowerCase()}`}>{task.riskLevel}</span>}
          </li>
        ))}
      </ul>
      {planApproval.reviewNotes && planApproval.reviewNotes.length > 0 && (
        <ul className="plan-approval-card__review-notes">
          {planApproval.reviewNotes.map((note: string, i: number) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}
      <div className="plan-approval-card__actions">
        {editing ? (
          <>
            <button type="button" onClick={handleConfirmEdits}>Confirm edits &amp; approve</button>
            <button type="button" className="plan-approval-card__secondary" onClick={() => { setEditing(false); setCancelled(new Set()); setEdited({}) }}>
              Cancel edits
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={onApprove}>Approve</button>
            <button type="button" className="plan-approval-card__secondary" onClick={() => setEditing(true)}>Approve with edits</button>
            {/* P10 of the internal plan — deliberately worded and styled
               as a secondary, non-default choice (never the plan's only or primary approve
               control): opting in narrows nothing about what the plan discloses, only whether
               each of its own already-shown actions re-prompts individually while it runs. */}
            <button type="button" className="plan-approval-card__secondary" onClick={onApproveTrusted}>
              Approve &amp; don&apos;t re-prompt for actions this plan already discloses
            </button>
            <button type="button" className="plan-approval-card__decline" onClick={onDecline}>Decline</button>
          </>
        )}
      </div>
    </div>
  )
}
