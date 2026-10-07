const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * Human-readable local timestamp for list rows: "today 09:35", "yesterday", "6 Oct 2026".
 * Returns the input unchanged when it isn't a parseable date, so a bad value never renders as "NaN".
 */
export function formatTimestamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (dayDiff === 0) {
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `today ${hh}:${mm}`
  }
  if (dayDiff === 1) return 'yesterday'
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}
