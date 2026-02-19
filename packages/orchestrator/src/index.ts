import { Hono } from 'hono'
import { logger } from 'hono/logger'
import type { PlaneWebhookPayload } from './types.js'

export const app = new Hono()

app.use('*', logger())

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.post('/webhooks/plane', async (c) => {
  const payload = await c.req.json<PlaneWebhookPayload>()
  console.log(`[webhook] Received: ${payload.event} — ${payload.action}`)
  return c.json({ received: true })
})

export default app
