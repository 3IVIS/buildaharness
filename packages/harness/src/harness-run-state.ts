import { WorldModel, type WorldModelData, BeliefDepGraph, type BeliefDepGraphData } from './state/world-model.js'
import { CallerState, type CallerStateData } from './state/caller-state.js'
import { ControlState, type ControlStateData } from './state/control-state.js'
import { Diagnostics, type DiagnosticsData } from './state/diagnostics.js'
import { TaskGraph, type TaskGraphData } from './state/task-graph.js'
import { OutputContract, type OutputContractData } from './state/output-contract.js'
import { EvidenceStore, type EvidenceStoreData } from './state/evidence-store.js'
import { HypothesisSet, type HypothesisSetData } from './state/hypothesis-set.js'
import { MemoryState, type MemoryStateData } from './state/memory-state.js'
import { StrategyState, type StrategyStateData } from './state/strategy-state.js'
import { FailureDiagnostics, type FailureDiagnosticsData } from './state/failure-diagnostics.js'
import { InMemoryExperienceStore, type ExperienceStore, type ExperienceStoreData } from './state/experience-store.js'

export interface HarnessRunStateData {
  worldModel: WorldModelData
  callerState: CallerStateData
  controlState: ControlStateData
  diagnostics: DiagnosticsData
  taskGraph: TaskGraphData
  outputContract: OutputContractData
  evidenceStore: EvidenceStoreData
  hypothesisSet: HypothesisSetData
  memoryState: MemoryStateData
  strategyState: StrategyStateData
  failureDiagnostics: FailureDiagnosticsData
  experienceStore: ExperienceStoreData
  beliefDepGraph: BeliefDepGraphData
}

export class HarnessRunState {
  worldModel: WorldModel
  callerState: CallerState
  controlState: ControlState
  diagnostics: Diagnostics
  taskGraph: TaskGraph
  outputContract: OutputContract
  evidenceStore: EvidenceStore
  hypothesisSet: HypothesisSet
  memoryState: MemoryState
  strategyState: StrategyState
  failureDiagnostics: FailureDiagnostics
  experienceStore: ExperienceStore
  beliefDepGraph: BeliefDepGraph

  constructor(data?: Partial<{
    worldModel: WorldModel
    callerState: CallerState
    controlState: ControlState
    diagnostics: Diagnostics
    taskGraph: TaskGraph
    outputContract: OutputContract
    evidenceStore: EvidenceStore
    hypothesisSet: HypothesisSet
    memoryState: MemoryState
    strategyState: StrategyState
    failureDiagnostics: FailureDiagnostics
    experienceStore: ExperienceStore
    beliefDepGraph: BeliefDepGraph
  }>) {
    this.worldModel = data?.worldModel ?? new WorldModel()
    this.callerState = data?.callerState ?? new CallerState()
    this.controlState = data?.controlState ?? new ControlState()
    this.diagnostics = data?.diagnostics ?? new Diagnostics()
    this.taskGraph = data?.taskGraph ?? new TaskGraph()
    this.outputContract = data?.outputContract ?? new OutputContract()
    this.evidenceStore = data?.evidenceStore ?? new EvidenceStore()
    this.hypothesisSet = data?.hypothesisSet ?? new HypothesisSet()
    this.memoryState = data?.memoryState ?? new MemoryState()
    this.strategyState = data?.strategyState ?? new StrategyState()
    this.failureDiagnostics = data?.failureDiagnostics ?? new FailureDiagnostics()
    this.experienceStore = data?.experienceStore ?? new InMemoryExperienceStore()
    this.beliefDepGraph = data?.beliefDepGraph ?? new BeliefDepGraph()
  }

  toJSON(): HarnessRunStateData {
    return {
      worldModel: this.worldModel.toJSON(),
      callerState: this.callerState.toJSON(),
      controlState: this.controlState.toJSON(),
      diagnostics: this.diagnostics.toJSON(),
      taskGraph: this.taskGraph.toJSON(),
      outputContract: this.outputContract.toJSON(),
      evidenceStore: this.evidenceStore.toJSON(),
      hypothesisSet: this.hypothesisSet.toJSON(),
      memoryState: this.memoryState.toJSON(),
      strategyState: this.strategyState.toJSON(),
      failureDiagnostics: this.failureDiagnostics.toJSON(),
      experienceStore: this.experienceStore.toJSON(),
      beliefDepGraph: this.beliefDepGraph.toJSON(),
    }
  }

  static fromJSON(json: HarnessRunStateData): HarnessRunState {
    return new HarnessRunState({
      worldModel: WorldModel.fromJSON(json.worldModel),
      callerState: CallerState.fromJSON(json.callerState),
      controlState: ControlState.fromJSON(json.controlState),
      diagnostics: Diagnostics.fromJSON(json.diagnostics),
      taskGraph: TaskGraph.fromJSON(json.taskGraph),
      outputContract: OutputContract.fromJSON(json.outputContract),
      evidenceStore: EvidenceStore.fromJSON(json.evidenceStore),
      hypothesisSet: HypothesisSet.fromJSON(json.hypothesisSet),
      memoryState: MemoryState.fromJSON(json.memoryState),
      strategyState: StrategyState.fromJSON(json.strategyState),
      failureDiagnostics: FailureDiagnostics.fromJSON(json.failureDiagnostics),
      experienceStore: InMemoryExperienceStore.fromJSON(json.experienceStore),
      beliefDepGraph: BeliefDepGraph.fromJSON(json.beliefDepGraph),
    })
  }
}
