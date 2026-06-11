import { ProcessConcept, ProcessConceptNotFoundError } from './process-concept.js'

import debugTestFailureJson from './concepts/debug-test-failure.json'
import implementFeatureJson from './concepts/implement-feature.json'
import codeReviewJson from './concepts/code-review.json'
import refactorModuleJson from './concepts/refactor-module.json'

export class ProcessRegistry {
  private _registry: Map<string, ProcessConcept> = new Map()

  register(conceptId: string, concept: ProcessConcept): void {
    this._registry.set(conceptId, concept)
  }

  load(conceptId: string): ProcessConcept {
    const concept = this._registry.get(conceptId)
    if (!concept) {
      throw new ProcessConceptNotFoundError(conceptId)
    }
    return concept
  }

  listAvailable(): string[] {
    return [...this._registry.keys()].sort()
  }
}

export function registerAll(registry: ProcessRegistry): void {
  const bundles = [
    debugTestFailureJson,
    implementFeatureJson,
    codeReviewJson,
    refactorModuleJson,
  ] as Record<string, unknown>[]

  for (const json of bundles) {
    const concept = ProcessConcept.fromJson(json)
    registry.register(concept.id, concept)
  }
}

export const DEFAULT_REGISTRY = new ProcessRegistry()
registerAll(DEFAULT_REGISTRY)
