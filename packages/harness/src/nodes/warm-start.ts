import type { ExperienceStore } from '../state/experience-store.js'
import type { FailureDiagnostics } from '../state/failure-diagnostics.js'
import type { TaskGraph } from '../state/task-graph.js'
import { StrategyState, DEFAULT_STRATEGY_ORDER, type StrategyType } from '../state/strategy-state.js'
import type { DepGraphBudget } from '../state/world-model.js'

function softmax(values: number[], temperature: number): number[] {
  const scaled = values.map(v => v / temperature)
  const max = Math.max(...scaled)
  const exps = scaled.map(v => Math.exp(v - max))
  const total = exps.reduce((a, b) => a + b, 0)
  return exps.map(e => e / total)
}

export function softmaxStrategyPolicy(
  strategyState: StrategyState,
  temperature = 1.0,
): Record<StrategyType, number> {
  const weights = strategyState.prior_strategy_weights
  const values = DEFAULT_STRATEGY_ORDER.map(s => weights[s] ?? 0)
  const probs = softmax(values, temperature)
  const result = {} as Record<StrategyType, number>
  for (let i = 0; i < DEFAULT_STRATEGY_ORDER.length; i++) {
    result[DEFAULT_STRATEGY_ORDER[i]] = probs[i]
  }
  return result
}

export function warmStart(
  experienceStore: ExperienceStore,
  strategyState: StrategyState,
  failureDiagnostics: FailureDiagnostics,
  depGraphBudget: DepGraphBudget,
  _taskGraph: TaskGraph,
): void {
  if (!experienceStore.available) return

  // Loader 1: strategy priors → strategyState.prior_strategy_weights
  const strategyWeights = experienceStore.getStrategyWeights()
  if (Object.keys(strategyWeights).length > 0) {
    for (const [key, weight] of Object.entries(strategyWeights)) {
      const strategyType = key.split(':')[0] as StrategyType
      if (DEFAULT_STRATEGY_ORDER.includes(strategyType)) {
        strategyState.prior_strategy_weights[strategyType] =
          (strategyState.prior_strategy_weights[strategyType] ?? 0) + weight
      }
    }
  }

  // Loader 2: failure class priors → failureDiagnostics.failure_mode_library.class_priors
  const classPriors = experienceStore.getClassPriors()
  if (Object.keys(classPriors).length > 0) {
    for (const [cls, prior] of Object.entries(classPriors)) {
      failureDiagnostics.failure_mode_library.class_priors[cls] = prior
    }
  }

  // Loader 3: dep_graph decay rates → depGraphBudget
  const strategyWeightsForDecay = experienceStore.getStrategyWeights()
  if (Object.keys(strategyWeightsForDecay).length > 0) {
    // Use aggregate weight distribution to adjust decay rate
    const totalWeight = Object.values(strategyWeightsForDecay).reduce((a, b) => a + b, 0)
    if (totalWeight > 0) {
      // Higher total evidence → more confident → slower decay
      depGraphBudget.confidence_decay_rate = Math.max(
        0.01,
        depGraphBudget.confidence_decay_rate * (1 - Math.min(0.5, totalWeight / 100)),
      )
    }
  }

  // Loader 4: structural decompositions → seed taskGraph patterns (no-op when empty)
  const decompositions = experienceStore.getDecompositions()
  if (decompositions.length > 0) {
    // Seeding happens at HarnessRuntime level when tasks are created;
    // decompositions are stored and referenced by task creation logic.
    // Here we just confirm they loaded — taskGraph seeding is deferred to runtime.
  }

  // Loader 5: tool workflow seeds → seed plan_tool_workflow() (no-op when empty)
  const toolWorkflows = experienceStore.getToolWorkflows()
  if (toolWorkflows.length > 0) {
    // Tool workflows inform plan_tool_workflow() selections at runtime.
    // No direct mutation here — used as read-only reference during execution.
  }

  // Loader 6: verification plan seeds → seed verification_adequacy_critic (no-op when empty)
  const verificationPlans = experienceStore.getVerificationPlans()
  if (verificationPlans.length > 0) {
    // Verification plans inform verification layer selection at runtime.
    // No direct mutation here — used as read-only reference during execute/verify nodes.
  }

  // Apply softmax policy to derive recovery strategy order from loaded weights
  const policy = softmaxStrategyPolicy(strategyState, 1.0)
  const ordered = (Object.entries(policy) as [StrategyType, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s)
  if (ordered.length === DEFAULT_STRATEGY_ORDER.length) {
    strategyState.recovery_strategy_order = ordered
  }
}
