import { describe, it, expect, vi } from 'vitest'
import type { FsBackend } from '@buildaharness/runtime'
import { executeActionTool, InvalidEmailArgsError, type ActionStagingContext } from './action-tools.js'
import { loadPendingAction, applyPendingAction } from './file-tools.js'
import type { SendEmail } from './email.js'

/** In-memory FsBackend — mirrors shell-tools.test.ts / file-tools.test.ts. */
function makeFakeBackend(root: string): FsBackend {
  const files = new Map<string, string>()
  const dirs = new Set<string>([root])
  return {
    async readTextFile(path) {
      return files.get(path)
    },
    async writeTextFile(path, contents) {
      files.set(path, contents)
    },
    async removeFile(path) {
      files.delete(path)
    },
    async mkdir(path) {
      dirs.add(path)
    },
    async readDir(dir) {
      const prefix = `${dir}/`
      const names: string[] = []
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) names.push(key.slice(prefix.length))
      }
      return names
    },
    async realpath(path) {
      if (files.has(path) || dirs.has(path)) return path
      throw new Error(`ENOENT: ${path}`)
    },
  }
}

const ROOT = '/workspace'

describe('executeActionTool — send_email', () => {
  it('never delivers inline — only stages a pending action with the concrete message', async () => {
    const backend = makeFakeBackend(ROOT)
    const ctx: ActionStagingContext = { backend, workspaceRoot: ROOT }

    const result = await executeActionTool(ctx, 'send_email', {
      to: 'boss@example.com',
      subject: 'I quit',
      body: 'Effective immediately.',
    })

    expect(result.kind).toBe('staged_email')
    const record = await loadPendingAction(backend, ROOT, result.id)
    expect(record).toMatchObject({
      kind: 'email',
      to: 'boss@example.com',
      subject: 'I quit',
      body: 'Effective immediately.',
    })
  })

  it('threads optional cc/bcc into the staged record', async () => {
    const backend = makeFakeBackend(ROOT)
    const result = await executeActionTool(
      { backend, workspaceRoot: ROOT },
      'send_email',
      { to: 'a@example.com', subject: 's', body: 'b', cc: 'c@example.com', bcc: 'd@example.com' },
    )
    const record = await loadPendingAction(backend, ROOT, result.id)
    expect(record).toMatchObject({ cc: 'c@example.com', bcc: 'd@example.com' })
  })

  it.each([
    ['missing to', { subject: 's', body: 'b' }],
    ['empty subject', { to: 'a@example.com', subject: '', body: 'b' }],
    ['non-string body', { to: 'a@example.com', subject: 's', body: 42 }],
  ])('rejects %s with InvalidEmailArgsError and stages nothing', async (_label, input) => {
    const backend = makeFakeBackend(ROOT)
    const writeSpy = vi.spyOn(backend, 'writeTextFile')
    await expect(
      executeActionTool({ backend, workspaceRoot: ROOT }, 'send_email', input as Record<string, unknown>),
    ).rejects.toBeInstanceOf(InvalidEmailArgsError)
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('rejects a malformed recipient address before staging', async () => {
    const backend = makeFakeBackend(ROOT)
    await expect(
      executeActionTool({ backend, workspaceRoot: ROOT }, 'send_email', { to: 'not-an-email', subject: 's', body: 'b' }),
    ).rejects.toThrow(/not a valid email address/)
  })

  it('rejects an unknown tool name', async () => {
    const backend = makeFakeBackend(ROOT)
    await expect(
      executeActionTool({ backend, workspaceRoot: ROOT }, 'send_sms' as string, {}),
    ).rejects.toThrow(/Unknown action tool/)
  })
})

describe('applyPendingAction — email branch', () => {
  it('delivers via the injected transport exactly once, then removes the staging record', async () => {
    const backend = makeFakeBackend(ROOT)
    const { id } = await executeActionTool({ backend, workspaceRoot: ROOT }, 'send_email', {
      to: 'boss@example.com',
      subject: 'I quit',
      body: 'Bye.',
    })

    const sendEmail: SendEmail = vi.fn(async () => ({ provider: 'resend' as const, id: 'sent-1' }))
    const applied = await applyPendingAction(backend, ROOT, id, { sendEmail })

    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(sendEmail).toHaveBeenCalledWith({ to: 'boss@example.com', subject: 'I quit', body: 'Bye.' })
    expect(applied).toMatchObject({ kind: 'email', delivery: { provider: 'resend', id: 'sent-1' } })
    expect(await loadPendingAction(backend, ROOT, id)).toBeUndefined()
  })

  it('throws when no sendEmail transport is provided, leaving the staged record in place', async () => {
    const backend = makeFakeBackend(ROOT)
    const { id } = await executeActionTool({ backend, workspaceRoot: ROOT }, 'send_email', {
      to: 'a@example.com',
      subject: 's',
      body: 'b',
    })
    await expect(applyPendingAction(backend, ROOT, id, {})).rejects.toThrow(/no sendEmail transport/)
    expect(await loadPendingAction(backend, ROOT, id)).toBeDefined()
  })

  it('a delivery failure propagates and the staged record survives for retry', async () => {
    const backend = makeFakeBackend(ROOT)
    const { id } = await executeActionTool({ backend, workspaceRoot: ROOT }, 'send_email', {
      to: 'a@example.com',
      subject: 's',
      body: 'b',
    })
    const sendEmail: SendEmail = vi.fn(async () => {
      throw new Error('smtp refused')
    })
    await expect(applyPendingAction(backend, ROOT, id, { sendEmail })).rejects.toThrow(/smtp refused/)
    expect(await loadPendingAction(backend, ROOT, id)).toBeDefined()
  })
})
