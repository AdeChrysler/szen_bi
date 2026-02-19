import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { randomUUID } from 'crypto'
import type { PlaneWebhookPayload, QueuedTask } from './types.js'
import { Dispatcher } from './config.js'
import { TaskQueue } from './queue.js'
import { ContainerManager } from './docker.js'
import { PlaneClient } from './plane-client.js'

export const app = new Hono()
app.use('*', logger())

let dispatcher: Dispatcher | null = null
let queue: TaskQueue | null = null
let containers: ContainerManager | null = null
let plane: PlaneClient | null = null

export function init(deps: { dispatcher: Dispatcher; queue: TaskQueue; containers: ContainerManager; plane: PlaneClient }) {
  dispatcher = deps.dispatcher
  queue = deps.queue
  containers = deps.containers
  plane = deps.plane
}

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

app.get('/status', async (c) => c.json({ running: containers?.getRunning() ?? [], queueDepth: await queue?.depth() ?? 0 }))

app.post('/webhooks/plane', async (c) => {
  const payload = await c.req.json<PlaneWebhookPayload>()
  console.log(`[webhook] ${payload.event}.${payload.action}`)
  if (!dispatcher || !queue || !containers) return c.json({ error: 'not initialized' }, 503)

  const match = dispatcher.shouldDispatch(payload)
  if (!match) return c.json({ skipped: true, reason: 'no matching agent' })

  const { agentConfig, priority } = match
  const task: QueuedTask = {
    id: randomUUID(), issueId: payload.data.id, projectId: payload.data.project,
    workspaceSlug: payload.data.workspace, agentType: agentConfig.name,
    priority, payload: payload.data, queuedAt: new Date().toISOString(),
  }

  const running = containers.getRunningCount(agentConfig.name)
  if (running >= agentConfig.maxConcurrency) {
    await queue.enqueue(task)
    return c.json({ queued: true, taskId: task.id })
  }

  const secrets = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    PLANE_API_URL: process.env.PLANE_API_URL ?? '',
    PLANE_API_TOKEN: process.env.PLANE_API_TOKEN ?? '',
  }
  const containerId = await containers.runAgent(agentConfig, task, secrets)
  return c.json({ dispatched: true, taskId: task.id, containerId })
})

export default app
