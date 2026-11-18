import {
  mapLocalSourceError, type LocalBody, type LocalDiscovery, type LocalMailboxRow, type LocalMailSource, type LocalMessageFilter, type LocalMessagePage,
  type LocalMessageRow, type LocalRecipientRow, type LocalRowState, type LocalStateMark,
} from './local-source.js'

/**
 * The page's side of the desktop commands that read Apple Mail's local store (`mail_local_*`, packages/desktop/src-tauri/src/mail_local_apple.rs).
 * Every read happens in Rust, read-only, on a private copy of Mail's database; this client sends structured values only (no path, no SQL) and
 * receives rows. Takes `invoke` as a parameter: no Tauri or DOM import.
 */
export type LocalInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export function tauriLocalMailSource(invoke: LocalInvoke): LocalMailSource {
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(command, args)
    } catch (e) {
      throw mapLocalSourceError(e)
    }
  }
  return {
    discover: () => call<LocalDiscovery>('mail_local_discover'),
    mailboxes: () => call<LocalMailboxRow[]>('mail_local_mailboxes'),
    messages: (filter: LocalMessageFilter) => call<LocalMessagePage>('mail_local_messages', { filter }),
    message: (rowid: number) => call<LocalMessageRow | null>('mail_local_message', { rowid }),
    recipients: (rowids: number[]) => (rowids.length === 0 ? Promise.resolve([]) : call<LocalRecipientRow[]>('mail_local_recipients', { rowids })),
    state: () => call<LocalStateMark>('mail_local_state'),
    states: () => call<LocalRowState[]>('mail_local_states'),
    body: (rowid: number) => call<LocalBody>('mail_local_body', { rowid }),
  }
}
