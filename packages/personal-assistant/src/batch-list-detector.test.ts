import { describe, it, expect } from 'vitest'
import { detectHomogeneousBatchList } from './batch-list-detector.js'

describe('detectHomogeneousBatchList', () => {
  it('does not detect an open-ended discovery request', () => {
    expect(detectHomogeneousBatchList('Find schools near me')).toBeNull()
  })

  it('does not detect free-text comma-enumerated actions — that shape stays decomposition-classifier.ts\'s problem', () => {
    expect(detectHomogeneousBatchList('call the bank, email the landlord, pick up dry cleaning')).toBeNull()
  })

  it('does not detect a 2-item list — below the 3-item floor', () => {
    const message = 'Erich-Kästner-Grundschule\nHalensee-Grundschule'
    expect(detectHomogeneousBatchList(message)).toBeNull()
  })

  it('does not detect a coding/file-edit request with an incidental 3-line bullet list of requirements', () => {
    const message = 'Please update the login page:\n- Add a submit button\n- Fix the header alignment\n- Update the footer text'
    expect(detectHomogeneousBatchList(message)).toBeNull()
  })

  it('replays the existing bulk-reminder test corpus — none of it should false-positive as a batch lookup', () => {
    const bulkReminderMessages = [
      'Remind me to: research the company, prepare answers to behavioral questions, pick out what to wear, and plan my route.',
      'Set reminders for calling the bank, emailing the landlord, and picking up dry cleaning.',
      'Please create reminders for calling the bank, emailing the landlord, and picking up dry cleaning.',
      'Remind me to call the bank, and remind me to email the landlord about the leak.',
    ]
    for (const message of bulkReminderMessages) {
      expect(detectHomogeneousBatchList(message)).toBeNull()
    }
  })

  it('detects 3+ newline-separated proper-noun-shaped lines, items returned in order', () => {
    const message = 'Erich-Kästner-Grundschule\nGrundschule am Rüdesheimer Platz\nHalensee-Grundschule'
    const result = detectHomogeneousBatchList(message)
    expect(result).not.toBeNull()
    expect(result?.items).toEqual(['Erich-Kästner-Grundschule', 'Grundschule am Rüdesheimer Platz', 'Halensee-Grundschule'])
  })

  it('detects a numbered list of ≥3 items', () => {
    const message = '1. Charlie Elementary School\n2. Riverside Primary School\n3. Maple Grove Academy'
    const result = detectHomogeneousBatchList(message)
    expect(result?.items).toEqual(['Charlie Elementary School', 'Riverside Primary School', 'Maple Grove Academy'])
  })

  it('detects a markdown-bulleted list of ≥3 items', () => {
    const message = '- Charlie Elementary School\n- Riverside Primary School\n* Maple Grove Academy'
    const result = detectHomogeneousBatchList(message)
    expect(result?.items).toEqual(['Charlie Elementary School', 'Riverside Primary School', 'Maple Grove Academy'])
  })

  it('parses names with German umlauts/eszett/diacritics as single intact list items, not split mid-word', () => {
    const message = 'Erich-Kästner-Grundschule\nGrundschule am Rüdesheimer Platz\nGroßschule Straße'
    const result = detectHomogeneousBatchList(message)
    expect(result?.items).toEqual(['Erich-Kästner-Grundschule', 'Grundschule am Rüdesheimer Platz', 'Großschule Straße'])
  })

  it('re-evaluates per turn: an open-ended miss on one turn does not suppress detection on a later turn', () => {
    const turn1 = 'Find the 5 closest primary schools'
    const turn2 = 'Erich-Kästner-Grundschule\nGrundschule am Rüdesheimer Platz\nHalensee-Grundschule'
    expect(detectHomogeneousBatchList(turn1)).toBeNull()
    expect(detectHomogeneousBatchList(turn2)).not.toBeNull()
  })

  it('ignores a preamble sentence and only picks up the qualifying list run', () => {
    const message = 'Here are the schools I need open-house dates for:\nErich-Kästner-Grundschule\nGrundschule am Rüdesheimer Platz\nHalensee-Grundschule'
    const result = detectHomogeneousBatchList(message)
    expect(result?.items).toEqual(['Erich-Kästner-Grundschule', 'Grundschule am Rüdesheimer Platz', 'Halensee-Grundschule'])
  })
})
