/**
 * Run `fn` over `items` with at most `limit` in flight (at least 1). The next item starts as soon as a slot frees. Results are not returned: callers
 * write into their own structures. A `limit` of 1 is the plain sequential loop. No `node:*` and no DOM imports.
 */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(limit)), items.length) }, worker))
}
