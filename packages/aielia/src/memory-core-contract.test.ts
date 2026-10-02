import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryAdapter, InMemoryReminderStore } from '@buildaharness/runtime'
import { InMemoryExperienceStore } from '@buildaharness/harness'
import {
  MemoryService, admitCandidate, renderFactsBlock,
  DEFAULT_MEMORY_BUDGET_CHARS, AUDIT_LOG_KEEP, AUDIT_LOG_KEY, CONSOLIDATION_STATE_KEY, MEMORY_OFF_KEY,
  DURABLE_FACTS_KEY, PENDING_CONFIRMATION_KEY, REJECTED_FACTS_KEY, RETIRED_FACTS_KEY, ARCHIVED_FACTS_KEY, CONSOLIDATION_PROPOSALS_KEY,
  type AuditEntry,
} from './memory-service.js'
import { MEMORY_WRITE_MODES, DEFAULT_MEMORY_WRITE_MODE, resolveWriteRoute, type MemoryWriteMode, type MemoryWriter } from './memory-governance.js'
import { TIER_RULES, tierForFact, isKnowledgeTier, type UserFact, type MemoryTier } from './fact-extraction.js'
import * as G from './_memory-core-generated.js'

// ── Compile-time field check: ported contract fields <-> UserFact keys ────────────────
type FieldName = (typeof G.FACT_FIELDS)[number]['name']
type PortedName = Extract<(typeof G.FACT_FIELDS)[number], { port: 'yes' }>['name']
type MissingFromTs = Exclude<PortedName, keyof UserFact>
type MissingFromContract = Exclude<keyof UserFact, FieldName | (typeof G.FACT_TRANSIENT_FIELDS)[number]>
const _noMissingFromTs: [MissingFromTs] extends [never] ? true : false = true
const _noMissingFromContract: [MissingFromContract] extends [never] ? true : false = true
void _noMissingFromTs
void _noMissingFromContract

function fact(over: Partial<UserFact> = {}): UserFact {
  return { text: 'placeholder', extractedAt: '2026-01-01T00:00:00.000Z', sourceTurn: 'turn:1', durable: false, source: 'user_asserted', ...over }
}

describe('memory-core contract: constants', () => {
  it('budget, audit keep and store keys equal the TS constants', () => {
    expect(G.DEFAULT_MEMORY_BUDGET_CHARS).toBe(DEFAULT_MEMORY_BUDGET_CHARS)
    expect(G.AUDIT_LOG_KEEP).toBe(AUDIT_LOG_KEEP)
    expect(G.STORE_KEYS.durable).toBe(DURABLE_FACTS_KEY)
    expect(G.STORE_KEYS.pending).toBe(PENDING_CONFIRMATION_KEY)
    expect(G.STORE_KEYS.rejected).toBe(REJECTED_FACTS_KEY)
    expect(G.STORE_KEYS.retired).toBe(RETIRED_FACTS_KEY)
    expect(G.STORE_KEYS.audit).toBe(AUDIT_LOG_KEY)
    expect(G.STORE_KEYS.consolidationState).toBe(CONSOLIDATION_STATE_KEY)
    expect(G.STORE_KEYS.off).toBe(MEMORY_OFF_KEY)
    expect(G.STORE_KEYS.archive).toBe(ARCHIVED_FACTS_KEY)
    expect(G.STORE_KEYS.proposals).toBe(CONSOLIDATION_PROPOSALS_KEY)
    expect(`${G.STORE_KEYS.SESSION_FACTS_PREFIX}s1`).toBe('facts:s1')
  })

  it('write modes and default equal memory-governance', () => {
    expect([...G.WRITE_MODES]).toEqual([...MEMORY_WRITE_MODES])
    expect(G.DEFAULT_WRITE_MODE).toBe(DEFAULT_MEMORY_WRITE_MODE)
  })

  it('TIER_RULES equals fact-extraction TIER_RULES and the tier list', () => {
    expect(JSON.parse(JSON.stringify(G.TIER_RULES))).toEqual(JSON.parse(JSON.stringify(TIER_RULES)))
    expect([...G.MEMORY_TIERS].sort()).toEqual(Object.keys(TIER_RULES).sort())
  })

  it('INV-16 data matches TS behaviour', () => {
    const knowledge = (Object.keys(TIER_RULES) as MemoryTier[]).filter((t) => isKnowledgeTier(t)).sort()
    expect([...G.INV16.knowledgeTiers].sort()).toEqual(knowledge)
    for (const origin of G.INV16.neverPromotable) {
      const f = fact({ origin, durable: true, confidence: 'high', category: 'identity', text: 'My name is Sam.' })
      expect(tierForFact(f)).toBe(G.INV16.nonUserOriginTier)
    }
    for (const t of G.INV16.neverReturnedTiers) expect(TIER_RULES[t].allowedSources).toHaveLength(0)
  })
})

describe('memory-core contract: budgeted render', () => {
  it('header, line format, unconfirmed suffix and separator cost', () => {
    const a = fact({ text: 'alpha', durable: true })
    const b = fact({ text: 'beta', durable: true, source: 'model_inferred', confidence: 'medium', extractedAt: '2026-01-02T00:00:00.000Z' })
    const { block } = renderFactsBlock([a, b], G.DEFAULT_MEMORY_BUDGET_CHARS)
    expect(block.startsWith(G.BUDGET_HEADER)).toBe(true)
    const line = (text: string, suffix: string) => G.BUDGET_LINE_FORMAT.replace('{text}', text).replace('{suffix}', suffix)
    // alpha is semantic (priority 1); beta is an unconfirmed model guess, episodic (priority 2).
    expect(block).toBe(G.BUDGET_HEADER + [line('alpha', ''), line('beta', G.UNCONFIRMED_SUFFIX)].join('\n'))
  })

  it('budget counts header and one separator per line after the first', () => {
    const f1 = fact({ text: 'aaaa', durable: true })
    const f2 = fact({ text: 'bbbb', durable: true, extractedAt: '2025-01-01T00:00:00.000Z' })
    const l = G.BUDGET_LINE_FORMAT.replace('{text}', 'aaaa').replace('{suffix}', '').length
    const exact = G.BUDGET_HEADER.length + l + G.BUDGET_SEPARATOR_COST + l
    expect(renderFactsBlock([f1, f2], exact).shown).toHaveLength(2)
    expect(renderFactsBlock([f1, f2], exact - 1).shown).toHaveLength(1)
  })

  it('priorities order identity/preference < semantic < episodic < session', () => {
    const base = '2026-01-01T00:00:00.000Z'
    const facts = [
      fact({ text: 'session', durable: false, extractedAt: '2026-01-10T00:00:00.000Z' }),
      fact({ text: 'episodic', durable: true, source: 'observed', extractedAt: '2026-01-05T00:00:00.000Z' }),
      fact({ text: 'semantic', durable: true, extractedAt: '2026-01-15T00:00:00.000Z' }),
      fact({ text: 'My name is Sam.', durable: true, category: 'identity', extractedAt: base }),
    ]
    const order = renderFactsBlock(facts, 4000).shown.map((f) => f.text)
    // episodic and session share priority 2, so the newer statement leads within it.
    expect(order).toEqual(['My name is Sam.', 'semantic', 'session', 'episodic'])
    expect(G.TIER_PRIORITY).toEqual({ identity: 0, preference: 0, semantic: 1, episodic: 2 })
    expect(G.SESSION_PRIORITY).toBe(G.TIER_PRIORITY.episodic)
  })
})

type Node = Record<string, unknown>
function evalNode(n: Node, f: Record<string, unknown>): boolean {
  if ('always' in n) return true
  if ('all' in n) return (n.all as Node[]).every((c) => evalNode(c, f))
  if ('not' in n) return !evalNode(n.not as Node, f)
  const v = f[n.field as string]
  if ('present' in n) return (v !== undefined) === n.present
  if ('eq' in n) return v === n.eq
  if ('neq' in n) return v !== undefined && v !== n.neq
  throw new Error('unknown node ' + JSON.stringify(n))
}
function contractTier(f: UserFact): string {
  for (const r of G.TIER_RULE_ORDER) if (evalNode(r.when as Node, f as unknown as Record<string, unknown>)) return r.tier
  throw new Error('no rule')
}

describe('memory-core contract: structural tier rule', () => {
  it('rule order agrees with tierForFact over a category-bearing grid', () => {
    const text: Record<string, string> = { identity: 'My name is Sam.', preference: 'I prefer tea.', health: 'placeholder', other: 'placeholder' }
    let n = 0
    for (const origin of [undefined, 'user', 'agent', 'tool', 'web'] as const)
      for (const source of G.FACT_SOURCES)
        for (const durable of [true, false])
          for (const confidence of [undefined, 'high', 'medium', 'low'] as const)
            for (const category of ['identity', 'preference', 'health', 'other'] as const) {
              const f = fact({ origin, source, durable, confidence, category, text: text[category] })
              expect(contractTier(f), JSON.stringify(f)).toBe(tierForFact(f))
              n++
            }
    expect(n).toBe(5 * 4 * 2 * 4 * 4)
  })

  it('never returns procedural or commitment', () => {
    for (const r of G.TIER_RULE_ORDER) expect(G.INV16.neverReturnedTiers as readonly string[]).not.toContain(r.tier)
  })
})

describe('memory-core contract: write route table', () => {
  it('has every combination and each row equals resolveWriteRoute', () => {
    expect(G.WRITE_ROUTE_TABLE).toHaveLength(2 * 4 * 2 * 4 * 3)
    const seen = new Set<string>()
    for (const row of G.WRITE_ROUTE_TABLE) {
      seen.add(JSON.stringify([row.writerClass, row.source, row.durable, row.confidence, row.mode]))
      const writers: MemoryWriter[] = row.writerClass === 'in_turn' ? ['in_turn'] : ['digest', 'reviewer', 'consolidation']
      for (const w of writers) {
        const got = resolveWriteRoute(row.mode as MemoryWriteMode, w, { source: row.source, durable: row.durable, confidence: row.confidence ?? undefined })
        expect(got, JSON.stringify(row)).toBe(row.route)
      }
    }
    expect(seen.size).toBe(G.WRITE_ROUTE_TABLE.length)
  })
})

describe('memory-core contract: gate rules', () => {
  type Rule = { when: Record<string, boolean>; action: string | null; terminal: boolean; effects: Record<string, boolean> }
  function contractAdmit(c: UserFact, gateOn: boolean): { action: string; fact: UserFact } {
    const { judgement, ...bare } = c
    const j = judgement ?? {}
    const origin = bare.origin ?? G.DEFAULT_FACT_ORIGIN
    const ctx: Record<string, boolean> = {
      gateOn,
      judged: origin !== 'user' || bare.source === 'model_inferred',
      judgementComplete: typeof j.containsSecret === 'boolean' && typeof j.looksLikeInstruction === 'boolean',
      containsSecret: j.containsSecret === true,
      redactedNonEmpty: (j.redactedText ?? '').trim() !== '',
      looksLikeInstruction: j.looksLikeInstruction === true,
      nonUser: origin !== 'user',
    }
    let out: UserFact = { origin: G.DEFAULT_FACT_ORIGIN, ...bare }
    for (const r of G.GATE_RULES as unknown as Rule[]) {
      if (!Object.entries(r.when).every(([k, v]) => ctx[k] === v)) continue
      if (r.effects.applyDefaultOrigin === false) out = { ...bare }
      if (r.effects.durable === false) out = { ...out, durable: false }
      if (r.effects.flagged) out = { ...out, flagged: true }
      if (r.effects.replaceTextWithRedacted) out = { ...out, text: (j.redactedText ?? '').trim() }
      if (r.effects.clearEvidence) out = { ...out, evidence: undefined }
      if (r.terminal) return { action: r.action as string, fact: out }
    }
    throw new Error('no terminal gate rule')
  }

  it('pipeline agrees with admitCandidate over a grid', () => {
    const judgements = [
      undefined,
      {},
      { containsSecret: false },
      { containsSecret: false, looksLikeInstruction: false },
      { containsSecret: true, redactedText: '', looksLikeInstruction: false },
      { containsSecret: true, redactedText: ' key is [redacted] ', looksLikeInstruction: false },
      { containsSecret: true, redactedText: 'x', looksLikeInstruction: true },
      { containsSecret: false, looksLikeInstruction: true },
    ]
    let n = 0
    for (const gateOn of [true, false])
      for (const origin of [undefined, 'user', 'agent', 'tool', 'web'] as const)
        for (const source of G.FACT_SOURCES)
          for (const judgement of judgements) {
            const c = fact({ ...(origin ? { origin } : {}), source, durable: true, evidence: 'ev', judgement })
            const want = admitCandidate(c, gateOn)
            const got = contractAdmit(c, gateOn)
            expect({ action: got.action, fact: JSON.parse(JSON.stringify(got.fact)) }, JSON.stringify({ gateOn, c })).toEqual({ action: want.action, fact: JSON.parse(JSON.stringify(want.fact)) })
            n++
          }
    expect(n).toBe(2 * 5 * 4 * 8)
    expect(new Set(G.GATE_RULES.map((r) => r.action).filter(Boolean))).toEqual(new Set(G.ADMIT_ACTIONS))
  })
})

describe('memory-core contract: undo messages', () => {
  const llm = { async *callChat() { yield '' }, async callChatSync() { return '' }, async callChatStructured() { return { content: '{}' } } }
  const f = fact({ text: 'I prefer tea.', durable: true })
  const entry = (over: Partial<AuditEntry>): AuditEntry => ({ seq: 1, at: 'x', op: 'add', factId: `${f.text}|${f.extractedAt}`, after: f, store: 'durable', writer: 'in_turn', turn: 's', ...over })
  beforeEach(() => { process.env.AUDIT_MEMORY_AUDIT_LOG = '1' })
  afterEach(() => { delete process.env.AUDIT_MEMORY_AUDIT_LOG })
  const fill = (m: string, v: Record<string, string | number>) => Object.entries(v).reduce((s, [k, x]) => s.replace(`{${k}}`, String(x)), m)

  it('each TS-performed rule returns exactly the contract message', async () => {
    const memory = new InMemoryAdapter()
    const svc = new MemoryService(memory, new InMemoryReminderStore(new InMemoryAdapter()), new InMemoryExperienceStore(), llm as never, () => undefined)
    await memory.set(AUDIT_LOG_KEY, [
      entry({ seq: 1 }),
      entry({ seq: 2, op: 'undo', undoes: 1 }),
      entry({ seq: 3 }),
      entry({ seq: 4, erased: true, before: undefined, after: undefined }),
      entry({ seq: 5 }),
    ])
    await memory.set(DURABLE_FACTS_KEY, [f])
    expect((await svc.undoAudit(99)).message).toBe(fill(G.UNDO_MESSAGES.unknownSeq, { seq: 99 }))
    expect((await svc.undoAudit(2)).message).toBe(fill(G.UNDO_MESSAGES.isUndo, { seq: 2 }))
    expect((await svc.undoAudit(1)).message).toBe(fill(G.UNDO_MESSAGES.alreadyUndone, { seq: 1 }))
    expect((await svc.undoAudit(4)).message).toBe(fill(G.UNDO_MESSAGES.erased, { seq: 4 }))
    const ok = await svc.undoAudit(5)
    expect(ok.ok).toBe(true)
    expect(ok.message).toBe(fill(G.UNDO_MESSAGES.success, { seq: 5, op: 'add', text: f.text }))
    const log = (await memory.get(AUDIT_LOG_KEY)) as AuditEntry[]
    const undo = log[log.length - 1]
    expect(undo).toMatchObject({ op: 'undo', writer: 'undo', turn: 'undo', undoes: 5 })
    expect(G.UNDO_MESSAGES_PYTHON_ONLY).toEqual(['grouped'])
  })

  it('audit entry fields cover the TS shape and enums match', () => {
    const names = G.AUDIT_ENTRY_FIELDS.map((x) => x.name)
    expect(names).toEqual(['seq', 'at', 'op', 'factId', 'before', 'after', 'store', 'writer', 'turn', 'undoes', 'erased', 'group', 'index'])
    expect([...G.AUDIT_OPS]).toEqual(['add', 'replace', 'retire', 'remove', 'confirm', 'reject', 'undo', 'archive', 'restore'])
    expect([...G.AUDIT_STORES]).toEqual(['durable', 'pending', 'rejected'])
    expect(G.FACT_ID_FORMAT).toBe('{text}|{extractedAt}')
  })
})
