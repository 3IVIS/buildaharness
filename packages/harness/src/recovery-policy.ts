import { RECOVERY_CLASSIFICATION_TABLE } from './_core-generated.js'

// Failure → Classification → Recovery Policy → Selected Action (criticism002 #7).
//
// Phase C2 (ADR-004, shared semantic core) lands this table as DATA + TYPES
// only. RECOVERY_CLASSIFICATION_TABLE is generated from spec/harness-core.json into
// _core-generated.ts, shared byte-for-byte with adapter/harness/recovery.py's
// RECOVERY_CLASSIFICATION_TABLE. classifyRecovery() is a pure lookup: a CLASSIFIED
// failure resolves to a RecoveryPolicy naming the short-circuit action; an
// UNCLASSIFIED failure returns null and the caller falls through to its existing
// strategy progression unchanged. Wiring this into recovery selection is Phase D —
// nothing calls classifyRecovery() yet.

export interface RecoveryPolicy {
  failure_class: string
  policy: string
  action: string
}

export function classifyRecovery(failureClass: string | null | undefined): RecoveryPolicy | null {
  if (!failureClass) return null
  const entry = RECOVERY_CLASSIFICATION_TABLE[failureClass]
  if (entry === undefined) return null
  return { failure_class: failureClass, policy: entry.policy, action: entry.action }
}
