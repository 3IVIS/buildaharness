import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { migrateFact, tierForFact, isKnowledgeTier, TIER_RULES, type UserFact, type MemoryTier } from './fact-extraction.js'

function fact(overrides: Partial<UserFact>): UserFact {
  return { text: 'placeholder', extractedAt: '2026-01-01T00:00:00.000Z', sourceTurn: 'turn:1', durable: false, source: 'user_asserted', ...overrides }
}

describe('tierForFact — routing (Phase E / E3)', () => {
  it('routes a durable user_asserted identity statement to identity', () => {
    const f = fact({ text: 'My name is Priya.', durable: true, source: 'user_asserted' })
    expect(tierForFact(f)).toBe('identity')
  })

  it('routes a durable user_asserted preference statement to preference', () => {
    const f = fact({ text: 'I prefer tea over coffee.', durable: true, source: 'user_asserted' })
    expect(tierForFact(f)).toBe('preference')
  })

  it('routes a durable user_asserted health/dietary statement (no name/preference phrasing) to semantic', () => {
    const f = fact({ text: "I'm allergic to shellfish.", durable: true, source: 'user_asserted' })
    expect(tierForFact(f)).toBe('semantic')
  })

  it('routes a non-durable user_asserted statement (job/location/coding-fact) to semantic, not episodic', () => {
    // "I work as a nurse." / "The tests passed on the CI pipeline." are exactly the kind of
    // non-durable, user_asserted claim assistant.test.ts's cross-turn belief seeding suite
    // already exercises for contradiction detection — these must stay Knowledge-tier (semantic),
    // not fall to episodic, or that existing suite would regress.
    expect(tierForFact(fact({ text: 'I work as a nurse.', durable: false, source: 'user_asserted' }))).toBe('semantic')
    expect(tierForFact(fact({ text: 'The tests passed on the CI pipeline.', durable: false, source: 'user_asserted' }))).toBe('semantic')
  })

  it('routes a model_inferred paraphrase to episodic only, regardless of its durable bit', () => {
    const f = fact({ text: 'Sounds like they might be thinking about moving to Berlin.', durable: false, source: 'model_inferred' })
    expect(tierForFact(f)).toBe('episodic')
    // Even if something upstream mis-stamped a model_inferred fact as durable, it still never
    // reaches identity/semantic/preference — the source check runs before the durable check.
    expect(tierForFact({ ...f, durable: true })).toBe('episodic')
  })

  it('routes an observed (tool-result) fact to episodic — never Knowledge without corroboration', () => {
    const f = fact({ text: 'The deploy script reported success.', durable: false, source: 'observed' })
    expect(tierForFact(f)).toBe('episodic')
  })

  it('never returns procedural or commitment — those tiers have no UserFact producer', () => {
    const tiers: MemoryTier[] = ['episodic', 'semantic', 'procedural', 'preference', 'commitment', 'identity']
    for (const t of tiers) {
      if (t === 'procedural' || t === 'commitment') {
        expect(TIER_RULES[t].allowedSources).toHaveLength(0)
      }
    }
  })
})

describe('isKnowledgeTier — contradiction-detection scope (Phase E)', () => {
  it('treats semantic, identity, and preference as Knowledge', () => {
    expect(isKnowledgeTier('semantic')).toBe(true)
    expect(isKnowledgeTier('identity')).toBe(true)
    expect(isKnowledgeTier('preference')).toBe(true)
  })

  it('does not treat episodic as Knowledge — a musing must not trip a contradiction', () => {
    expect(isKnowledgeTier('episodic')).toBe(false)
  })

  it('INV-16: does not treat procedural (Experience) as Knowledge', () => {
    expect(isKnowledgeTier('procedural')).toBe(false)
  })

  it('does not treat commitment as Knowledge', () => {
    expect(isKnowledgeTier('commitment')).toBe(false)
  })
})

describe('migration — old-shape durable facts land in the right tier (Phase 0 mechanism)', () => {
  it('a pre-source on-disk fact defaults to user_asserted and keeps its durable bit, then routes to identity', () => {
    const onDisk = { text: 'My name is Jordan.', extractedAt: '2026-01-01T00:00:00.000Z', sourceTurn: 'turn:1', durable: true } as UserFact
    const migrated = migrateFact(onDisk)
    expect(migrated.source).toBe('user_asserted')
    expect(migrated.durable).toBe(true)
    expect(tierForFact(migrated)).toBe('identity')
  })

  it('a pre-source non-durable on-disk fact is not silently demoted, and stays semantic', () => {
    const onDisk = { text: 'I work as a nurse.', extractedAt: '2026-01-01T00:00:00.000Z', sourceTurn: 'turn:1', durable: false } as UserFact
    const migrated = migrateFact(onDisk)
    expect(migrated.durable).toBe(false)
    expect(tierForFact(migrated)).toBe('semantic')
  })

  it('an already-migrated fact with an explicit source is left untouched', () => {
    const already = fact({ source: 'externally_verified', durable: true, text: 'My favorite color is blue.' })
    expect(migrateFact(already)).toEqual(already)
  })
})

describe('TIER_RULES — retention rule matches existing storage split', () => {
  it('episodic is session-retention (facts:${sessionId}, cleared by clearSession)', () => {
    expect(TIER_RULES.episodic.retention).toBe('session')
  })

  it('semantic/identity/preference are durable-retention (DURABLE_FACTS_KEY, survives /new)', () => {
    expect(TIER_RULES.semantic.retention).toBe('durable')
    expect(TIER_RULES.identity.retention).toBe('durable')
    expect(TIER_RULES.preference.retention).toBe('durable')
  })
})

describe('Phase E scope guard — tier types stay internal to personal-assistant', () => {
  it('no file outside packages/personal-assistant imports MemoryTier/tierForFact/TIER_RULES/isKnowledgeTier', () => {
    const packagesDir = join(__dirname, '..', '..')
    const offenders: string[] = []
    const changedTypeNames = ['MemoryTier', 'tierForFact', 'isKnowledgeTier', 'TIER_RULES']

    function walk(dir: string): void {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'personal-assistant') continue
        const full = join(dir, entry)
        const stat = statSync(full)
        if (stat.isDirectory()) {
          walk(full)
        } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
          const content = readFileSync(full, 'utf-8')
          if (changedTypeNames.some((name) => content.includes(name))) {
            offenders.push(full)
          }
        }
      }
    }

    walk(packagesDir)
    expect(offenders).toEqual([])
  })
})
