/**
 * Saves `blob` as `filename` through a throwaway object URL. The URL is revoked after a delay, not
 * synchronously after click(): Safari and Firefox start the download asynchronously and a revoked
 * URL fails it (an empty or missing file). The anchor is attached while clicked for older Firefox.
 */
export function downloadBlob(blob: Blob, filename: string, revokeAfterMs = 1000): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  try {
    a.click()
  } finally {
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs)
  }
}
