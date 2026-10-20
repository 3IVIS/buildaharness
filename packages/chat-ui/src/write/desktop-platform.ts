import { IndexedDBAdapter } from '@buildaharness/runtime'
import { invoke } from '@tauri-apps/api/core'
import {
  braveSearch,
  createLlmClient,
  createMemoryAdapterArticleStore,
  executeWebTool,
  folderFromFsBackend,
  type AssistantConfig,
  type FolderReader,
} from '@buildaharness/aielia'
import { rememberUserUrls } from '../user-urls'
import type { WritePlatform } from './write-services'

/**
 * Write inside the desktop app: what the Tauri shell can do that a browser tab cannot. The model client is the app's (the Claude CLI session, or a
 * key); pages, search and GitHub are fetched from Rust through the HTTP plugin (no CORS, and the only way past the webview's content-security
 * policy); a repository or source folder is any folder the writer picks, read through the workspace commands with that folder as the root, so
 * Write can only look inside it and never writes to it. Articles stay in the webview's IndexedDB, as in a browser tab.
 *
 * The Tauri modules are imported when this runs, so a plain browser build never loads them.
 */
export async function desktopWritePlatform(config: AssistantConfig): Promise<WritePlatform> {
  const [{ fetch: tauriFetch }, { tauriDnsResolver }, { TauriClaudeCliLLMClient }, { createTauriWorkspaceFsBackend }] = await Promise.all([
    import('@tauri-apps/plugin-http'),
    import('../tauri-dns-resolver'),
    import('../tauri-claude-cli-llm-client'),
    import('../tauri-workspace-fs-backend'),
  ])
  const search = config.braveApiKey ? (query: string) => braveSearch(query, config.braveApiKey ?? '', { fetchImpl: tauriFetch }) : undefined
  return {
    store: createMemoryAdapterArticleStore(new IndexedDBAdapter({ namespace: 'aielia-write' })),
    // No file or shell tools for Write's own model calls, whatever the chat has switched on.
    llm: createLlmClient(config, { fetchImpl: tauriFetch, claudeCli: () => new TauriClaudeCliLLMClient() }),
    fetchWeb: async (url) => {
      rememberUserUrls(url)
      return (await executeWebTool({ search: search ?? (async () => []), fetchImpl: tauriFetch, dns: tauriDnsResolver }, 'fetch_url', { url })).text
    },
    searchWeb: search,
    // The webview's content-security policy blocks its own fetch to GitHub; the request is made from Rust instead.
    githubFetch: tauriFetch as typeof fetch,
    pickFolder: () => pickDesktopFolder((root) => createTauriWorkspaceFsBackend(root)),
    keepGithubToken: true,
    hostName: 'app',
  }
}

/** Asks for a folder with the system dialog. Cancelling gives undefined. The folder is the root of everything read from it. */
export async function pickDesktopFolder(backendFor: (root: string) => { readTextFile(path: string): Promise<string | undefined>; readDir(path: string): Promise<string[]> }): Promise<FolderReader | undefined> {
  const picked = await invoke<string | null>('pick_workspace_directory')
  if (!picked) return undefined
  const root = picked.replace(/[\\/]+$/, '') || picked
  const name = root.split(/[\\/]/).pop() || root
  return folderFromFsBackend(backendFor(root), root, name)
}
