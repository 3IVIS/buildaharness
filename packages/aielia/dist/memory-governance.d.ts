import { UserFact } from './fact-extraction.js';
/**
 * M6 governance: WHERE a candidate memory write is allowed to land. Pure and structural: it reads
 * the fact's own `source`/`confidence`/`durable` bits and the configured mode, never its wording
 * (D2: no lexical checks). `MemoryService` is the only caller (`memoryWriteMode` is resolved in
 * MemoryService only), so no writer can pick its own route.
 *
 * - `auto`      model-inferred in-turn facts follow today's confidence policy; cross-turn writers
 *               (digest/reviewer/consolidation, M3/M4/M5) may add durable facts directly.
 * - `staged`    (default, D1) in-turn writer keeps today's policy; every cross-turn writer is
 *               staged in the pending queue. Nothing is auto-deleted.
 * - `user_only` the model never creates a durable fact on its own: every model-inferred candidate
 *               that would have been durable waits in the pending queue for `/memory confirm`.
 *               Facts the user stated in their own words (`user_asserted`) are the user writing.
 */
export type MemoryWriteMode = 'auto' | 'staged' | 'user_only';
export declare const MEMORY_WRITE_MODES: readonly MemoryWriteMode[];
export declare const DEFAULT_MEMORY_WRITE_MODE: MemoryWriteMode;
/**
 * Which writer produced the candidate. `in_turn` is the classifier/lexical pass that already
 * exists. The other three are EXTENSION POINTS owned by later phases: M3 digests (`digest`), M4's
 * post-turn reviewer (`reviewer`), M5 consolidation proposals (`consolidation`). They are routed
 * by `MemoryService.submitCandidate()` and are not built here.
 */
export type MemoryWriter = 'in_turn' | 'digest' | 'reviewer' | 'consolidation';
export type CrossTurnWriter = Exclude<MemoryWriter, 'in_turn'>;
export type WriteRoute = 'durable' | 'pending' | 'session';
/** Unknown / absent values resolve to the default instead of throwing: a typo must never silently widen write authority. */
export declare function resolveMemoryWriteMode(raw: unknown): MemoryWriteMode;
export declare function resolveWriteRoute(mode: MemoryWriteMode, writer: MemoryWriter, fact: Pick<UserFact, 'source' | 'durable' | 'confidence'>): WriteRoute;
