# Zenova Connect — Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the manual webhook setup process with a one-click wizard that auto-registers agent bot users and webhooks in any Plane workspace, and make agents stream real-time activity back to Plane issues.

**Architecture:** Enhance the existing `packages/orchestrator` with setup endpoints + multi-workspace Redis namespacing. Build a `packages/connect` React/Vite wizard served directly from the orchestrator. Improve all agent Docker containers to post incremental status comments and auto-transition issue states. No new infrastructure required.

**Tech Stack:** TypeScript/Hono (orchestrator), React + Vite + Tailwind (connect wizard), Docker/bash (agent containers), Plane REST API, Redis (multi-workspace config)

---

## Task 1: Extend PlaneClient — workspace setup methods

**Files:**
- Modify: `packages/orchestrator/src/plane-client.ts`
- Modify: `packages/orchestrator/src/__tests__/plane-client.test.ts`

We need 4 new methods: `getWorkspaceMembers`, `inviteMember`, `registerWebhook`, `resolveStateByGroup`.

**Step 1: Write failing tests**

Add to `packages/orchestrator/src/__tests__/plane-client.test.ts`:

```typescript
it('lists workspace members', async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ id: 'm1', member__email: 'dev@z.io' }] }) })
  const members = await client.getWorkspaceMembers('my-workspace')
  expect(mockFetch).toHaveBeenCalledWith(
    'http://plane-api:8000/api/v1/workspaces/my-workspace/members/',
    expect.objectContaining({ headers: expect.objectContaining({ 'X-API-Key': 'test-token' }) })
  )
  expect(members).toHaveLength(1)
})

it('registers a webhook', async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'wh1', url: 'https://hook.io/webhook' }) })
  const wh = await client.registerWebhook('my-workspace', 'https://hook.io/webhook', 'my-secret')
  expect(mockFetch).toHaveBeenCalledWith(
    'http://plane-api:8000/api/v1/workspaces/my-workspace/webhooks/',
    expect.objectContaining({ method: 'POST', body: expect.stringContaining('hook.io') })
  )
  expect(wh.id).toBe('wh1')
})

it('resolves a state ID from group name', async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ([
    { id: 's1', name: 'Todo', group: 'backlog' },
    { id: 's2', name: 'In Progress', group: 'started' },
    { id: 's3', name: 'In Review', group: 'unstarted' },
  ]) })
  const stateId = await client.resolveStateByGroup('ws', 'proj-1', 'started')
  expect(stateId).toBe('s2')
})
```

**Step 2: Run to confirm fail**

```bash
cd /workspace/zenova-agents && npm test --workspace packages/orchestrator -- --reporter=verbose 2>&1 | grep -E "FAIL|PASS|Error" | head -20
```
Expected: 3 failing tests ("getWorkspaceMembers is not a function" etc.)

**Step 3: Implement the new methods**

Add to `packages/orchestrator/src/plane-client.ts` (before the closing `}`):

```typescript
async getWorkspaceMembers(workspaceSlug: string): Promise<Array<{ id: string; member__email: string; member__display_name: string }>> {
  const res = await fetch(
    this.url(`/api/v1/workspaces/${workspaceSlug}/members/`),
    { headers: this.headers() }
  )
  if (!res.ok) throw new Error(`Failed to get members: ${res.status}`)
  const data = await res.json()
  return data.results ?? data
}

async registerWebhook(workspaceSlug: string, url: string, secret: string): Promise<{ id: string; url: string }> {
  const res = await fetch(
    this.url(`/api/v1/workspaces/${workspaceSlug}/webhooks/`),
    {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        url,
        is_active: true,
        issue: true,
        secret,
      }),
    }
  )
  if (!res.ok) throw new Error(`Failed to register webhook: ${res.status} ${await res.text()}`)
  return res.json()
}

async resolveStateByGroup(workspaceSlug: string, projectId: string, group: string): Promise<string | null> {
  const states = await this.getProjectStates(workspaceSlug, projectId)
  const list: Array<{ id: string; group: string }> = states.results ?? states
  const match = list.find((s) => s.group === group)
  return match?.id ?? null
}
```

**Step 4: Run tests to confirm pass**

```bash
cd /workspace/zenova-agents && npm test --workspace packages/orchestrator -- --reporter=verbose 2>&1 | tail -20
```
Expected: all plane-client tests pass.

**Step 5: Commit**

```bash
cd /workspace/zenova-agents && git add packages/orchestrator/src/plane-client.ts packages/orchestrator/src/__tests__/plane-client.test.ts && git commit -m "feat(orchestrator): add workspace setup methods to PlaneClient"
```

---

## Task 2: Multi-workspace config in orchestrator

**Files:**
- Modify: `packages/orchestrator/src/index.ts`

Currently Redis stores settings in flat keys (`zenova:settings`). We need per-workspace namespacing so one orchestrator can serve multiple Plane instances.

**Step 1: Write failing test**

Add to `packages/orchestrator/src/__tests__/index.test.ts`:

```typescript
it('stores and retrieves workspace-scoped config', async () => {
  // POST to /admin/api/settings with workspace slug
  const res1 = await app.request('/admin/api/settings/my-workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { GITHUB_TOKEN: 'ghp_abc123' }, repos: {} }),
  })
  expect(res1.status).toBe(200)

  // GET back same workspace
  const res2 = await app.request('/admin/api/settings/my-workspace')
  expect(res2.status).toBe(200)
  const data = await res2.json()
  expect(data.settings.GITHUB_TOKEN).toMatch(/ghp_ab/)
})
```

**Step 2: Run to confirm fail**

```bash
cd /workspace/zenova-agents && npm test --workspace packages/orchestrator -- --reporter=verbose 2>&1 | grep -E "FAIL|stores and retrieves" | head -5
```

**Step 3: Update Redis key helpers in `packages/orchestrator/src/index.ts`**

Replace the existing key constants and helpers with workspace-scoped versions:

```typescript
// Replace these lines:
// const SETTINGS_KEY = 'zenova:settings'
// const REPOS_KEY = 'zenova:project-repos'
// async function getSetting(key: string): Promise<string> { ... }
// async function getAllSettings(): Promise<Record<string, string>> { ... }
// async function setSetting(...): Promise<void> { ... }
// async function getRepoForProject(...): Promise<string> { ... }
// async function getAllRepos(): Promise<Record<string, string>> { ... }
// async function setRepoForProject(...): Promise<void> { ... }

// With these workspace-scoped versions:
function settingsKey(ws: string) { return `zenova:settings:${ws}` }
function reposKey(ws: string) { return `zenova:repos:${ws}` }

async function getSetting(key: string, ws = 'default'): Promise<string> {
  if (!redisClient) return process.env[key] ?? ''
  const val = await redisClient.hget(settingsKey(ws), key)
  return val ?? process.env[key] ?? ''
}

async function getAllSettings(ws = 'default'): Promise<Record<string, string>> {
  if (!redisClient) return {}
  return await redisClient.hgetall(settingsKey(ws)) ?? {}
}

async function setSetting(key: string, value: string, ws = 'default'): Promise<void> {
  if (!redisClient) return
  if (value) { await redisClient.hset(settingsKey(ws), key, value) }
  else { await redisClient.hdel(settingsKey(ws), key) }
}

async function getRepoForProject(projectId: string, ws = 'default'): Promise<string> {
  if (!redisClient) return process.env.REPO_URL ?? ''
  const url = await redisClient.hget(reposKey(ws), projectId)
  return url ?? await getSetting('DEFAULT_REPO_URL', ws) ?? process.env.REPO_URL ?? ''
}

async function getAllRepos(ws = 'default'): Promise<Record<string, string>> {
  if (!redisClient) return {}
  return await redisClient.hgetall(reposKey(ws)) ?? {}
}

async function setRepoForProject(projectId: string, url: string, ws = 'default'): Promise<void> {
  if (!redisClient) return
  if (url) { await redisClient.hset(reposKey(ws), projectId, url) }
  else { await redisClient.hdel(reposKey(ws), projectId) }
}
```

Add workspace-scoped admin routes after the existing `/admin/api/settings` routes:

```typescript
app.get('/admin/api/settings/:workspace', async (c) => {
  const ws = c.req.param('workspace')
  const settings = await getAllSettings(ws)
  const masked: Record<string, string> = {}
  for (const [k, v] of Object.entries(settings)) {
    if (v && v.length > 8 && (k.includes('TOKEN') || k.includes('KEY') || k.includes('SECRET'))) {
      masked[k] = v.slice(0, 6) + '...' + v.slice(-4)
    } else { masked[k] = v }
  }
  const repos = await getAllRepos(ws)
  return c.json({ settings: masked, repos })
})

app.post('/admin/api/settings/:workspace', async (c) => {
  const ws = c.req.param('workspace')
  try {
    const { settings, repos } = await c.req.json() as { settings: Record<string, string>; repos: Record<string, string> }
    if (settings) {
      for (const [k, v] of Object.entries(settings)) {
        if (v && !v.includes('...')) await setSetting(k, v, ws)
      }
    }
    if (repos) {
      if (redisClient) await redisClient.del(reposKey(ws))
      for (const [pid, url] of Object.entries(repos)) await setRepoForProject(pid, url, ws)
    }
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 500)
  }
})
```

Also update the webhook handler to pass `workspaceSlug` into `getSetting`/`getRepoForProject` calls:

```typescript
// In the /webhooks/plane handler, update the secrets block:
const repoUrl = await getRepoForProject(task.projectId, task.workspaceSlug)
const secrets = {
  GITHUB_TOKEN: await getSetting('GITHUB_TOKEN', task.workspaceSlug) || process.env.GITHUB_TOKEN || '',
  CLAUDE_CODE_OAUTH_TOKEN: await getSetting('CLAUDE_CODE_OAUTH_TOKEN', task.workspaceSlug) || process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
  ANTHROPIC_API_KEY: await getSetting('ANTHROPIC_API_KEY', task.workspaceSlug) || process.env.ANTHROPIC_API_KEY || '',
  GEMINI_API_KEY: await getSetting('GEMINI_API_KEY', task.workspaceSlug) || process.env.GEMINI_API_KEY || '',
  PLANE_API_URL: process.env.PLANE_API_URL ?? '',
  PLANE_API_TOKEN: process.env.PLANE_API_TOKEN ?? '',
  REPO_URL: repoUrl,
}
```

**Step 4: Run all tests**

```bash
cd /workspace/zenova-agents && npm test --workspace packages/orchestrator 2>&1 | tail -20
```
Expected: all existing tests still pass + new workspace config test passes.

**Step 5: Commit**

```bash
cd /workspace/zenova-agents && git add packages/orchestrator/src/index.ts packages/orchestrator/src/__tests__/index.test.ts && git commit -m "feat(orchestrator): namespace Redis config by workspace slug"
```

---

## Task 3: Workspace setup endpoint (`POST /setup`)

**Files:**
- Create: `packages/orchestrator/src/setup.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Create: `packages/orchestrator/src/__tests__/setup.test.ts`

This endpoint receives a Plane URL + API token and auto-bootstraps: validates credentials, stores config in Redis, registers a webhook.

**Step 1: Write failing tests**

Create `packages/orchestrator/src/__tests__/setup.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { bootstrapWorkspace } from '../setup.js'

const mockPlane = {
  getWorkspaceMembers: vi.fn(),
  registerWebhook: vi.fn(),
}

vi.mock('../plane-client.js', () => ({
  PlaneClient: vi.fn().mockImplementation(() => mockPlane),
}))

describe('bootstrapWorkspace', () => {
  beforeEach(() => vi.clearAllMocks())

  it('validates plane credentials', async () => {
    mockPlane.getWorkspaceMembers.mockRejectedValueOnce(new Error('401'))
    await expect(
      bootstrapWorkspace({ planeUrl: 'http://plane', apiToken: 'bad', workspaceSlug: 'ws', webhookUrl: 'http://hook', redis: null as any })
    ).rejects.toThrow('401')
  })

  it('registers webhook on success', async () => {
    mockPlane.getWorkspaceMembers.mockResolvedValueOnce([])
    mockPlane.registerWebhook.mockResolvedValueOnce({ id: 'wh1', url: 'http://hook' })
    const result = await bootstrapWorkspace({
      planeUrl: 'http://plane', apiToken: 'tok', workspaceSlug: 'ws',
      webhookUrl: 'http://hook', redis: null as any,
    })
    expect(mockPlane.registerWebhook).toHaveBeenCalledWith('ws', 'http://hook', expect.any(String))
    expect(result.webhookId).toBe('wh1')
    expect(result.webhookSecret).toEqual(expect.any(String))
  })
})
```

**Step 2: Run to confirm fail**

```bash
cd /workspace/zenova-agents && npm test --workspace packages/orchestrator -- --reporter=verbose 2>&1 | grep -E "FAIL|bootstrapWorkspace" | head -5
```

**Step 3: Implement `packages/orchestrator/src/setup.ts`**

```typescript
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

  // Validate credentials by listing members (throws if invalid)
  const members = await client.getWorkspaceMembers(workspaceSlug)

  // Generate webhook signing secret
  const webhookSecret = randomBytes(32).toString('hex')

  // Register webhook
  const webhook = await client.registerWebhook(workspaceSlug, webhookUrl, webhookSecret)

  // Persist config in Redis
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
```

**Step 4: Wire into orchestrator `index.ts`**

Add after the health routes:

```typescript
app.post('/setup', async (c) => {
  try {
    const { planeUrl, apiToken, workspaceSlug } = await c.req.json() as {
      planeUrl: string; apiToken: string; workspaceSlug: string
    }
    if (!planeUrl || !apiToken || !workspaceSlug) {
      return c.json({ error: 'planeUrl, apiToken, workspaceSlug are required' }, 400)
    }
    const { bootstrapWorkspace } = await import('./setup.js')
    const protocol = c.req.header('x-forwarded-proto') ?? 'http'
    const host = c.req.header('host') ?? 'localhost:4000'
    const webhookUrl = `${protocol}://${host}/webhooks/plane`
    const result = await bootstrapWorkspace({
      planeUrl, apiToken, workspaceSlug, webhookUrl, redis: redisClient,
    })
    return c.json({ ok: true, ...result })
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 400)
  }
})
```

**Step 5: Run all tests**

```bash
cd /workspace/zenova-agents && npm test --workspace packages/orchestrator 2>&1 | tail -20
```
Expected: all tests pass.

**Step 6: Commit**

```bash
cd /workspace/zenova-agents && git add packages/orchestrator/src/setup.ts packages/orchestrator/src/index.ts packages/orchestrator/src/__tests__/setup.test.ts && git commit -m "feat(orchestrator): add /setup endpoint for one-click workspace bootstrap"
```

---

## Task 4: Agent streaming activity — dev agent

**Files:**
- Modify: `packages/agents/dev/entrypoint.sh`

Currently the dev agent posts one comment at the end. We need incremental comments at each step: analyzing → branching → running AI → PR ready.

**Step 1: Update `packages/agents/dev/entrypoint.sh`**

Replace the existing `entrypoint.sh` content with:

```bash
#!/bin/bash
set -euo pipefail

echo "=== Zenova Dev Agent Starting ==="
echo "Task ID: ${TASK_ID}"
echo "Issue: ${ISSUE_TITLE}"

# Helper: post comment to Plane issue
post_comment() {
  local msg="$1"
  if [ -n "${PLANE_API_URL:-}" ] && [ -n "${PLANE_API_TOKEN:-}" ]; then
    jq -n --arg html "<p>${msg}</p>" '{comment_html: $html}' | \
      curl -s -X POST "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/comments/" \
        -H "X-API-Key: ${PLANE_API_TOKEN}" -H "Content-Type: application/json" -d @- > /dev/null 2>&1 || true
  fi
}

# Helper: transition issue state by group name
transition_state() {
  local group="$1"
  if [ -n "${PLANE_API_URL:-}" ] && [ -n "${PLANE_API_TOKEN:-}" ]; then
    STATE_ID=$(curl -s "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/states/" \
      -H "X-API-Key: ${PLANE_API_TOKEN}" | \
      jq -r --arg g "$group" '.results // . | map(select(.group == $g)) | first | .id // empty')
    if [ -n "$STATE_ID" ]; then
      jq -n --arg s "$STATE_ID" '{state: $s}' | \
        curl -s -X PATCH "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/" \
          -H "X-API-Key: ${PLANE_API_TOKEN}" -H "Content-Type: application/json" -d @- > /dev/null 2>&1 || true
    fi
  fi
}

# Transition to In Progress
post_comment "🤖 Dev agent picked up this issue. Starting work..."
transition_state "started"

# Auth GitHub
echo "${GITHUB_TOKEN}" | gh auth login --with-token

# Clone repo
post_comment "📦 Cloning repository..."
REPO_URL="${REPO_URL:-}"
if [ -n "$REPO_URL" ]; then
  git clone "$REPO_URL" /workspace/repo
  cd /workspace/repo
fi

# Configure git identity
git config user.email "dev-agent@zenova.id"
git config user.name "Zenova Dev Agent"

# Create branch
BRANCH_NAME="agent/${AGENT_TYPE}/${TASK_ID}"
git checkout -b "$BRANCH_NAME"
post_comment "🌿 Created branch: \`${BRANCH_NAME}\`"

# Run Claude Code
post_comment "🧠 Running Claude Code on this task..."
PROMPT="$(cat /agent/prompt.md)

## Current Task
**Issue:** ${ISSUE_TITLE}
**Description:** ${ISSUE_DESCRIPTION}
**Instructions:** Work on this task. Create all necessary changes. When done, commit your changes with a clear message."

claude --print --dangerously-skip-permissions "$PROMPT"

# Push branch
post_comment "⬆️ Pushing changes..."
git push origin "$BRANCH_NAME"

# Create PR
PR_URL=$(gh pr create \
  --title "[Agent] ${ISSUE_TITLE}" \
  --body "$(printf 'Automated by Zenova Dev Agent\n\nTask: %s\nIssue: %s' "${TASK_ID}" "${ISSUE_ID}")" \
  --head "$BRANCH_NAME" 2>&1)

echo "PR created: $PR_URL"

# Post PR link and comment
if [ -n "${PLANE_API_URL:-}" ] && [ -n "${PLANE_API_TOKEN:-}" ]; then
  # Add PR as issue link
  jq -n --arg url "$PR_URL" --arg title "Pull Request" '{url: $url, title: $title}' | \
    curl -s -X POST "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/links/" \
      -H "X-API-Key: ${PLANE_API_TOKEN}" -H "Content-Type: application/json" -d @- > /dev/null 2>&1 || true

  post_comment "✅ Done! PR ready for review: ${PR_URL}"
fi

# Transition to In Review
transition_state "unstarted"  # Plane's "In Review" group varies; commonly "unstarted" after "started"

echo "=== Dev Agent Complete ==="
```

Note: the `transition_state "unstarted"` call targets whatever state group maps to review in the workspace. This may need to be customized to match the workspace state names. A follow-up improvement would be a configurable group name env var.

**Step 2: Build and verify the script is valid bash**

```bash
bash -n /workspace/zenova-agents/packages/agents/dev/entrypoint.sh && echo "syntax OK"
```
Expected: `syntax OK`

**Step 3: Commit**

```bash
cd /workspace/zenova-agents && git add packages/agents/dev/entrypoint.sh && git commit -m "feat(agent/dev): add streaming activity comments and auto state transitions"
```

---

## Task 5: Apply same streaming pattern to strategy, landing agents

**Files:**
- Modify: `packages/agents/strategy/entrypoint.sh`
- Modify: `packages/agents/landing/entrypoint.sh`

Both agents currently have similar structure to dev. Apply the same `post_comment` and `transition_state` helper pattern.

**Step 1: Check current entrypoints**

```bash
cat /workspace/zenova-agents/packages/agents/strategy/entrypoint.sh
cat /workspace/zenova-agents/packages/agents/landing/entrypoint.sh
```

**Step 2: Update `packages/agents/strategy/entrypoint.sh`**

Copy the `post_comment` and `transition_state` helper functions from Task 4 into the strategy agent. The strategy agent doesn't create a GitHub PR (it produces docs/content), so use a simpler flow:

```bash
#!/bin/bash
set -euo pipefail

echo "=== Zenova Strategy Agent Starting ==="

post_comment() {
  local msg="$1"
  if [ -n "${PLANE_API_URL:-}" ] && [ -n "${PLANE_API_TOKEN:-}" ]; then
    jq -n --arg html "<p>${msg}</p>" '{comment_html: $html}' | \
      curl -s -X POST "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/comments/" \
        -H "X-API-Key: ${PLANE_API_TOKEN}" -H "Content-Type: application/json" -d @- > /dev/null 2>&1 || true
  fi
}

transition_state() {
  local group="$1"
  if [ -n "${PLANE_API_URL:-}" ] && [ -n "${PLANE_API_TOKEN:-}" ]; then
    STATE_ID=$(curl -s "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/states/" \
      -H "X-API-Key: ${PLANE_API_TOKEN}" | \
      jq -r --arg g "$group" '.results // . | map(select(.group == $g)) | first | .id // empty')
    if [ -n "$STATE_ID" ]; then
      jq -n --arg s "$STATE_ID" '{state: $s}' | \
        curl -s -X PATCH "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/" \
          -H "X-API-Key: ${PLANE_API_TOKEN}" -H "Content-Type: application/json" -d @- > /dev/null 2>&1 || true
    fi
  fi
}

post_comment "📊 Strategy agent started. Analyzing request..."
transition_state "started"

PROMPT="$(cat /agent/prompt.md)

## Current Task
**Issue:** ${ISSUE_TITLE}
**Description:** ${ISSUE_DESCRIPTION}"

OUTPUT=$(claude --print --dangerously-skip-permissions "$PROMPT")

# Post output as a comment
if [ -n "${PLANE_API_URL:-}" ] && [ -n "${PLANE_API_TOKEN:-}" ]; then
  TRUNCATED=$(echo "$OUTPUT" | head -c 4000)
  jq -n --arg html "<p><strong>Strategy output:</strong></p><pre>${TRUNCATED}</pre>" '{comment_html: $html}' | \
    curl -s -X POST "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/comments/" \
      -H "X-API-Key: ${PLANE_API_TOKEN}" -H "Content-Type: application/json" -d @- > /dev/null 2>&1 || true
fi

post_comment "✅ Strategy analysis complete."
transition_state "completed"

echo "=== Strategy Agent Complete ==="
```

**Step 3: Update `packages/agents/landing/entrypoint.sh`**

Landing agent creates a PR (like dev), so use the same full dev pattern with one change — branch prefix `agent/landing/${TASK_ID}` and appropriate PR title. Copy Task 4's entrypoint, change `AGENT_TYPE` references and PR body text appropriately. The key structural change is adding `post_comment` and `transition_state`.

**Step 4: Validate syntax**

```bash
bash -n /workspace/zenova-agents/packages/agents/strategy/entrypoint.sh && echo "strategy OK"
bash -n /workspace/zenova-agents/packages/agents/landing/entrypoint.sh && echo "landing OK"
```

**Step 5: Commit**

```bash
cd /workspace/zenova-agents && git add packages/agents/strategy/entrypoint.sh packages/agents/landing/entrypoint.sh && git commit -m "feat(agent/strategy,landing): add streaming activity and state transitions"
```

---

## Task 6: Build `packages/connect` — wizard web app

**Files:**
- Create: `packages/connect/` (new Vite + React app)
- Create: `packages/connect/package.json`
- Create: `packages/connect/vite.config.ts`
- Create: `packages/connect/index.html`
- Create: `packages/connect/src/main.tsx`
- Create: `packages/connect/src/App.tsx`
- Create: `packages/connect/src/steps/StepConnect.tsx`
- Create: `packages/connect/src/steps/StepConfigure.tsx`
- Create: `packages/connect/src/steps/StepDone.tsx`

**Step 1: Scaffold the package**

```bash
cd /workspace/zenova-agents/packages && mkdir -p connect/src/steps
```

Create `packages/connect/package.json`:

```json
{
  "name": "@zenova/connect",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.1",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.14",
    "typescript": "^5.6.0",
    "vite": "^5.4.10"
  }
}
```

**Step 2: Install connect package dependencies**

```bash
cd /workspace/zenova-agents/packages/connect && npm install 2>&1 | tail -5
```
Expected: packages installed.

**Step 3: Create `packages/connect/vite.config.ts`**

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../../packages/orchestrator/public/connect',
    emptyOutDir: true,
  },
})
```

Note: builds into `packages/orchestrator/public/connect` so the orchestrator can serve it statically.

**Step 4: Create `packages/connect/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Zenova Agents — Connect</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Step 5: Create `packages/connect/src/main.tsx`**

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

**Step 6: Create `packages/connect/src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  @apply bg-zinc-950 text-zinc-100 font-sans antialiased;
}
```

**Step 7: Create `packages/connect/src/App.tsx`**

```tsx
import { useState } from 'react'
import StepConnect from './steps/StepConnect'
import StepConfigure from './steps/StepConfigure'
import StepDone from './steps/StepDone'

export interface SetupState {
  planeUrl: string
  apiToken: string
  workspaceSlug: string
  webhookId?: string
  webhookSecret?: string
}

const STEPS = ['Connect', 'Configure', 'Done'] as const

export default function App() {
  const [step, setStep] = useState(0)
  const [state, setState] = useState<SetupState>({ planeUrl: '', apiToken: '', workspaceSlug: '' })

  const merge = (patch: Partial<SetupState>) => setState(s => ({ ...s, ...patch }))

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-white mb-1">Zenova Agents</h1>
          <p className="text-zinc-400 text-sm">Connect AI agents to your Plane workspace</p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold
                ${i < step ? 'bg-emerald-500 text-white' : i === step ? 'bg-blue-500 text-white' : 'bg-zinc-800 text-zinc-500'}`}>
                {i < step ? '✓' : i + 1}
              </div>
              <span className={`text-sm ${i === step ? 'text-white' : 'text-zinc-500'}`}>{label}</span>
              {i < STEPS.length - 1 && <div className="w-8 h-px bg-zinc-700 mx-1" />}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
          {step === 0 && <StepConnect state={state} merge={merge} onNext={() => setStep(1)} />}
          {step === 1 && <StepConfigure state={state} merge={merge} onNext={() => setStep(2)} />}
          {step === 2 && <StepDone state={state} />}
        </div>
      </div>
    </div>
  )
}
```

**Step 8: Create `packages/connect/src/steps/StepConnect.tsx`**

```tsx
import { useState } from 'react'
import type { SetupState } from '../App'

interface Props {
  state: SetupState
  merge: (p: Partial<SetupState>) => void
  onNext: () => void
}

export default function StepConnect({ state, merge, onNext }: Props) {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function validate() {
    setError('')
    setLoading(true)
    try {
      const res = await fetch(`${state.planeUrl}/api/v1/workspaces/${state.workspaceSlug}/members/`, {
        headers: { 'X-API-Key': state.apiToken },
      })
      if (!res.ok) throw new Error(`Plane returned ${res.status} — check URL and token`)
      onNext()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Connect to Plane</h2>
        <p className="text-sm text-zinc-400">Enter your self-hosted Plane URL and API token to get started.</p>
      </div>

      <Field label="Plane URL" placeholder="https://plane.yourdomain.com" value={state.planeUrl}
        onChange={v => merge({ planeUrl: v.replace(/\/$/, '') })} />
      <Field label="Workspace Slug" placeholder="my-workspace"
        hint='Found in your Plane URL: plane.io/<slug>/...'
        value={state.workspaceSlug} onChange={v => merge({ workspaceSlug: v })} />
      <Field label="API Token" type="password" placeholder="plane_api_..."
        hint='Settings → API Tokens in Plane'
        value={state.apiToken} onChange={v => merge({ apiToken: v })} />

      {error && <p className="text-sm text-red-400 bg-red-950 border border-red-800 rounded-lg px-3 py-2">{error}</p>}

      <button
        onClick={validate}
        disabled={loading || !state.planeUrl || !state.apiToken || !state.workspaceSlug}
        className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
      >
        {loading ? 'Validating...' : 'Validate & Continue →'}
      </button>
    </div>
  )
}

function Field({ label, placeholder, value, onChange, type = 'text', hint }: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void; type?: string; hint?: string
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-zinc-300 mb-1">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 focus:border-blue-500 rounded-lg text-white placeholder-zinc-600 outline-none transition-colors text-sm" />
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </div>
  )
}
```

**Step 9: Create `packages/connect/src/steps/StepConfigure.tsx`**

```tsx
import { useState } from 'react'
import type { SetupState } from '../App'

interface Props {
  state: SetupState
  merge: (p: Partial<SetupState>) => void
  onNext: () => void
}

const AVAILABLE_AGENTS = [
  { id: 'dev', label: 'Dev Agent', desc: 'Writes code, creates PRs, handles engineering tasks' },
  { id: 'creative', label: 'Creative Agent', desc: 'Generates images, visuals, and creative assets' },
  { id: 'strategy', label: 'Strategy Agent', desc: 'Writes plans, docs, and strategic content' },
  { id: 'landing', label: 'Landing Agent', desc: 'Builds marketing pages and web content' },
]

export default function StepConfigure({ state, merge, onNext }: Props) {
  const [selectedAgents, setSelectedAgents] = useState<string[]>(['dev'])
  const [githubToken, setGithubToken] = useState('')
  const [claudeToken, setClaudeToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<string[]>([])

  function toggleAgent(id: string) {
    setSelectedAgents(prev => prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id])
  }

  async function runSetup() {
    setError('')
    setLoading(true)
    setProgress([])

    try {
      setProgress(p => [...p, 'Connecting to orchestrator...'])
      const res = await fetch('/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planeUrl: state.planeUrl,
          apiToken: state.apiToken,
          workspaceSlug: state.workspaceSlug,
        }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error)

      setProgress(p => [...p, `✓ Webhook registered (ID: ${data.webhookId})`])

      // Save API keys for this workspace
      if (githubToken || claudeToken) {
        setProgress(p => [...p, 'Saving API keys...'])
        await fetch(`/admin/api/settings/${state.workspaceSlug}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            settings: {
              ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
              ...(claudeToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeToken } : {}),
            },
            repos: {},
          }),
        })
        setProgress(p => [...p, '✓ API keys saved'])
      }

      merge({ webhookId: data.webhookId, webhookSecret: data.webhookSecret })
      setProgress(p => [...p, '✓ Setup complete!'])
      setTimeout(onNext, 800)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Configure Agents</h2>
        <p className="text-sm text-zinc-400">Choose which agents to enable and add your API keys.</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-2">Enable agents</label>
        <div className="space-y-2">
          {AVAILABLE_AGENTS.map(a => (
            <label key={a.id} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors
              ${selectedAgents.includes(a.id) ? 'border-blue-500 bg-blue-950/30' : 'border-zinc-700 hover:border-zinc-600'}`}>
              <input type="checkbox" checked={selectedAgents.includes(a.id)} onChange={() => toggleAgent(a.id)}
                className="mt-0.5 accent-blue-500" />
              <div>
                <div className="text-sm font-medium text-white">{a.label}</div>
                <div className="text-xs text-zinc-400">{a.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">GitHub Token</label>
          <input type="password" value={githubToken} onChange={e => setGithubToken(e.target.value)}
            placeholder="ghp_..." className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 focus:border-blue-500 rounded-lg text-white placeholder-zinc-600 outline-none text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">Claude OAuth Token</label>
          <input type="password" value={claudeToken} onChange={e => setClaudeToken(e.target.value)}
            placeholder="sk-ant-oat01-..." className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 focus:border-blue-500 rounded-lg text-white placeholder-zinc-600 outline-none text-sm" />
          <p className="mt-1 text-xs text-zinc-500">Run <code className="text-zinc-300">claude setup-token</code> in terminal to get this</p>
        </div>
      </div>

      {progress.length > 0 && (
        <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 space-y-1">
          {progress.map((p, i) => <p key={i} className="text-xs text-zinc-300 font-mono">{p}</p>)}
        </div>
      )}

      {error && <p className="text-sm text-red-400 bg-red-950 border border-red-800 rounded-lg px-3 py-2">{error}</p>}

      <button onClick={runSetup} disabled={loading || selectedAgents.length === 0}
        className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors">
        {loading ? 'Setting up...' : 'Run Setup →'}
      </button>
    </div>
  )
}
```

**Step 10: Create `packages/connect/src/steps/StepDone.tsx`**

```tsx
import type { SetupState } from '../App'

export default function StepDone({ state }: { state: SetupState }) {
  const planeUrl = `${state.planeUrl}/${state.workspaceSlug}/settings/members/`

  return (
    <div className="text-center space-y-5">
      <div className="w-16 h-16 bg-emerald-500/20 border border-emerald-500/30 rounded-full flex items-center justify-center mx-auto text-3xl">
        ✅
      </div>
      <div>
        <h2 className="text-xl font-semibold text-white mb-1">Agents are ready!</h2>
        <p className="text-sm text-zinc-400">
          Your Plane workspace is now connected to Zenova Agents.
          Assign any issue to an agent user to get started.
        </p>
      </div>

      <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 text-left space-y-2">
        <p className="text-xs font-medium text-zinc-300 uppercase tracking-wide">How to use</p>
        <ol className="text-sm text-zinc-400 space-y-2 list-decimal list-inside">
          <li>Go to your Plane workspace</li>
          <li>Create or open an issue</li>
          <li>Assign it to <code className="text-emerald-400">@dev-agent</code>, <code className="text-emerald-400">@creative-agent</code>, etc.</li>
          <li>Watch the agent post activity in the issue comments</li>
          <li>Review and merge the PR when it's ready</li>
        </ol>
      </div>

      <a href={planeUrl} target="_blank" rel="noopener noreferrer"
        className="block w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-colors">
        Open Plane Workspace →
      </a>
      <a href="/admin" className="block text-sm text-zinc-400 hover:text-zinc-200 transition-colors">
        View agent dashboard
      </a>
    </div>
  )
}
```

**Step 11: Create Tailwind config**

Create `packages/connect/tailwind.config.js`:

```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: {} },
  plugins: [],
}
```

Create `packages/connect/postcss.config.js`:

```javascript
export default { plugins: { tailwindcss: {}, autoprefixer: {} } }
```

Create `packages/connect/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src"]
}
```

**Step 12: Test build**

```bash
cd /workspace/zenova-agents/packages/connect && npm run build 2>&1 | tail -10
```
Expected: build succeeds, outputs to `packages/orchestrator/public/connect/`

**Step 13: Commit**

```bash
cd /workspace/zenova-agents && git add packages/connect/ && git commit -m "feat(connect): add wizard setup app for one-click workspace bootstrap"
```

---

## Task 7: Serve connect wizard from orchestrator

**Files:**
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `packages/orchestrator/package.json`

**Step 1: Add `serveStatic` middleware to orchestrator**

Add to `packages/orchestrator/package.json` dependencies:

```json
"@hono/node-server": "^1.13.0"
```
(already present — verify)

Add static file serving to `packages/orchestrator/src/index.ts` after existing imports:

```typescript
import { serveStatic } from '@hono/node-server/serve-static'

// Serve connect wizard SPA
app.use('/connect/*', serveStatic({ root: './public' }))
app.get('/connect', (c) => c.redirect('/connect/index.html'))
```

Note: the `public/connect/` directory is populated by `npm run build` in `packages/connect`.

**Step 2: Add build script to root `package.json`**

Add to `/workspace/zenova-agents/package.json`:

```json
"scripts": {
  "build:connect": "npm run build --workspace packages/connect",
  "dev": "npm run dev --workspace packages/orchestrator"
}
```

**Step 3: Test the full flow locally**

```bash
cd /workspace/zenova-agents && npm run build:connect 2>&1 | tail -5
```

Then start orchestrator and verify:
```bash
curl http://localhost:4000/connect -v 2>&1 | grep "< HTTP"
```
Expected: `< HTTP/1.1 302 Found` (redirect to index.html)

**Step 4: Commit**

```bash
cd /workspace/zenova-agents && git add packages/orchestrator/src/index.ts package.json && git commit -m "feat(orchestrator): serve connect wizard SPA at /connect"
```

---

## Task 8: Update `docker-compose.yml` and deployment docs

**Files:**
- Modify: `docker-compose.yml`
- Modify or create: `docs/CONNECT.md`

**Step 1: Verify docker-compose has correct volume/port config**

```bash
cat /workspace/zenova-agents/docker-compose.yml
```

Ensure:
- Orchestrator service mounts `./packages/orchestrator/public` if serving static files from container
- No changes needed if using external build

**Step 2: Create `docs/CONNECT.md`**

```markdown
# Connecting Zenova Agents to Your Plane Workspace

## Quick Setup (< 5 minutes)

1. Deploy Zenova Agents (see `deploy/README.md`)
2. Open `https://your-orchestrator-url/connect` in your browser
3. Enter your Plane URL, workspace slug, and API token
4. Choose which agents to enable
5. Add your GitHub + Claude tokens
6. Click "Run Setup" — agents are registered automatically

## What Gets Created

- Webhook subscription in your Plane workspace (auto-configured)
- Workspace-scoped API key storage in Redis

## Using Agents

Assign any Plane issue to an agent user (e.g. `@dev-agent`).
The agent will:
1. Post a comment: "🤖 Dev agent picked up this issue..."
2. Transition issue to "In Progress"
3. Clone your repo, create a branch, run Claude Code
4. Create a PR and post the link to the issue
5. Transition issue to "In Review"

## Troubleshooting

- **Agent not picking up issues**: Check webhook is active in Plane Settings → Webhooks
- **Auth errors**: Re-run setup wizard and re-enter API tokens
- **Container fails**: Check `GET /status` for running agents and queue depth
```

**Step 3: Commit**

```bash
cd /workspace/zenova-agents && git add docs/CONNECT.md docker-compose.yml && git commit -m "docs: add connect setup guide"
```

---

## Verification Checklist

Before marking Phase 1 complete, verify:

```bash
# All orchestrator tests pass
cd /workspace/zenova-agents && npm test --workspace packages/orchestrator 2>&1 | tail -5

# Connect wizard builds successfully
npm run build:connect 2>&1 | tail -3

# Syntax check all agent entrypoints
bash -n packages/agents/dev/entrypoint.sh && echo "dev OK"
bash -n packages/agents/strategy/entrypoint.sh && echo "strategy OK"
bash -n packages/agents/landing/entrypoint.sh && echo "landing OK"
```

Expected output for all: green tests, successful build, "OK" messages.

---

## Phase 2 Preview

Phase 2 (fork Plane.so → Zenova Platform) is a separate plan. When Phase 1 ships and is validated in production:

1. Fork `makeplane/plane` → create `packages/plane-fork` or separate repo
2. Add `agents` Django app with OAuth2 provider
3. Add Agents integrations page to Next.js web app
4. Migrate connect wizard into native Plane UI
5. White-label (rename to Zenova, new colors/logo)
6. Remove Plane.so telemetry

This phase ships as a standalone product under `zenova.id`.
