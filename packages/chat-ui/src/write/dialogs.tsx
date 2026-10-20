import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

/**
 * Questions put to the writer from inside the page. The browser's own `window.prompt` and `window.confirm` are not used: a desktop webview
 * answers `prompt` with null at once and `confirm` with a Promise (which reads as "yes"), so a question could go unasked or be answered for the
 * writer. These work the same on every host.
 */
export interface Dialogs {
  /** Asks for a line of text. Resolves to the text (possibly empty), or undefined when the writer cancels. */
  ask(message: string, options?: { initial?: string }): Promise<string | undefined>
  /** Asks a yes-or-no question. Resolves to true only when the writer agrees. */
  confirm(message: string, options?: { yes?: string }): Promise<boolean>
}

type Open = { kind: 'ask'; message: string; initial: string; done: (v: string | undefined) => void } | { kind: 'confirm'; message: string; yes: string; done: (v: boolean) => void }

const Ctx = createContext<Dialogs | undefined>(undefined)

export function useDialogs(): Dialogs {
  const d = useContext(Ctx)
  if (!d) throw new Error('useDialogs needs a DialogProvider above it.')
  return d
}

export function DialogProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState<Open | undefined>()
  // A second question while one is open waits its turn rather than replacing it.
  const queue = useRef<Open[]>([])
  const show = useCallback((o: Open): void => { setOpen((cur) => { if (cur) { queue.current.push(o); return cur } return o }) }, [])
  const next = useCallback((): void => { setOpen(queue.current.shift()) }, [])
  const dialogs = useMemo<Dialogs>(() => ({
    ask: (message, options) => new Promise((resolve) => show({ kind: 'ask', message, initial: options?.initial ?? '', done: resolve })),
    confirm: (message, options) => new Promise((resolve) => show({ kind: 'confirm', message, yes: options?.yes ?? 'Yes', done: resolve })),
  }), [show])
  return (
    <Ctx.Provider value={dialogs}>
      {children}
      {open && <DialogBox key={open.message} open={open} onClose={next} />}
    </Ctx.Provider>
  )
}

function DialogBox({ open, onClose }: { open: Open; onClose: () => void }): React.JSX.Element {
  const [text, setText] = useState(open.kind === 'ask' ? open.initial : '')
  const input = useRef<HTMLInputElement>(null)
  const primary = useRef<HTMLButtonElement>(null)
  useEffect(() => { (input.current ?? primary.current)?.focus() }, [])
  const finish = (ok: boolean): void => {
    if (open.kind === 'ask') open.done(ok ? text : undefined)
    else open.done(ok)
    onClose()
  }
  return (
    <div className="write write__dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) finish(false) }}>
      <div className="write__dialog" role="dialog" aria-modal="true" aria-label={open.message} onKeyDown={(e) => { if (e.key === 'Escape') finish(false) }}>
        <form onSubmit={(e) => { e.preventDefault(); finish(true) }}>
          <p>{open.message}</p>
          {open.kind === 'ask' && <input ref={input} aria-label="Your answer" value={text} onChange={(e) => setText(e.target.value)} />}
          <div className="write__rowacts">
            <button type="submit" ref={primary} className="write__primary">{open.kind === 'ask' ? 'OK' : open.yes}</button>
            <button type="button" onClick={() => finish(false)}>{open.kind === 'ask' ? 'Cancel' : 'No'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
