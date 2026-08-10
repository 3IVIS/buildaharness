export type StrategyWeightKey = string  // `${strategyType}:${failureClass}`

export interface DecompositionEntry { task_type: string; decomposition: string[]; success_rate: number }
export interface ToolWorkflowEntry { tool_id: string; workflow_steps: string[]; success_rate: number }
export interface VerificationPlanEntry { task_type: string; layers: string[]; success_rate: number }
export interface RecoverySequenceEntry { failure_class: string; strategy_sequence: string[]; success_rate: number }

/** Bumped only if a field here is renamed/restructured — appending a new optional field doesn't require a bump. */
export const EXPERIENCE_STORE_SCHEMA_VERSION = 1

export interface ExperienceStoreData {
  strategy_weights: Record<string, number>
  class_priors: Record<string, number>
  decompositions: DecompositionEntry[]
  tool_workflows: ToolWorkflowEntry[]
  verification_plans: VerificationPlanEntry[]
  recovery_sequences: RecoverySequenceEntry[]
  schemaVersion?: number
}

export interface ExperienceStore {
  readonly available: boolean
  getStrategyWeights(): Record<StrategyWeightKey, number>
  setStrategyWeight(key: StrategyWeightKey, weight: number): void
  getClassPriors(): Record<string, number>
  setClassPrior(failureClass: string, prior: number): void
  getDecompositions(): DecompositionEntry[]
  addDecomposition(entry: DecompositionEntry): void
  getToolWorkflows(): ToolWorkflowEntry[]
  addToolWorkflow(entry: ToolWorkflowEntry): void
  getVerificationPlans(): VerificationPlanEntry[]
  addVerificationPlan(entry: VerificationPlanEntry): void
  getRecoverySequences(): RecoverySequenceEntry[]
  addRecoverySequence(entry: RecoverySequenceEntry): void
  updateExperienceStore(runId: string, outcome: Record<string, unknown>): void
  toJSON(): ExperienceStoreData
}

export class InMemoryExperienceStore implements ExperienceStore {
  private _strategyWeights: Record<StrategyWeightKey, number> = {}
  private _classPriors: Record<string, number> = {}
  private _decompositions: DecompositionEntry[] = []
  private _toolWorkflows: ToolWorkflowEntry[] = []
  private _verificationPlans: VerificationPlanEntry[] = []
  private _recoverySequences: RecoverySequenceEntry[] = []
  private _runs: Map<string, Record<string, unknown>> = new Map()

  get available(): boolean { return true }

  getStrategyWeights() { return { ...this._strategyWeights } }
  setStrategyWeight(key: StrategyWeightKey, weight: number) { this._strategyWeights[key] = weight }
  getClassPriors() { return { ...this._classPriors } }
  setClassPrior(failureClass: string, prior: number) { this._classPriors[failureClass] = prior }
  getDecompositions() { return [...this._decompositions] }
  addDecomposition(entry: DecompositionEntry) { this._decompositions.push(entry) }
  getToolWorkflows() { return [...this._toolWorkflows] }
  addToolWorkflow(entry: ToolWorkflowEntry) { this._toolWorkflows.push(entry) }
  getVerificationPlans() { return [...this._verificationPlans] }
  addVerificationPlan(entry: VerificationPlanEntry) { this._verificationPlans.push(entry) }
  getRecoverySequences() { return [...this._recoverySequences] }
  addRecoverySequence(entry: RecoverySequenceEntry) { this._recoverySequences.push(entry) }

  updateExperienceStore(runId: string, outcome: Record<string, unknown>): void {
    this._runs.set(runId, outcome)
  }

  toJSON(): ExperienceStoreData {
    return {
      strategy_weights: { ...this._strategyWeights },
      class_priors: { ...this._classPriors },
      decompositions: [...this._decompositions],
      tool_workflows: [...this._toolWorkflows],
      verification_plans: [...this._verificationPlans],
      recovery_sequences: [...this._recoverySequences],
      schemaVersion: EXPERIENCE_STORE_SCHEMA_VERSION,
    }
  }

  /**
   * Never throws. Experience data is optional cross-run learning, not correctness-critical
   * state (see the harness's "learning must never be on the critical correctness path"
   * principle) — an unreadable or newer-than-known snapshot degrades to a fresh, empty
   * store the same way an unavailable store already does, rather than crashing whatever
   * called fromJSON(). Each field defaults independently so a partially-shaped legacy
   * blob keeps whatever parts of it still parse instead of being discarded wholesale.
   */
  static fromJSON(json: ExperienceStoreData | null | undefined): InMemoryExperienceStore {
    const store = new InMemoryExperienceStore()
    if (!json || typeof json !== 'object') return store
    if ((json.schemaVersion ?? EXPERIENCE_STORE_SCHEMA_VERSION) > EXPERIENCE_STORE_SCHEMA_VERSION) {
      console.warn(
        `InMemoryExperienceStore.fromJSON: schemaVersion ${json.schemaVersion} is newer than this build understands (current: ${EXPERIENCE_STORE_SCHEMA_VERSION}) — starting from a fresh store instead of misreading it.`,
      )
      return store
    }
    store._strategyWeights = json.strategy_weights ? { ...json.strategy_weights } : {}
    store._classPriors = json.class_priors ? { ...json.class_priors } : {}
    store._decompositions = Array.isArray(json.decompositions) ? [...json.decompositions] : []
    store._toolWorkflows = Array.isArray(json.tool_workflows) ? [...json.tool_workflows] : []
    store._verificationPlans = Array.isArray(json.verification_plans) ? [...json.verification_plans] : []
    store._recoverySequences = Array.isArray(json.recovery_sequences) ? [...json.recovery_sequences] : []
    return store
  }
}

export class UnavailableExperienceStore implements ExperienceStore {
  get available(): boolean { return false }
  getStrategyWeights() { return {} }
  setStrategyWeight() {}
  getClassPriors() { return {} }
  setClassPrior() {}
  getDecompositions() { return [] }
  addDecomposition() {}
  getToolWorkflows() { return [] }
  addToolWorkflow() {}
  getVerificationPlans() { return [] }
  addVerificationPlan() {}
  getRecoverySequences() { return [] }
  addRecoverySequence() {}
  updateExperienceStore() {}
  toJSON(): ExperienceStoreData {
    return {
      strategy_weights: {},
      class_priors: {},
      decompositions: [],
      tool_workflows: [],
      verification_plans: [],
      recovery_sequences: [],
      schemaVersion: EXPERIENCE_STORE_SCHEMA_VERSION,
    }
  }
}
