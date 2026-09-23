import { describe, it, expect } from 'vitest'
import { LiveSteeringChannel } from './live-steering-channel.js'

describe('LiveSteeringChannel', () => {
  it('starts empty', () => {
    const channel = new LiveSteeringChannel()
    expect(channel.pendingCount).toBe(0)
    expect(channel.poll()).toEqual([])
  })

  it('returns a single enqueued message on poll', () => {
    const channel = new LiveSteeringChannel()
    channel.enqueue('hello')
    const drained = channel.poll()
    expect(drained).toHaveLength(1)
    expect(drained[0].message).toBe('hello')
  })

  it('preserves FIFO order across multiple messages queued before one poll', () => {
    const channel = new LiveSteeringChannel()
    channel.enqueue('first')
    channel.enqueue('second')
    channel.enqueue('third')
    expect(channel.pendingCount).toBe(3)
    const drained = channel.poll()
    expect(drained.map((e) => e.message)).toEqual(['first', 'second', 'third'])
  })

  it('clears the queue on poll — a second poll with nothing new returns empty, never re-delivers', () => {
    const channel = new LiveSteeringChannel()
    channel.enqueue('once')
    channel.poll()
    expect(channel.poll()).toEqual([])
    expect(channel.pendingCount).toBe(0)
  })

  it('accumulates messages enqueued after a poll into a fresh batch', () => {
    const channel = new LiveSteeringChannel()
    channel.enqueue('a')
    channel.poll()
    channel.enqueue('b')
    channel.enqueue('c')
    expect(channel.poll().map((e) => e.message)).toEqual(['b', 'c'])
  })

  it('pendingCount reflects the current queue depth without draining it', () => {
    const channel = new LiveSteeringChannel()
    channel.enqueue('x')
    channel.enqueue('y')
    expect(channel.pendingCount).toBe(2)
    expect(channel.pendingCount).toBe(2)
  })
})
