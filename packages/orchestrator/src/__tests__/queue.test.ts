import { describe, it, expect, beforeEach } from 'vitest'
import { TaskQueue } from '../queue.js'
import type { QueuedTask } from '../types.js'

class MockRedis {
  private store = new Map<string, string>()
  private sorted = new Map<string, Array<{ score: number; member: string }>>()

  async zadd(key: string, score: number, member: string) {
    if (!this.sorted.has(key)) this.sorted.set(key, [])
    const list = this.sorted.get(key)!
    list.push({ score, member })
    list.sort((a, b) => a.score - b.score)
  }

  async zpopmin(key: string) {
    const list = this.sorted.get(key)
    if (!list || list.length === 0) return []
    const item = list.shift()!
    return [item.member, String(item.score)]
  }

  async zcard(key: string) {
    return this.sorted.get(key)?.length ?? 0
  }

  async zrange(key: string, start: number, stop: number) {
    const list = this.sorted.get(key) ?? []
    return list.slice(start, stop + 1).map((i) => i.member)
  }

  async set(key: string, value: string) {
    this.store.set(key, value)
  }

  async get(key: string) {
    return this.store.get(key) ?? null
  }

  async del(key: string) {
    this.store.delete(key)
    this.sorted.delete(key)
  }
}

function makeTask(id: string, priority: number): QueuedTask {
  return { id, issueId: `issue-${id}`, projectId: 'proj-1', workspaceSlug: 'ws', agentType: 'dev', priority, payload: {} as any, queuedAt: new Date().toISOString() }
}

describe('TaskQueue', () => {
  let queue: TaskQueue

  beforeEach(() => {
    queue = new TaskQueue(new MockRedis() as any)
  })

  it('enqueues a task', async () => {
    await queue.enqueue(makeTask('t1', 2))
    expect(await queue.depth()).toBe(1)
  })

  it('dequeues highest priority first (lowest number)', async () => {
    await queue.enqueue(makeTask('t1', 2))
    await queue.enqueue(makeTask('t2', 0))
    await queue.enqueue(makeTask('t3', 1))
    const next = await queue.dequeue()
    expect(next?.id).toBe('t2')
  })

  it('returns null when empty', async () => {
    expect(await queue.dequeue()).toBeNull()
  })
})
