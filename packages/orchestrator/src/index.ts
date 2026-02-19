import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { randomUUID, createHmac, timingSafeEqual } from 'crypto'
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
let webhookSecret: string | null = null

export function init(deps: {
  dispatcher: Dispatcher
  queue: TaskQueue
  containers: ContainerManager
  plane: PlaneClient
  webhookSecret?: string
}) {
  dispatcher = deps.dispatcher
  queue = deps.queue
  containers = deps.containers
  plane = deps.plane
  webhookSecret = deps.webhookSecret ?? null
}

function verifyWebhookSignature(body: string, signature: string | null): boolean {
  if (!webhookSecret) return true // No secret configured, skip verification
  if (!signature) return false
  const expected = createHmac('sha256', webhookSecret).update(body).digest('hex')
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

app.get('/status', async (c) => c.json({ running: containers?.getRunning() ?? [], queueDepth: await queue?.depth() ?? 0 }))

app.post('/webhooks/plane', async (c) => {
  const rawBody = await c.req.text()
  const signature = c.req.header('x-plane-signature') ?? c.req.header('x-webhook-signature')

  if (!verifyWebhookSignature(rawBody, signature ?? null)) {
    return c.json({ error: 'invalid signature' }, 401)
  }

  const payload: PlaneWebhookPayload = JSON.parse(rawBody)
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

  // Update Plane issue status
  if (plane) {
    try {
      await plane.addComment(
        payload.data.workspace, payload.data.project, payload.data.id,
        `Agent ${agentConfig.name} picked up this issue.`
      )
    } catch (err) {
      console.error('[plane] Failed to post comment:', err)
    }
  }

  const running = containers.getRunningCount(agentConfig.name)
  if (running >= agentConfig.maxConcurrency) {
    await queue.enqueue(task)
    console.log(`[queue] Task ${task.id} queued (${agentConfig.name} at capacity)`)
    return c.json({ queued: true, taskId: task.id })
  }

  const secrets = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    PLANE_API_URL: process.env.PLANE_API_URL ?? '',
    PLANE_API_TOKEN: process.env.PLANE_API_TOKEN ?? '',
    REPO_URL: process.env.REPO_URL ?? '',
  }
  const containerId = await containers.runAgent(agentConfig, task, secrets)
  console.log(`[dispatch] Agent ${agentConfig.name} started: ${containerId}`)

  return c.json({ dispatched: true, taskId: task.id, containerId })
})

export default app

// Server startup when run directly
const isMainModule = !process.argv[1] || process.argv[1].includes('index')
if (isMainModule && process.env.NODE_ENV !== 'test') {
  const { serve } = await import('@hono/node-server')
  const { default: Dockerode } = await import('dockerode')
  const { default: Redis } = await import('ioredis')
  const { loadAgentConfigs, Dispatcher: DispatcherClass } = await import('./config.js')

  const port = parseInt(process.env.PORT || '4000')
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
  const docker = new Dockerode()
  const agents = loadAgentConfigs(process.env.AGENTS_CONFIG || './config/agents.yaml')
  const planeClient = new PlaneClient(
    process.env.PLANE_API_URL || 'http://localhost:8000',
    process.env.PLANE_API_TOKEN || ''
  )

  init({
    dispatcher: new DispatcherClass(agents),
    queue: new TaskQueue(redis),
    containers: new ContainerManager(docker),
    plane: planeClient,
    webhookSecret: process.env.WEBHOOK_SECRET,
  })

  serve({ fetch: app.fetch, port }, () => {
    console.log(`Orchestrator listening on port ${port}`)
  })
}
