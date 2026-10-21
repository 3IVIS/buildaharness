export interface MemoryResult {
  key: string
  value: unknown
  score: number
}

export interface MemoryAdapter {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, mode?: string): Promise<void>
  search(query: string, topK?: number, minScore?: number): Promise<MemoryResult[]>
  delete(key: string): Promise<void>
  /** Removes everything this adapter holds. Optional: a host that can offer "delete all my data" implements it. */
  clear?(): Promise<void>
}
