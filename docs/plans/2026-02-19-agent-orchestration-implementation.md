# Zenova Agent Orchestration Platform - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a webhook-driven AI agent orchestration platform on Plane.so that lets engineers assign issues to AI agents, which autonomously execute work in Docker containers and submit PRs for review.

**Architecture:** Plane.so serves as the central hub. A lightweight Node.js/TypeScript orchestrator receives Plane webhooks, routes issues to specialized agent pools, and manages Docker container lifecycle. Each agent type runs in an isolated container with its own toolset. Redis backs the priority queue and state tracking.

**Tech Stack:** Node.js, TypeScript, Hono (HTTP), Redis (queue), Docker/dockerode (containers), Plane.so API, GitHub CLI

---

## Phase 1: Project Scaffolding & Local Plane.so

### Task 1: Initialize monorepo and install base dependencies

**Files:**
- Create: `package.json` (root workspace)
- Create: `packages/orchestrator/package.json`
- Create: `packages/orchestrator/tsconfig.json`
- Create: `.gitignore`

**Step 1: Initialize git repo**

```bash
cd /workspace/zenova-agents
git init
```

**Step 2: Create root package.json with workspaces**

```json
{
  "name": "zenova-agents",
  "private": true,
  "workspaces": ["packages/*"]
}
```

**Step 3: Create orchestrator package.json**

```json
{
  "name": "@zenova/orchestrator",
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest"
  },
  "dependencies": {
    "hono": "^4.7.0",
    "dockerode": "^4.0.0",
    "ioredis": "^5.4.0",
    "yaml": "^2.7.0"
  },
  "devDependencies": {
    "@types/dockerode": "^3.3.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

**Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 5: Create .gitignore**

```
node_modules/
dist/
.env
*.log
```

**Step 6: Install dependencies**

```bash
cd /workspace/zenova-agents
npm install
```

**Step 7: Commit**

```bash
git add -A
git commit -m "chore: initialize monorepo with orchestrator package"
```

---

### Task 2: Docker Compose for local development (Plane.so + Redis)

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`

**Step 1: Create docker-compose.yml with Plane.so stack + Redis**

Plane.so requires: PostgreSQL, Redis, MinIO, web, API, worker, beat-worker, space.

```yaml
version: "3.8"

x-plane-env: &plane-env
  DATABASE_URL: postgresql://plane:plane@plane-db:5432/plane
  REDIS_URL: redis://redis:6379/
  SECRET_KEY: supersecretkey-change-in-production
  AWS_S3_ENDPOINT_URL: http://minio:9000
  AWS_ACCESS_KEY_ID: access-key
  AWS_SECRET_ACCESS_KEY: secret-key
  AWS_S3_BUCKET_NAME: plane-uploads
  AWS_REGION: us-east-1
  MINIO_ROOT_USER: access-key
  MINIO_ROOT_PASSWORD: secret-key
  WEB_URL: http://localhost:3000
  CORS_ALLOWED_ORIGINS: http://localhost:3000
  ENABLE_SIGNUP: "1"
  ENABLE_EMAIL_PASSWORD: "1"
  GUNICORN_WORKERS: 2

services:
  # --- Plane.so Services ---
  plane-db:
    image: postgres:15
    restart: unless-stopped
    environment:
      POSTGRES_USER: plane
      POSTGRES_PASSWORD: plane
      POSTGRES_DB: plane
    volumes:
      - plane-db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U plane"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis-data:/data
    ports:
      - "6379:6379"

  minio:
    image: minio/minio:latest
    restart: unless-stopped
    command: server /data --console-address ":9090"
    environment:
      MINIO_ROOT_USER: access-key
      MINIO_ROOT_PASSWORD: secret-key
    volumes:
      - minio-data:/data

  plane-api:
    image: makeplane/plane-backend:latest
    restart: unless-stopped
    command: ./bin/docker-entrypoint-api.sh
    environment:
      <<: *plane-env
    depends_on:
      plane-db:
        condition: service_healthy
      redis:
        condition: service_started

  plane-worker:
    image: makeplane/plane-backend:latest
    restart: unless-stopped
    command: ./bin/docker-entrypoint-worker.sh
    environment:
      <<: *plane-env
    depends_on:
      plane-db:
        condition: service_healthy
      redis:
        condition: service_started

  plane-beat:
    image: makeplane/plane-backend:latest
    restart: unless-stopped
    command: ./bin/docker-entrypoint-beat.sh
    environment:
      <<: *plane-env
    depends_on:
      plane-db:
        condition: service_healthy
      redis:
        condition: service_started

  plane-web:
    image: makeplane/plane-frontend:latest
    restart: unless-stopped
    environment:
      NEXT_PUBLIC_API_BASE_URL: http://localhost:8000
    ports:
      - "3000:3000"
    depends_on:
      - plane-api

  plane-space:
    image: makeplane/plane-space:latest
    restart: unless-stopped
    environment:
      NEXT_PUBLIC_API_BASE_URL: http://localhost:8000
    ports:
      - "3001:3000"

  # --- Zenova Orchestrator ---
  orchestrator:
    build:
      context: ./packages/orchestrator
      dockerfile: Dockerfile
    restart: unless-stopped
    ports:
      - "4000:4000"
    environment:
      PORT: 4000
      REDIS_URL: redis://redis:6379/1
      PLANE_API_URL: http://plane-api:8000
      PLANE_API_TOKEN: ${PLANE_API_TOKEN}
      GITHUB_TOKEN: ${GITHUB_TOKEN}
      DOCKER_HOST: unix:///var/run/docker.sock
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on:
      - redis
      - plane-api

volumes:
  plane-db-data:
  redis-data:
  minio-data:
```

**Step 2: Create .env.example**

```env
# Plane.so
PLANE_API_TOKEN=your-plane-api-token-here

# GitHub
GITHUB_TOKEN=your-github-token-here

# AI Providers (OAuth preferred)
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key

# Optional overrides
ORCHESTRATOR_PORT=4000
```

**Step 3: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "chore: add docker-compose with Plane.so stack and orchestrator"
```

---

## Phase 2: Orchestrator Core

### Task 3: Webhook receiver and health check

**Files:**
- Create: `packages/orchestrator/src/index.ts`
- Create: `packages/orchestrator/src/types.ts`
- Test: `packages/orchestrator/src/__tests__/index.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/orchestrator/src/__tests__/index.test.ts
import { describe, it, expect } from 'vitest'

describe('orchestrator server', () => {
  it('health check returns ok', async () => {
    const { app } = await import('../index.js')
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
  })

  it('webhook endpoint accepts POST', async () => {
    const { app } = await import('../index.js')
    const res = await app.request('/webhooks/plane', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'issue.updated', data: {} })
    })
    expect(res.status).toBe(200)
  })
})
```

**Step 2: Run test to verify it fails**

```bash
cd /workspace/zenova-agents/packages/orchestrator
npx vitest run src/__tests__/index.test.ts
```
Expected: FAIL — module not found

**Step 3: Create types.ts**

```typescript
// packages/orchestrator/src/types.ts
export interface PlaneWebhookPayload {
  event: string
  action: string
  data: {
    id: string
    name: string
    description_html?: string
    description_stripped?: string
    priority: 'urgent' | 'high' | 'medium' | 'low' | 'none'
    state: { name: string; group: string }
    assignees: string[]
    labels: Array<{ id: string; name: string }>
    project: string
    workspace: string
  }
}

export interface AgentConfig {
  name: string
  assigneeId: string
  dockerImage: string
  tools: string[]
  timeout: number       // seconds
  maxConcurrency: number
  promptFile: string
}

export interface QueuedTask {
  id: string
  issueId: string
  projectId: string
  workspaceSlug: string
  agentType: string
  priority: number  // 0=urgent, 1=high, 2=medium, 3=low
  payload: PlaneWebhookPayload['data']
  queuedAt: string
}

export interface RunningAgent {
  taskId: string
  containerId: string
  agentType: string
  issueId: string
  startedAt: string
}
```

**Step 4: Create index.ts**

```typescript
// packages/orchestrator/src/index.ts
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

  // TODO: Route to queue
  return c.json({ received: true })
})

// Only start server when run directly (not imported in tests)
const isMainModule = process.argv[1]?.includes('index')
if (isMainModule) {
  const port = parseInt(process.env.PORT || '4000')
  console.log(`Orchestrator listening on port ${port}`)
  Bun?.serve?.({ fetch: app.fetch, port }) // fallback below
}

export default app
```

**Step 5: Run tests**

```bash
npx vitest run src/__tests__/index.test.ts
```
Expected: PASS

**Step 6: Commit**

```bash
git add packages/orchestrator/src/
git commit -m "feat: add orchestrator with health check and webhook endpoint"
```

---

### Task 4: Plane API client (read issues, update status, post comments)

**Files:**
- Create: `packages/orchestrator/src/plane-client.ts`
- Test: `packages/orchestrator/src/__tests__/plane-client.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/orchestrator/src/__tests__/plane-client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PlaneClient } from '../plane-client.js'

const mockFetch = vi.fn()
global.fetch = mockFetch

describe('PlaneClient', () => {
  let client: PlaneClient

  beforeEach(() => {
    client = new PlaneClient('http://plane-api:8000', 'test-token')
    mockFetch.mockReset()
  })

  it('updates issue state', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'issue-1', state: 'state-2' })
    })

    await client.updateIssueState('ws-slug', 'proj-1', 'issue-1', 'state-2')

    expect(mockFetch).toHaveBeenCalledWith(
      'http://plane-api:8000/api/v1/workspaces/ws-slug/projects/proj-1/issues/issue-1/',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ state: 'state-2' })
      })
    )
  })

  it('posts a comment to an issue', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'comment-1' })
    })

    await client.addComment('ws-slug', 'proj-1', 'issue-1', 'Agent started working')

    expect(mockFetch).toHaveBeenCalledWith(
      'http://plane-api:8000/api/v1/workspaces/ws-slug/projects/proj-1/issues/issue-1/comments/',
      expect.objectContaining({
        method: 'POST'
      })
    )
  })

  it('fetches issue details', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'issue-1', name: 'Build login page' })
    })

    const issue = await client.getIssue('ws-slug', 'proj-1', 'issue-1')
    expect(issue.name).toBe('Build login page')
  })
})
```

**Step 2: Run test — verify FAIL**

```bash
npx vitest run src/__tests__/plane-client.test.ts
```

**Step 3: Implement PlaneClient**

```typescript
// packages/orchestrator/src/plane-client.ts
export class PlaneClient {
  constructor(
    private baseUrl: string,
    private apiToken: string
  ) {}

  private headers() {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiToken,
    }
  }

  private url(path: string) {
    return `${this.baseUrl}${path}`
  }

  async getIssue(workspaceSlug: string, projectId: string, issueId: string) {
    const res = await fetch(
      this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/`),
      { headers: this.headers() }
    )
    if (!res.ok) throw new Error(`Failed to get issue: ${res.status}`)
    return res.json()
  }

  async updateIssueState(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    stateId: string
  ) {
    const res = await fetch(
      this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/`),
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ state: stateId }),
      }
    )
    if (!res.ok) throw new Error(`Failed to update issue state: ${res.status}`)
    return res.json()
  }

  async addComment(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    comment: string
  ) {
    const res = await fetch(
      this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ comment_html: `<p>${comment}</p>` }),
      }
    )
    if (!res.ok) throw new Error(`Failed to add comment: ${res.status}`)
    return res.json()
  }

  async addIssueLink(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    url: string,
    title: string
  ) {
    const res = await fetch(
      this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/links/`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ url, title }),
      }
    )
    if (!res.ok) throw new Error(`Failed to add link: ${res.status}`)
    return res.json()
  }

  async getProjectStates(workspaceSlug: string, projectId: string) {
    const res = await fetch(
      this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/states/`),
      { headers: this.headers() }
    )
    if (!res.ok) throw new Error(`Failed to get states: ${res.status}`)
    return res.json()
  }
}
```

**Step 4: Run tests — verify PASS**

```bash
npx vitest run src/__tests__/plane-client.test.ts
```

**Step 5: Commit**

```bash
git add packages/orchestrator/src/plane-client.ts packages/orchestrator/src/__tests__/plane-client.test.ts
git commit -m "feat: add Plane API client for issue updates and comments"
```

---

### Task 5: Router — map issue assignee/labels to agent type

**Files:**
- Create: `packages/orchestrator/src/router.ts`
- Create: `config/agents.yaml`
- Test: `packages/orchestrator/src/__tests__/router.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/orchestrator/src/__tests__/router.test.ts
import { describe, it, expect } from 'vitest'
import { AgentRouter } from '../router.js'
import type { AgentConfig } from '../types.js'

const agents: AgentConfig[] = [
  {
    name: 'dev',
    assigneeId: 'agent-dev-id',
    dockerImage: 'zenova/agent-dev:latest',
    tools: ['claude-code', 'codex', 'git'],
    timeout: 1800,
    maxConcurrency: 3,
    promptFile: 'agents/dev/prompt.md',
  },
  {
    name: 'creative',
    assigneeId: 'agent-creative-id',
    dockerImage: 'zenova/agent-creative:latest',
    tools: ['openai-dalle', 'openai-gpt'],
    timeout: 900,
    maxConcurrency: 2,
    promptFile: 'agents/creative/prompt.md',
  },
]

describe('AgentRouter', () => {
  const router = new AgentRouter(agents)

  it('routes by assignee ID', () => {
    const config = router.routeByAssignee('agent-dev-id')
    expect(config?.name).toBe('dev')
  })

  it('routes by label name', () => {
    const config = router.routeByLabel('creative')
    expect(config?.name).toBe('creative')
  })

  it('returns undefined for unknown assignee', () => {
    const config = router.routeByAssignee('unknown-id')
    expect(config).toBeUndefined()
  })

  it('resolves agent from issue data (assignee takes priority)', () => {
    const config = router.resolve({
      assignees: ['agent-dev-id'],
      labels: [{ id: 'l1', name: 'creative' }],
    })
    expect(config?.name).toBe('dev')
  })

  it('falls back to label when no assignee matches', () => {
    const config = router.resolve({
      assignees: ['some-human-id'],
      labels: [{ id: 'l1', name: 'creative' }],
    })
    expect(config?.name).toBe('creative')
  })
})
```

**Step 2: Run test — verify FAIL**

**Step 3: Implement router**

```typescript
// packages/orchestrator/src/router.ts
import type { AgentConfig } from './types.js'

export class AgentRouter {
  private byAssignee: Map<string, AgentConfig>
  private byLabel: Map<string, AgentConfig>

  constructor(private agents: AgentConfig[]) {
    this.byAssignee = new Map(agents.map((a) => [a.assigneeId, a]))
    this.byLabel = new Map(agents.map((a) => [a.name, a]))
  }

  routeByAssignee(assigneeId: string): AgentConfig | undefined {
    return this.byAssignee.get(assigneeId)
  }

  routeByLabel(labelName: string): AgentConfig | undefined {
    return this.byLabel.get(labelName.toLowerCase())
  }

  resolve(issue: {
    assignees: string[]
    labels: Array<{ id: string; name: string }>
  }): AgentConfig | undefined {
    // Assignee match takes priority
    for (const assigneeId of issue.assignees) {
      const config = this.routeByAssignee(assigneeId)
      if (config) return config
    }
    // Fall back to label match
    for (const label of issue.labels) {
      const config = this.routeByLabel(label.name)
      if (config) return config
    }
    return undefined
  }
}
```

**Step 4: Create agents.yaml**

```yaml
# config/agents.yaml
# Agent type definitions — add new agents here, no orchestrator code changes needed.

agents:
  - name: dev
    assigneeId: "" # Set after creating agent user in Plane
    dockerImage: zenova/agent-dev:latest
    tools:
      - claude-code
      - codex
      - git
      - gh-cli
    timeout: 1800 # 30 minutes
    maxConcurrency: 3
    promptFile: packages/agents/dev/prompt.md

  - name: creative
    assigneeId: ""
    dockerImage: zenova/agent-creative:latest
    tools:
      - openai-dalle
      - openai-gpt
    timeout: 900
    maxConcurrency: 2
    promptFile: packages/agents/creative/prompt.md

  - name: strategy
    assigneeId: ""
    dockerImage: zenova/agent-strategy:latest
    tools:
      - claude-api
      - web-search
    timeout: 1200
    maxConcurrency: 2
    promptFile: packages/agents/strategy/prompt.md

  - name: landing
    assigneeId: ""
    dockerImage: zenova/agent-landing:latest
    tools:
      - claude-code
      - git
    timeout: 2400 # 40 minutes — landing pages take longer
    maxConcurrency: 2
    promptFile: packages/agents/landing/prompt.md
```

**Step 5: Run tests — verify PASS**

**Step 6: Commit**

```bash
git add packages/orchestrator/src/router.ts packages/orchestrator/src/__tests__/router.test.ts config/agents.yaml
git commit -m "feat: add agent router with assignee and label-based routing"
```

---

### Task 6: Priority queue (Redis-backed)

**Files:**
- Create: `packages/orchestrator/src/queue.ts`
- Test: `packages/orchestrator/src/__tests__/queue.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/orchestrator/src/__tests__/queue.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { TaskQueue } from '../queue.js'
import type { QueuedTask } from '../types.js'

// In-memory Redis mock for tests
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
    if (!list || list.length === 0) return null
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

describe('TaskQueue', () => {
  let queue: TaskQueue

  beforeEach(() => {
    queue = new TaskQueue(new MockRedis() as any)
  })

  it('enqueues a task', async () => {
    const task: QueuedTask = {
      id: 'task-1',
      issueId: 'issue-1',
      projectId: 'proj-1',
      workspaceSlug: 'ws',
      agentType: 'dev',
      priority: 2,
      payload: {} as any,
      queuedAt: new Date().toISOString(),
    }

    await queue.enqueue(task)
    const depth = await queue.depth()
    expect(depth).toBe(1)
  })

  it('dequeues highest priority first (lowest number)', async () => {
    await queue.enqueue(makeTask('t1', 2)) // medium
    await queue.enqueue(makeTask('t2', 0)) // urgent
    await queue.enqueue(makeTask('t3', 1)) // high

    const next = await queue.dequeue()
    expect(next?.id).toBe('t2') // urgent first
  })

  it('returns null when queue is empty', async () => {
    const next = await queue.dequeue()
    expect(next).toBeNull()
  })
})

function makeTask(id: string, priority: number): QueuedTask {
  return {
    id,
    issueId: `issue-${id}`,
    projectId: 'proj-1',
    workspaceSlug: 'ws',
    agentType: 'dev',
    priority,
    payload: {} as any,
    queuedAt: new Date().toISOString(),
  }
}
```

**Step 2: Run test — verify FAIL**

**Step 3: Implement queue**

```typescript
// packages/orchestrator/src/queue.ts
import type { Redis } from 'ioredis'
import type { QueuedTask } from './types.js'

const QUEUE_KEY = 'zenova:task-queue'
const TASK_PREFIX = 'zenova:task:'

export class TaskQueue {
  constructor(private redis: Redis) {}

  async enqueue(task: QueuedTask): Promise<void> {
    // Store full task data
    await this.redis.set(`${TASK_PREFIX}${task.id}`, JSON.stringify(task))
    // Add to sorted set with priority as score
    await this.redis.zadd(QUEUE_KEY, task.priority, task.id)
  }

  async dequeue(): Promise<QueuedTask | null> {
    const result = await this.redis.zpopmin(QUEUE_KEY)
    if (!result || result.length === 0) return null

    const taskId = result[0] as string
    const data = await this.redis.get(`${TASK_PREFIX}${taskId}`)
    if (!data) return null

    await this.redis.del(`${TASK_PREFIX}${taskId}`)
    return JSON.parse(data)
  }

  async depth(): Promise<number> {
    return this.redis.zcard(QUEUE_KEY)
  }

  async peek(count = 10): Promise<string[]> {
    return this.redis.zrange(QUEUE_KEY, 0, count - 1)
  }
}
```

**Step 4: Run tests — verify PASS**

**Step 5: Commit**

```bash
git add packages/orchestrator/src/queue.ts packages/orchestrator/src/__tests__/queue.test.ts
git commit -m "feat: add Redis-backed priority queue for agent tasks"
```

---

### Task 7: Docker container manager (dockerode)

**Files:**
- Create: `packages/orchestrator/src/docker.ts`
- Test: `packages/orchestrator/src/__tests__/docker.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/orchestrator/src/__tests__/docker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContainerManager } from '../docker.js'
import type { AgentConfig, QueuedTask } from '../types.js'

// Mock dockerode
const mockContainer = {
  start: vi.fn(),
  wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
  logs: vi.fn().mockResolvedValue('agent output'),
  remove: vi.fn(),
  id: 'container-123',
}

const mockDocker = {
  createContainer: vi.fn().mockResolvedValue(mockContainer),
}

describe('ContainerManager', () => {
  let manager: ContainerManager

  beforeEach(() => {
    manager = new ContainerManager(mockDocker as any)
    vi.clearAllMocks()
  })

  it('creates a container with correct image and env vars', async () => {
    const agent: AgentConfig = {
      name: 'dev',
      assigneeId: 'a1',
      dockerImage: 'zenova/agent-dev:latest',
      tools: ['claude-code'],
      timeout: 1800,
      maxConcurrency: 3,
      promptFile: 'agents/dev/prompt.md',
    }

    const task: QueuedTask = {
      id: 'task-1',
      issueId: 'issue-1',
      projectId: 'proj-1',
      workspaceSlug: 'ws',
      agentType: 'dev',
      priority: 2,
      payload: { name: 'Build login page' } as any,
      queuedAt: new Date().toISOString(),
    }

    const containerId = await manager.runAgent(agent, task, {
      GITHUB_TOKEN: 'gh-token',
      ANTHROPIC_API_KEY: 'anth-key',
    })

    expect(mockDocker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Image: 'zenova/agent-dev:latest',
        name: expect.stringContaining('zenova-agent-'),
      })
    )
    expect(mockContainer.start).toHaveBeenCalled()
    expect(containerId).toBe('container-123')
  })

  it('tracks running containers', async () => {
    const agent: AgentConfig = {
      name: 'dev',
      assigneeId: 'a1',
      dockerImage: 'zenova/agent-dev:latest',
      tools: ['claude-code'],
      timeout: 1800,
      maxConcurrency: 3,
      promptFile: 'agents/dev/prompt.md',
    }

    const task: QueuedTask = {
      id: 'task-1',
      issueId: 'issue-1',
      projectId: 'proj-1',
      workspaceSlug: 'ws',
      agentType: 'dev',
      priority: 2,
      payload: {} as any,
      queuedAt: new Date().toISOString(),
    }

    await manager.runAgent(agent, task, {})
    expect(manager.getRunningCount('dev')).toBe(1)
  })
})
```

**Step 2: Run test — verify FAIL**

**Step 3: Implement ContainerManager**

```typescript
// packages/orchestrator/src/docker.ts
import type Dockerode from 'dockerode'
import type { AgentConfig, QueuedTask, RunningAgent } from './types.js'

export class ContainerManager {
  private running = new Map<string, RunningAgent>()

  constructor(private docker: Dockerode) {}

  async runAgent(
    agent: AgentConfig,
    task: QueuedTask,
    secrets: Record<string, string>
  ): Promise<string> {
    const containerName = `zenova-agent-${agent.name}-${task.id}-${Date.now()}`

    const env = [
      `TASK_ID=${task.id}`,
      `ISSUE_ID=${task.issueId}`,
      `PROJECT_ID=${task.projectId}`,
      `WORKSPACE_SLUG=${task.workspaceSlug}`,
      `ISSUE_TITLE=${task.payload.name || ''}`,
      `ISSUE_DESCRIPTION=${task.payload.description_stripped || ''}`,
      `AGENT_TYPE=${agent.name}`,
      ...Object.entries(secrets).map(([k, v]) => `${k}=${v}`),
    ]

    const container = await this.docker.createContainer({
      Image: agent.dockerImage,
      name: containerName,
      Env: env,
      HostConfig: {
        Memory: 2 * 1024 * 1024 * 1024, // 2GB
        NanoCpus: 2 * 1e9,               // 2 CPUs
        AutoRemove: false,
      },
    })

    await container.start()

    this.running.set(task.id, {
      taskId: task.id,
      containerId: container.id,
      agentType: agent.name,
      issueId: task.issueId,
      startedAt: new Date().toISOString(),
    })

    // Set timeout to kill container if it runs too long
    setTimeout(async () => {
      if (this.running.has(task.id)) {
        try {
          const c = this.docker.getContainer(container.id)
          await c.stop({ t: 10 })
          await c.remove()
        } catch {
          // Container may have already stopped
        }
        this.running.delete(task.id)
      }
    }, agent.timeout * 1000)

    return container.id
  }

  getRunningCount(agentType: string): number {
    return [...this.running.values()].filter(
      (r) => r.agentType === agentType
    ).length
  }

  getRunning(): RunningAgent[] {
    return [...this.running.values()]
  }

  markCompleted(taskId: string): void {
    this.running.delete(taskId)
  }
}
```

**Step 4: Run tests — verify PASS**

**Step 5: Commit**

```bash
git add packages/orchestrator/src/docker.ts packages/orchestrator/src/__tests__/docker.test.ts
git commit -m "feat: add Docker container manager for agent lifecycle"
```

---

### Task 8: Wire everything together — webhook handler dispatches to queue and containers

**Files:**
- Modify: `packages/orchestrator/src/index.ts`
- Create: `packages/orchestrator/src/config.ts`
- Test: `packages/orchestrator/src/__tests__/dispatch.test.ts`

**Step 1: Write the failing integration test**

```typescript
// packages/orchestrator/src/__tests__/dispatch.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Dispatcher } from '../config.js'
import type { AgentConfig, PlaneWebhookPayload } from '../types.js'

describe('Dispatcher', () => {
  it('identifies an agent-assignable issue', () => {
    const agents: AgentConfig[] = [
      {
        name: 'dev',
        assigneeId: 'agent-dev-uuid',
        dockerImage: 'zenova/agent-dev',
        tools: [],
        timeout: 1800,
        maxConcurrency: 3,
        promptFile: '',
      },
    ]

    const dispatcher = new Dispatcher(agents)

    const payload: PlaneWebhookPayload = {
      event: 'issue',
      action: 'updated',
      data: {
        id: 'issue-1',
        name: 'Build auth system',
        priority: 'high',
        state: { name: 'Todo', group: 'backlog' },
        assignees: ['agent-dev-uuid'],
        labels: [],
        project: 'proj-1',
        workspace: 'ws-1',
      },
    }

    const result = dispatcher.shouldDispatch(payload)
    expect(result).not.toBeNull()
    expect(result!.agentConfig.name).toBe('dev')
  })

  it('ignores issues not assigned to agents', () => {
    const agents: AgentConfig[] = [
      {
        name: 'dev',
        assigneeId: 'agent-dev-uuid',
        dockerImage: 'zenova/agent-dev',
        tools: [],
        timeout: 1800,
        maxConcurrency: 3,
        promptFile: '',
      },
    ]

    const dispatcher = new Dispatcher(agents)

    const payload: PlaneWebhookPayload = {
      event: 'issue',
      action: 'updated',
      data: {
        id: 'issue-2',
        name: 'Human task',
        priority: 'medium',
        state: { name: 'Todo', group: 'backlog' },
        assignees: ['human-user-uuid'],
        labels: [],
        project: 'proj-1',
        workspace: 'ws-1',
      },
    }

    const result = dispatcher.shouldDispatch(payload)
    expect(result).toBeNull()
  })
})
```

**Step 2: Run test — verify FAIL**

**Step 3: Implement Dispatcher in config.ts**

```typescript
// packages/orchestrator/src/config.ts
import { readFileSync } from 'fs'
import { parse } from 'yaml'
import { AgentRouter } from './router.js'
import type { AgentConfig, PlaneWebhookPayload } from './types.js'

export function loadAgentConfigs(configPath: string): AgentConfig[] {
  const raw = readFileSync(configPath, 'utf-8')
  const parsed = parse(raw)
  return parsed.agents as AgentConfig[]
}

const PRIORITY_MAP: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
}

export class Dispatcher {
  private router: AgentRouter

  constructor(private agents: AgentConfig[]) {
    this.router = new AgentRouter(agents)
  }

  shouldDispatch(
    payload: PlaneWebhookPayload
  ): { agentConfig: AgentConfig; priority: number } | null {
    const { data } = payload

    // Only handle issue events
    if (payload.event !== 'issue') return null

    // Route to agent
    const agentConfig = this.router.resolve({
      assignees: data.assignees,
      labels: data.labels,
    })

    if (!agentConfig) return null

    const priority = PRIORITY_MAP[data.priority] ?? 2

    return { agentConfig, priority }
  }
}
```

**Step 4: Update index.ts to wire dispatcher + queue + containers**

```typescript
// packages/orchestrator/src/index.ts
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import type { PlaneWebhookPayload, QueuedTask } from './types.js'
import { Dispatcher } from './config.js'
import { TaskQueue } from './queue.js'
import { ContainerManager } from './docker.js'
import { PlaneClient } from './plane-client.js'
import { randomUUID } from 'crypto'

export const app = new Hono()
app.use('*', logger())

// These get initialized at startup (see bottom)
let dispatcher: Dispatcher | null = null
let queue: TaskQueue | null = null
let containers: ContainerManager | null = null
let plane: PlaneClient | null = null

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    queue: queue ? 'connected' : 'disconnected',
  })
})

app.get('/status', async (c) => {
  return c.json({
    running: containers?.getRunning() ?? [],
    queueDepth: await queue?.depth() ?? 0,
  })
})

app.post('/webhooks/plane', async (c) => {
  const payload = await c.req.json<PlaneWebhookPayload>()
  console.log(`[webhook] ${payload.event}.${payload.action}`)

  if (!dispatcher || !queue || !containers) {
    return c.json({ error: 'not initialized' }, 503)
  }

  const match = dispatcher.shouldDispatch(payload)
  if (!match) {
    return c.json({ skipped: true, reason: 'no matching agent' })
  }

  const { agentConfig, priority } = match

  // Check concurrency
  const running = containers.getRunningCount(agentConfig.name)
  const task: QueuedTask = {
    id: randomUUID(),
    issueId: payload.data.id,
    projectId: payload.data.project,
    workspaceSlug: payload.data.workspace,
    agentType: agentConfig.name,
    priority,
    payload: payload.data,
    queuedAt: new Date().toISOString(),
  }

  if (running >= agentConfig.maxConcurrency) {
    // Queue for later
    await queue.enqueue(task)
    console.log(`[queue] Task ${task.id} queued (${agentConfig.name} at capacity)`)
    return c.json({ queued: true, taskId: task.id })
  }

  // Dispatch immediately
  const secrets = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    PLANE_API_URL: process.env.PLANE_API_URL ?? '',
    PLANE_API_TOKEN: process.env.PLANE_API_TOKEN ?? '',
  }

  const containerId = await containers.runAgent(agentConfig, task, secrets)
  console.log(`[dispatch] Agent ${agentConfig.name} started: ${containerId}`)

  return c.json({ dispatched: true, taskId: task.id, containerId })
})

export default app
```

**Step 5: Run tests — verify PASS**

```bash
npx vitest run
```

**Step 6: Commit**

```bash
git add packages/orchestrator/src/
git commit -m "feat: wire webhook handler to dispatcher, queue, and container manager"
```

---

## Phase 3: Agent Containers

### Task 9: Dev agent Docker image

**Files:**
- Create: `packages/agents/dev/Dockerfile`
- Create: `packages/agents/dev/entrypoint.sh`
- Create: `packages/agents/dev/prompt.md`

**Step 1: Create the dev agent Dockerfile**

```dockerfile
# packages/agents/dev/Dockerfile
FROM node:22-slim

# Install system deps
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Working directory for agent operations
WORKDIR /workspace

COPY entrypoint.sh /entrypoint.sh
COPY prompt.md /agent/prompt.md
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
```

**Step 2: Create entrypoint.sh**

```bash
#!/bin/bash
# packages/agents/dev/entrypoint.sh
set -euo pipefail

echo "=== Zenova Dev Agent Starting ==="
echo "Task ID: ${TASK_ID}"
echo "Issue: ${ISSUE_TITLE}"

# Authenticate GitHub CLI
echo "${GITHUB_TOKEN}" | gh auth login --with-token

# Clone the target repo (passed via env)
REPO_URL="${REPO_URL:-}"
if [ -n "$REPO_URL" ]; then
  git clone "$REPO_URL" /workspace/repo
  cd /workspace/repo
fi

# Create branch for this task
BRANCH_NAME="agent/${AGENT_TYPE}/${TASK_ID}"
git checkout -b "$BRANCH_NAME"

# Build the prompt from issue context
PROMPT="$(cat /agent/prompt.md)

## Current Task

**Issue:** ${ISSUE_TITLE}

**Description:**
${ISSUE_DESCRIPTION}

**Instructions:** Work on this task. Create all necessary changes. When done, commit and push your branch, then create a pull request."

# Run Claude Code CLI with the prompt
claude --print --dangerously-skip-permissions "$PROMPT"

# Push and create PR
git push origin "$BRANCH_NAME"
PR_URL=$(gh pr create \
  --title "[Agent] ${ISSUE_TITLE}" \
  --body "Automated by Zenova Dev Agent\n\nTask: ${TASK_ID}\nIssue: ${ISSUE_ID}" \
  --head "$BRANCH_NAME" \
  2>&1)

echo "PR created: $PR_URL"

# Report back to orchestrator (via Plane API)
if [ -n "$PLANE_API_URL" ] && [ -n "$PLANE_API_TOKEN" ]; then
  # Add PR link to issue
  curl -s -X POST \
    "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/links/" \
    -H "X-API-Key: ${PLANE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"${PR_URL}\", \"title\": \"Pull Request\"}"

  # Add completion comment
  curl -s -X POST \
    "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/comments/" \
    -H "X-API-Key: ${PLANE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"comment_html\": \"<p>Dev agent completed. PR: ${PR_URL}</p>\"}"
fi

echo "=== Dev Agent Complete ==="
```

**Step 3: Create prompt.md**

```markdown
# Zenova Dev Agent

You are a software development agent working for Six Zenith Digital. You receive tasks from the project management system and implement them autonomously.

## Rules

1. Write clean, production-quality code
2. Follow existing code conventions in the repository
3. Include appropriate tests for new functionality
4. Make atomic commits with clear messages
5. Do not modify files unrelated to the task
6. If the task is unclear, implement the most reasonable interpretation
7. Always create a working implementation — never leave placeholder code

## Workflow

1. Read and understand the task description
2. Explore the existing codebase to understand conventions
3. Implement the requested changes
4. Write tests if appropriate
5. Commit your changes
6. The entrypoint script will handle pushing and PR creation
```

**Step 4: Commit**

```bash
git add packages/agents/dev/
git commit -m "feat: add dev agent Docker image with Claude Code CLI"
```

---

### Task 10: Creative agent Docker image

**Files:**
- Create: `packages/agents/creative/Dockerfile`
- Create: `packages/agents/creative/entrypoint.sh`
- Create: `packages/agents/creative/prompt.md`

**Step 1: Create Dockerfile**

```dockerfile
# packages/agents/creative/Dockerfile
FROM python:3.12-slim

RUN apt-get update && apt-get install -y \
    git curl jq \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir openai httpx

WORKDIR /workspace

COPY entrypoint.sh /entrypoint.sh
COPY prompt.md /agent/prompt.md
COPY generate.py /agent/generate.py
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
```

**Step 2: Create generate.py (image generation script)**

```python
# packages/agents/creative/generate.py
"""Creative agent — generates images via OpenAI DALL-E and commits to repo."""
import os
import sys
import json
import httpx
from openai import OpenAI

def generate_image(prompt: str, output_path: str, size: str = "1024x1024") -> str:
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    response = client.images.generate(
        model="dall-e-3",
        prompt=prompt,
        size=size,
        n=1,
    )
    image_url = response.data[0].url
    # Download image
    img_data = httpx.get(image_url).content
    with open(output_path, "wb") as f:
        f.write(img_data)
    return output_path

if __name__ == "__main__":
    prompt = os.environ.get("ISSUE_DESCRIPTION", "")
    title = os.environ.get("ISSUE_TITLE", "generated")
    safe_title = title.lower().replace(" ", "-")[:50]
    output = f"/workspace/repo/assets/{safe_title}.png"
    os.makedirs(os.path.dirname(output), exist_ok=True)
    path = generate_image(prompt, output)
    print(f"Generated: {path}")
```

**Step 3: Create entrypoint.sh**

```bash
#!/bin/bash
# packages/agents/creative/entrypoint.sh
set -euo pipefail

echo "=== Zenova Creative Agent Starting ==="
echo "Task: ${ISSUE_TITLE}"

echo "${GITHUB_TOKEN}" | gh auth login --with-token

REPO_URL="${REPO_URL:-}"
if [ -n "$REPO_URL" ]; then
  git clone "$REPO_URL" /workspace/repo
  cd /workspace/repo
fi

BRANCH_NAME="agent/${AGENT_TYPE}/${TASK_ID}"
git checkout -b "$BRANCH_NAME"

# Run the generation script
python /agent/generate.py

# Commit and push
git add -A
git commit -m "creative: ${ISSUE_TITLE}"
git push origin "$BRANCH_NAME"

PR_URL=$(gh pr create \
  --title "[Creative] ${ISSUE_TITLE}" \
  --body "Generated by Zenova Creative Agent\n\nTask: ${TASK_ID}" \
  --head "$BRANCH_NAME" \
  2>&1)

echo "PR: $PR_URL"

# Report back
if [ -n "${PLANE_API_URL:-}" ] && [ -n "${PLANE_API_TOKEN:-}" ]; then
  curl -s -X POST \
    "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/links/" \
    -H "X-API-Key: ${PLANE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"${PR_URL}\", \"title\": \"Creative Assets PR\"}"
fi

echo "=== Creative Agent Complete ==="
```

**Step 4: Create prompt.md**

```markdown
# Zenova Creative Agent

You generate creative assets (images, graphics) for Six Zenith Digital projects.

## Capabilities
- Image generation via DALL-E 3
- Asset organization and naming
- Multiple format/size support

## Output
All generated assets are committed to the repository and submitted via PR.
```

**Step 5: Commit**

```bash
git add packages/agents/creative/
git commit -m "feat: add creative agent with DALL-E image generation"
```

---

### Task 11: Orchestrator Dockerfile

**Files:**
- Create: `packages/orchestrator/Dockerfile`

**Step 1: Create Dockerfile**

```dockerfile
# packages/orchestrator/Dockerfile
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY dist/ ./dist/

EXPOSE 4000

CMD ["node", "dist/index.js"]
```

**Step 2: Add a build step for dev (using tsx directly)**

Create a simple dev Dockerfile:

```dockerfile
# packages/orchestrator/Dockerfile.dev
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

EXPOSE 4000

CMD ["npx", "tsx", "watch", "src/index.ts"]
```

**Step 3: Commit**

```bash
git add packages/orchestrator/Dockerfile packages/orchestrator/Dockerfile.dev
git commit -m "feat: add orchestrator Dockerfiles for prod and dev"
```

---

## Phase 4: Integration & Testing

### Task 12: End-to-end local test script

**Files:**
- Create: `scripts/local-test.sh`

**Step 1: Create the test script**

```bash
#!/bin/bash
# scripts/local-test.sh
# Quick smoke test: send a fake webhook to the orchestrator
set -euo pipefail

ORCH_URL="${1:-http://localhost:4000}"

echo "=== Health Check ==="
curl -s "$ORCH_URL/health" | jq .

echo ""
echo "=== Status ==="
curl -s "$ORCH_URL/status" | jq .

echo ""
echo "=== Sending test webhook (dev agent) ==="
curl -s -X POST "$ORCH_URL/webhooks/plane" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "issue",
    "action": "updated",
    "data": {
      "id": "test-issue-001",
      "name": "Build a login page",
      "description_stripped": "Create a simple login page with email and password fields",
      "priority": "high",
      "state": {"name": "Todo", "group": "backlog"},
      "assignees": ["REPLACE-WITH-DEV-AGENT-UUID"],
      "labels": [{"id": "l1", "name": "dev"}],
      "project": "test-project",
      "workspace": "test-workspace"
    }
  }' | jq .

echo ""
echo "=== Status after dispatch ==="
curl -s "$ORCH_URL/status" | jq .
```

**Step 2: Make executable**

```bash
chmod +x scripts/local-test.sh
```

**Step 3: Commit**

```bash
git add scripts/local-test.sh
git commit -m "feat: add local smoke test script for orchestrator"
```

---

### Task 13: Run all unit tests and verify green

**Step 1: Run full test suite**

```bash
cd /workspace/zenova-agents
npx vitest run
```
Expected: All tests pass

**Step 2: Commit any fixes if needed**

---

### Task 14: Add strategy and landing agent stubs

**Files:**
- Create: `packages/agents/strategy/Dockerfile`
- Create: `packages/agents/strategy/entrypoint.sh`
- Create: `packages/agents/strategy/prompt.md`
- Create: `packages/agents/landing/Dockerfile`
- Create: `packages/agents/landing/entrypoint.sh`
- Create: `packages/agents/landing/prompt.md`

These follow the same pattern as dev/creative agents but with their respective tools. Strategy agent uses Claude API for research/writing. Landing agent uses Claude Code CLI for generating frontend code.

**Step 1: Create strategy agent (Claude API for research)**

Strategy Dockerfile: Python-based, with `anthropic` SDK installed.
Strategy entrypoint: Calls Claude API with issue description, writes markdown output, commits.

**Step 2: Create landing agent (Claude Code for frontend)**

Landing Dockerfile: Same as dev agent but with additional frontend tools (e.g., npx create-next-app).
Landing entrypoint: Similar to dev agent, focused on frontend generation.

**Step 3: Commit**

```bash
git add packages/agents/strategy/ packages/agents/landing/
git commit -m "feat: add strategy and landing page agent stubs"
```

---

## Phase 5: Deployment Preparation

### Task 15: Coolify deployment configuration

**Files:**
- Create: `coolify/docker-compose.prod.yml`
- Update: `.env.example` with production variables

**Step 1: Create production compose file** (adapted for Coolify's Docker Compose deployment)

This is the same as docker-compose.yml but with:
- Proper domain configuration for zenova.id
- Traefik/Caddy labels for HTTPS
- Volume mounts for persistent data
- Production environment variables

**Step 2: Document Coolify deployment steps in README**

**Step 3: Commit**

```bash
git add coolify/ .env.example
git commit -m "chore: add Coolify production deployment config"
```

---

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-2 | Project scaffolding + Docker Compose |
| 2 | 3-8 | Orchestrator core (webhook, API client, router, queue, containers, wiring) |
| 3 | 9-11 | Agent Docker images (dev, creative, orchestrator) |
| 4 | 12-14 | Integration testing + remaining agent stubs |
| 5 | 15 | Coolify deployment config |

**Total: 15 tasks, ~2-3 hours of implementation**
