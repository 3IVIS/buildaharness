import type { NextStepSuggestion } from '@buildaharness/aielia'

interface Props {
  steps: NextStepSuggestion[]
  /** Called with the chosen option's text. The parent puts it in the composer as an editable draft — it is never sent from here. */
  onPick: (description: string) => void
}

/**
 * Turn-end next-step options (R7), shown under the latest reply, like Claude Code's prompt
 * suggestions. They are shortcuts, not a menu: the composer is always free to type anything else,
 * and picking a chip only fills the composer so the user can edit it before sending.
 */
export function NextStepChips({ steps, onPick }: Props): React.JSX.Element | null {
  if (steps.length === 0) return null
  return (
    <div className="next-steps" role="group" aria-label="Suggested next steps">
      <span className="next-steps__label">Next steps — pick one to edit, or just type your own</span>
      <div className="next-steps__chips">
        {steps.map((step) => (
          <button key={step.description} type="button" className="next-steps__chip" title={step.rationale} onClick={() => onPick(step.description)}>
            {step.description}
          </button>
        ))}
      </div>
    </div>
  )
}
