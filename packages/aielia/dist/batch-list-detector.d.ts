export interface BatchListDetection {
    /** Exact strings as they appeared in the list (marker/bullet stripped), in message order. */
    items: string[];
}
/**
 * Zero-LLM-call gate for the one task shape this plan targets: an explicit, syntactically obvious
 * list of ≥3 lookup targets (newline-separated names, markdown bullets, or a numbered list).
 * Deliberately narrower than decomposition-classifier.ts's enumeration detection — no
 * comma-enumeration, no sequencing-word detection, no word-count fallback. Those stay that file's
 * problem; this one only fires on a shape unambiguous enough that a false positive should be
 * essentially impossible. Fails closed (returns null) for anything else, including a list where
 * most lines don't read as name-shaped (task instructions, not lookup targets) and a run below the
 * 3-item floor.
 */
export declare function detectHomogeneousBatchList(message: string): BatchListDetection | null;
