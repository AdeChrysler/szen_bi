import { describe, it, expect } from 'vitest'
import { app } from '../index.js'

describe('orchestrator server', () => {
  it('health check returns ok', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
  })

  it('webhook endpoint accepts POST', async () => {
    const res = await app.request('/webhooks/plane', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'issue.updated', action: 'updated', data: {} })
    })
    expect(res.status).toBe(200)
  })
})
