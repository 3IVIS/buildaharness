// Differential memory conformance, TS side: runs one scenario (fixtures-memory/*.json) through the real
// MemoryService / admitCandidate / resolveWriteRoute / tierForFact over an in-memory store with an injected
// clock, and prints { steps, final, diagnostics } as JSON. Driven by compare-memory.mjs via `npx tsx`;
// the Python twin is run_py_memory.py. See scripts/harness-conformance/README.md "MEMORY-EQUIVALENCE CONTRACT".
//
// Semantic judgements are plain data (candidate.judgement) so no model is involved on either side.
import { readFileSync } from 'node:fs'
import {
  MemoryService, admitCandidate, DURABLE_FACTS_KEY, PENDING_CONFIRMATION_KEY, REJECTED_FACTS_KEY,
  RETIRED_FACTS_KEY, AUDIT_LOG_KEY, CONSOLIDATION_STATE_KEY, MEMORY_OFF_KEY,
} from '../../packages/aielia/src/memory-service.js'
import { resolveMemoryWriteMode, resolveWriteRoute } from '../../packages/aielia/src/memory-governance.js'
import { tierForFact, isKnowledgeTier, type UserFact } from '../../packages/aielia/src/fact-extraction.js'

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'))

// `{"$repeat": N, "template": {...}, "seqFrom": 1}` expands to N copies of template with seq = seqFrom + i (bulk audit logs).
function expand(v: any): any {
  if (Array.isArray(v)) return v.flatMap((x) => (x && typeof x === 'object' && '$repeat' in x
    ? Array.from({ length: x.$repeat }, (_, i) => ({ ...x.template, ...(x.seqFrom !== undefined ? { seq: x.seqFrom + i } : {}) }))
    : [expand(x)]))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]))
  return v
}

// Clock: entries are consumed in order; once the list is exhausted it keeps ticking one second past the last entry.
let clockCalls = 0
const clockList: string[] = fixture.clock ?? ['2026-01-01T00:00:00.000Z']
function clock(): string {
  const i = clockCalls++
  if (i < clockList.length) return clockList[i]
  return new Date(Date.parse(clockList[clockList.length - 1]) + (i - clockList.length + 1) * 1000).toISOString()
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const store = new Map<string, unknown>()
const adapter = {
  async get(k: string) { return clone(store.get(k)) },
  async set(k: string, v: unknown) { store.set(k, clone(v)) },
  async delete(k: string) { store.delete(k) },
  async search() { return [] },
}
const initial = expand(fixture.initial ?? {})
for (const [k, v] of Object.entries(initial)) store.set(k, clone(v))

const flags = fixture.flags ?? {}
process.env.AUDIT_MEMORY_WRITE_GATE = flags.writeGate ? '1' : '0'
process.env.AUDIT_MEMORY_AUDIT_LOG = flags.auditLog ? '1' : '0'
process.env.AUDIT_SEMANTIC_CONTRADICTION = '0'
delete process.env.AUDIT_MEMORY_BUDGETED_RENDER
delete process.env.AUDIT_MODEL_INFERRED_FACTS

const config = fixture.config ?? {}
const stub = {} as never
const service = new MemoryService(
  adapter as never, stub, stub, stub, () => undefined,
  () => config.project ?? '',
  () => config.budgetChars ?? 4000,
  () => resolveMemoryWriteMode(config.writeMode),
  clock,
)

const sessionIds = new Set<string>()
for (const k of Object.keys(initial)) if (k.startsWith('facts:') && !k.startsWith('facts:pending') && !['facts:durable', 'facts:rejected', 'facts:retired', 'facts:archive'].includes(k)) sessionIds.add(k.slice(6))

const strip = (f: any): any => { if (!f) return f; const { judgement: _j, ...rest } = f; return rest }
const orNull = (v: unknown) => (v === undefined ? null : v)

async function run(step: any): Promise<unknown> {
  const a = step.args ?? {}
  if (a.sessionId) sessionIds.add(a.sessionId)
  switch (step.call) {
    case 'load_facts': {
      const record = a.record !== false
      const r = await service.loadFacts(a.sessionId, { record })
      return { facts: r.facts, factsBlock: r.factsBlock, droppedCount: record ? service.getLastInjection()?.notShown ?? 0 : null }
    }
    case 'record_facts': {
      const writer = a.writer ?? 'in_turn'
      const cands: any[] = a.candidates ?? []
      if (writer === 'in_turn') {
        // The real in-turn path: the classifier's StatedFact list. userMessage is empty so the lexical pass adds nothing.
        const stated = cands.map((c) => {
          if ((c.source ?? 'model_inferred') !== 'model_inferred' || (c.origin ?? 'user') !== 'user') throw new Error('in_turn fixtures carry model_inferred, user-origin candidates only (use writer=digest for others)')
          const j = c.judgement ?? {}
          return {
            text: c.text, durable: c.durable, confidence: c.confidence, category: c.category,
            ...(c.key ? { key: c.key } : {}), ...(c.evidence ? { evidence: c.evidence } : {}),
            containsSecret: j.containsSecret, redactedText: j.redactedText, looksLikeInstruction: j.looksLikeInstruction,
          }
        })
        await service.recordFacts(a.sessionId, '', stated as never)
        return {}
      }
      const routes: unknown[] = []
      for (const c of cands) {
        const fact = { source: 'model_inferred', durable: false, sourceTurn: `turn:${a.sessionId}`, ...c, extractedAt: c.extractedAt ?? clock() }
        const out = await service.submitCandidate(writer, fact as UserFact, a.sessionId)
        routes.push({ route: out.route, fact: orNull(strip(out.fact)) })
      }
      return { routes }
    }
    case 'admit': {
      const d = admitCandidate(a.candidate as UserFact, a.gateOn ?? !!flags.writeGate)
      return { action: d.action, fact: strip(d.fact) }
    }
    case 'route': {
      const mode = resolveMemoryWriteMode(a.mode)
      const rows: any[] = a.rows ?? [a]
      return { routes: rows.map((r) => resolveWriteRoute(a.rows ? resolveMemoryWriteMode(r.mode) : mode, r.writer ?? 'in_turn', { source: r.source, durable: r.durable, confidence: r.confidence })) }
    }
    case 'tier': {
      const facts: any[] = a.facts ?? [a.fact]
      return { tiers: facts.map((f) => { const t = tierForFact(f as UserFact); return { tier: t, knowledge: isKnowledgeTier(t) } }) }
    }
    case 'forget': return { fact: orNull(await service.forgetFact(a.index, a.sessionId)) }
    case 'confirm': { const o = await service.confirmPendingFact(a.index); return { fact: orNull(o?.fact) } }
    case 'reject': return { fact: orNull(await service.rejectPendingFact(a.index)) }
    case 'undo': { const r = await service.undoAudit(a.seq, a.sessionId ?? 'undo'); return { ok: r.ok, message: r.message } }
    case 'history': return { entries: await service.getAuditLog(a.limit ?? 20) }
    default: throw new Error(`unknown call ${step.call}`)
  }
}

const results: unknown[] = []
for (const step of fixture.steps) results.push(await run(step))

const keys = [DURABLE_FACTS_KEY, PENDING_CONFIRMATION_KEY, REJECTED_FACTS_KEY, RETIRED_FACTS_KEY, AUDIT_LOG_KEY, CONSOLIDATION_STATE_KEY, MEMORY_OFF_KEY, ...[...sessionIds].map((s) => `facts:${s}`)]
const final: Record<string, unknown> = {}
for (const k of keys) if (store.has(k)) final[k] = clone(store.get(k))

console.log(JSON.stringify({ steps: results, final, diagnostics: { clockCalls } }))
