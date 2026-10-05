import { planToSnapshot } from '@buildaharness/aielia'

/** The nine-task, every-status plan of the plan-visualization plan's Appendix C, as a viewer snapshot. */
export function appendixCPlan(): ReturnType<typeof planToSnapshot> {
  const t = (id: string, description: string, depends_on: string[], status: string, extra: Record<string, unknown> = {}) => ({ id, description, depends_on, status, ...extra })
  return planToSnapshot({
    successCriteria: 'Ship the report',
    rationale: 'Because users asked',
    tasks: [
      t('T1', 'Collect data', [], 'COMPLETE'),
      t('T2', 'Clean data', ['T1'], 'COMPLETE'),
      t('T3', 'Analyse trends', ['T1'], 'RUNNING'),
      t('T4', 'Draft charts', ['T2', 'T3'], 'PENDING'),
      t('T5', 'Write summary', ['T4'], 'PENDING'),
      t('T6', 'Legal sign-off', ['T1'], 'HUMAN_REQUIRED'),
      t('T7', 'Optional appendix', ['T1'], 'COMPLETE', { cancelled: true }),
      t('T8', 'Needs creds', ['T1'], 'BLOCKED'),
      t('T9', 'Send email', ['T5', 'T6'], 'FAILED', { statusNote: 'SMTP rejected' }),
    ],
  } as never)
}
