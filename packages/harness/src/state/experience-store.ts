export type StrategyWeightKey = string  // `${strategyType}:${failureClass}`

export interface DecompositionEntry { task_type: string; decomposition: string[]; success_rate: number }
export interface ToolWorkflowEntry { tool_id: string; workflow_steps: string[]; success_rate: number }
export interface VerificationPlanEntry { task_type: string; layers: string[]; success_rate: number }
export interface RecoverySequenceEntry { failure_class: string; strategy_sequence: string[]; success_rate: number }

export interface ExperienceStoreData {
  strategy_weights: Record<string, number>
  class_priors: Record<string, number>
  decompositions: DecompositionEntry[]
  tool_workflows: ToolWorkflowEntry[]
  verification_plans: VerificationPlanEntry[]
  recovery_sequences: RecoverySequenceEntry[]
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
    }
  }

  static fromJSON(json: ExperienceStoreData): InMemoryExperienceStore {
    const store = new InMemoryExperienceStore()
    store._strategyWeights = { ...json.strategy_weights }
    store._classPriors = { ...json.class_priors }
    store._decompositions = [...json.decompositions]
    store._toolWorkflows = [...json.tool_workflows]
    store._verificationPlans = [...json.verification_plans]
    store._recoverySequences = [...json.recovery_sequences]
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
    return { strategy_weights: {}, class_priors: {}, decompositions: [], tool_workflows: [], verification_plans: [], recovery_sequences: [] }
  }
}
