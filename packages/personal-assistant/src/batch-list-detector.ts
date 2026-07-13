export interface BatchListDetection {
  /** Exact strings as they appeared in the list (marker/bullet stripped), in message order. */
  items: string[]
}

const MIN_ITEMS = 3
// Batch targets (school names, addresses, product SKUs, ...) are short noun phrases — a line
// this long is far more likely to be an instruction sentence than a lookup target.
const MAX_WORDS_PER_ITEM = 8
const MIN_CAPITALIZED_RATIO = 0.6

const NUMBERED_MARKER = /^\d{1,2}[.)]\s+(.+)$/
const BULLET_MARKER = /^[-*]\s+(.+)$/

// Lowercase words that appear inside name-shaped phrases for grammatical reasons — English
// articles/prepositions and the handful of German ones the reference dataset ("Grundschule am
// Rüdesheimer Platz") actually uses. Excluded from the capitalization ratio so a real name isn't
// penalized for the connective tissue it needs, while an instruction sentence ("Add a submit
// button") still reads as mostly lowercase once its own articles are excluded the same way.
const CONNECTOR_WORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with',
  'am', 'im', 'an', 'der', 'die', 'das', 'von', 'zu', 'de', 'la', 'le', 'van', 'al',
])

function isCapitalizedWord(word: string): boolean {
  const first = word.charAt(0)
  return first !== first.toLowerCase() && first === first.toUpperCase()
}

/**
 * Strips a leading numbered/bullet marker (if present) and checks whether what's left reads as a
 * bare name/noun-phrase rather than a sentence — the distinguishing signal is that a name is
 * mostly capitalized words once connector words are excluded, while an instruction ("Fix the
 * header alignment") is mostly lowercase even though it may itself start with a capital letter.
 * Returns the stripped content on a match, or null — never a low-confidence guess.
 */
function nameShapedContent(trimmedLine: string): string | null {
  const numbered = NUMBERED_MARKER.exec(trimmedLine)
  const bulleted = BULLET_MARKER.exec(trimmedLine)
  const content = (numbered?.[1] ?? bulleted?.[1] ?? trimmedLine).trim()
  if (!content) return null

  const words = content.split(/\s+/).filter(Boolean)
  if (words.length === 0 || words.length > MAX_WORDS_PER_ITEM) return null

  const significant = words.filter((w) => !CONNECTOR_WORDS.has(w.toLowerCase()))
  if (significant.length === 0) return null

  const capitalized = significant.filter(isCapitalizedWord)
  if (capitalized.length / significant.length < MIN_CAPITALIZED_RATIO) return null

  return content
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
export function detectHomogeneousBatchList(message: string): BatchListDetection | null {
  const lines = message.split('\n')
  let bestRun: string[] = []
  let currentRun: string[] = []

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed === '') continue // blank lines separate paragraphs but don't break a list run

    const content = nameShapedContent(trimmed)
    if (content !== null) {
      currentRun.push(content)
    } else {
      if (currentRun.length > bestRun.length) bestRun = currentRun
      currentRun = []
    }
  }
  if (currentRun.length > bestRun.length) bestRun = currentRun

  return bestRun.length >= MIN_ITEMS ? { items: bestRun } : null
}
