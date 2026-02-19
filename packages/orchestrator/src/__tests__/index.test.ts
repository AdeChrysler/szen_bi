import { describe, it, expect } from 'vitest'
import { app } from '../index.js'

describe('orchestrator server', () => {
  it('health check returns ok', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
  })

  it('webhook endpoint returns 503 when not initialized', async () => {
    const res = await app.request('/webhooks/plane', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'issue', action: 'updated', data: { id: 'i1', name: 'Test', priority: 'high', state: { name: 'Todo', group: 'backlog' }, assignees: ['a1'], labels: [], project: 'p1', workspace: 'w1' } })
    })
    expect(res.status).toBe(503)
  })
})
