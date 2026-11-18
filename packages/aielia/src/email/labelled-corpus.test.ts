import { describe, it, expect } from 'vitest'
import { generateLabelledCorpus, scoreVerdicts, threadMessages } from './labelled-corpus.js'
import { junkFolderOnlyBaseline, ruleLeaks, ungatedBulkSenderRules, unansweredQuestionBaseline } from './eval-baselines.js'
import { FolderKindSchema } from './model.js'

describe('labelled corpus', () => {
  const c = generateLabelledCorpus()
  it('is deterministic and labels every thread', () => {
    expect(generateLabelledCorpus().verdicts).toEqual(c.verdicts)
    expect(Object.keys(c.verdicts).sort()).toEqual(c.mailbox.threads.map((t) => t.id).sort())
    expect(new Set(Object.values(c.verdicts))).toEqual(new Set(['needs_response', 'no_action', 'spam']))
  })
  it('has a Junk folder with history, and the junk kind is part of the model', () => {
    expect(FolderKindSchema.safeParse('junk').success).toBe(true)
    const junk = c.mailbox.folders.find((f) => f.kind === 'junk')!
    expect(c.mailbox.messages.filter((m) => m.folderIds.includes(junk.id)).length).toBeGreaterThanOrEqual(12)
    expect(c.junkSenders.length).toBeGreaterThanOrEqual(12)
  })
  it('never labels mail from someone the owner wrote to as spam', () => {
    for (const t of c.mailbox.threads) {
      if (threadMessages(c.mailbox, t.id).some((m) => c.repliedSenders.includes(m.from.address))) expect(c.verdicts[t.id]).not.toBe('spam')
    }
  })
  it('contains traps that look like no-action mail but need a response', () => {
    const needs = c.traps.filter((t) => c.verdicts[t] === 'needs_response')
    expect(needs.length).toBeGreaterThanOrEqual(3)
    for (const t of needs) expect(threadMessages(c.mailbox, t).some((m) => m.headers['list-unsubscribe'] || m.headers['list-id'])).toBe(true)
  })
  it('scoreVerdicts counts missed replies and spam false positives', () => {
    const s = scoreVerdicts({ a: 'spam', b: 'needs_response', c: 'no_action' }, { a: 'needs_response', b: 'needs_response', c: 'spam' })
    expect(s).toMatchObject({ missedReplies: 1, spamCaught: 0, spamTotal: 1, spamFalsePositives: 1 })
    expect(s.needsResponseRecall).toBe(0.5)
  })
})

describe('control baselines', () => {
  const c = generateLabelledCorpus()
  it('the question-mark control misses real replies (a deadline has no question)', () => {
    const s = scoreVerdicts(unansweredQuestionBaseline(c), c.verdicts)
    expect(s.missedReplies).toBeGreaterThan(0)
    expect(s.needsResponseRecall).toBeLessThan(1)
  })
  it('the junk-folder-only control catches no spam that is still in the inbox', () => {
    const s = scoreVerdicts(junkFolderOnlyBaseline(c), c.verdicts)
    expect(s.spamCaught).toBeLessThan(s.spamTotal)
    expect(s.spamFalsePositives).toBe(0)
  })
  it('an ungated bulk-sender rule set swallows mail that needs a response', () => {
    const leaks = ruleLeaks(ungatedBulkSenderRules(c.mailbox.messages), c)
    expect(leaks.length).toBeGreaterThanOrEqual(3)
  })
})
