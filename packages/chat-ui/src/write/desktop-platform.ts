import { invoke } from '@tauri-apps/api/core'
import { createLlmClient, folderFromListing, type AssistantConfig, type FolderReader } from '@buildaharness/aielia'
import { createWebTools, pageReader } from '../web-context'
import { indexedDbArticleStore, type WritePlatform } from './write-services'

/**
 * Write inside the desktop app: what the Tauri shell can do that a browser tab cannot. The model client is the app's (the Claude CLI session, or a
 * key); pages, search and GitHub are fetched from Rust through the HTTP plugin (no CORS, and the only way past the webview's content-security
 * policy); a repository or source folder is any folder the writer picks, read through the workspace commands with that folder as the root, so
 * Write can only look inside it and never writes to it. Articles stay in the webview's IndexedDB, as in a browser tab.
 *
 * The Tauri modules are imported when this runs, so a plain browser build never loads them.
 */
export async function desktopWritePlatform(config: AssistantConfig): Promise<WritePlatform> {
  const [{ TauriClaudeCliLLMClient }, { createTauriWorkspaceFsBackend }] = await Promise.all([import('../tauri-claude-cli-llm-client'), import('../tauri-workspace-fs-backend')])
  // The same web plumbing as the chat: the Tauri fetch (a request made from Rust), the DNS guard and Brave search.
  const web = await createWebTools(config, true)
  const tauriFetch = web.fetchImpl as typeof fetch
  return {
    store: indexedDbArticleStore(),
    // No file or shell tools for Write's own model calls, whatever the chat has switched on.
    llm: createLlmClient(config, { fetchImpl: tauriFetch, claudeCli: () => new TauriClaudeCliLLMClient() }),
    fetchWeb: pageReader(web),
    searchWeb: config.braveApiKey ? web.search : undefined,
    // The webview's content-security policy blocks its own fetch to GitHub; the request is made from Rust instead.
    githubFetch: tauriFetch,
    pickFolder: () => pickDesktopFolder((root) => createTauriWorkspaceFsBackend(root)),
    keepGithubToken: true,
    hostName: 'app',
  }
}

/** Asks for a folder with the system dialog. Cancelling gives undefined. The folder is the root of everything read from it. */
export async function pickDesktopFolder(backendFor: (root: string) => { readTextFile(path: string): Promise<string | undefined>; listDir(path: string): Promise<{ name: string; directory: boolean }[]> }): Promise<FolderReader | undefined> {
  const picked = await invoke<string | null>('pick_workspace_directory')
  if (!picked) return undefined
  const root = picked.replace(/[\\/]+$/, '') || picked
  const name = root.split(/[\\/]/).pop() || root
  return folderFromListing(backendFor(root), root, name)
}
