import { describe, it, expect, vi } from 'vitest'
import { _maybeResolve, StalenessError, type ControlStateResolverFn } from './generation-id.js'
import { ControlState } from './state/control-state.js'
import { WorldModel } from './state/world-model.js'
import { Diagnostics } from './state/diagnostics.js'
import { FailureDiagnostics } from './state/failure-diagnostics.js'

describe('_maybeResolve', () => {
  it('re-resolves control state once when generation_id stale', () => {
    const controlState = new ControlState({ generation_id: 0 })
    const worldModel = new WorldModel({ generation_id: 2 })
    const diagnostics = new Diagnostics()
    const failureDiagnostics = new FailureDiagnostics()

    const resolver: ControlStateResolverFn = vi.fn((d, wm, fd) => {
      return new ControlState({ generation_id: wm.generation_id, risk_state: 'NORMAL' })
    })

    _maybeResolve(controlState, worldModel, diagnostics, failureDiagnostics, resolver)

    expect(resolver).toHaveBeenCalledTimes(1)
    expect(controlState.generation_id).toBe(2)
  })

  it('throws StalenessError if still stale after one resolution attempt', () => {
    const controlState = new ControlState({ generation_id: 0 })
    const worldModel = new WorldModel({ generation_id: 2 })
    const diagnostics = new Diagnostics()

    const resolver: ControlStateResolverFn = () => {
      // Resolver returns generation_id=1, still stale relative to worldModel.generation_id=2
      return new ControlState({ generation_id: 1 })
    }

    expect(() => _maybeResolve(controlState, worldModel, diagnostics, undefined, resolver)).toThrow(StalenessError)
  })

  it('throws StalenessError when stale and no resolver provided', () => {
    const controlState = new ControlState({ generation_id: 0 })
    const worldModel = new WorldModel({ generation_id: 1 })
    expect(() => _maybeResolve(controlState, worldModel)).toThrow(StalenessError)
  })

  it('does not throw and does not call resolver when not stale', () => {
    const controlState = new ControlState({ generation_id: 5 })
    const worldModel = new WorldModel({ generation_id: 5 })
    const resolver = vi.fn()
    expect(() => _maybeResolve(controlState, worldModel, undefined, undefined, resolver)).not.toThrow()
    expect(resolver).not.toHaveBeenCalled()
  })
})
