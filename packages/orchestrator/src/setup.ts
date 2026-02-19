import { randomBytes } from 'crypto'
import { PlaneClient } from './plane-client.js'

export interface BootstrapOptions {
  planeUrl: string
  apiToken: string
  workspaceSlug: string
  webhookUrl: string
  redis: any
}

export interface BootstrapResult {
  webhookId: string
  webhookSecret: string
  memberCount: number
}

export async function bootstrapWorkspace(opts: BootstrapOptions): Promise<BootstrapResult> {
  const { planeUrl, apiToken, workspaceSlug, webhookUrl, redis } = opts
  const client = new PlaneClient(planeUrl, apiToken)

  // Validate credentials — throws if invalid
  const members = await client.getWorkspaceMembers(workspaceSlug)

  // Generate webhook signing secret
  const webhookSecret = randomBytes(32).toString('hex')

  // Register webhook in Plane
  const webhook = await client.registerWebhook(workspaceSlug, webhookUrl, webhookSecret)

  // Persist config in Redis under the workspace namespace
  if (redis) {
    const key = `zenova:settings:${workspaceSlug}`
    await redis.hset(key, 'PLANE_API_URL', planeUrl)
    await redis.hset(key, 'PLANE_API_TOKEN', apiToken)
    await redis.hset(key, 'WEBHOOK_SECRET', webhookSecret)
    await redis.hset(key, 'WEBHOOK_ID', webhook.id)
  }

  return {
    webhookId: webhook.id,
    webhookSecret,
    memberCount: Array.isArray(members) ? members.length : 0,
  }
}
