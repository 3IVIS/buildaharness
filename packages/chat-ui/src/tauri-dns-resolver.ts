import { invoke } from '@tauri-apps/api/core'
import type { DnsResolver } from '@buildaharness/personal-assistant'

/**
 * DnsResolver for fetch_url's SSRF guard (web-tools.ts's assertPublicHttpUrl) on desktop —
 * backed by the dns_lookup Tauri command (src-tauri/src/lib.rs), since the guard's default
 * resolver (`node:dns/promises`) doesn't exist in a webview at all. Without this, fetch_url
 * throws on every call rather than actually working with real SSRF protection — see that
 * command's own doc comment for the full story.
 */
export const tauriDnsResolver: DnsResolver = async (hostname) => {
  return await invoke<string[]>('dns_lookup', { hostname })
}
