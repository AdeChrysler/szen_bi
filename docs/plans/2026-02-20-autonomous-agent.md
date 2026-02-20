# Autonomous Claude Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When `@claude <action verb>` appears in a Plane comment, Claude autonomously works on the issue — clones the repo, implements changes, pushes to a branch, updates the issue state in Plane, and posts a summary — all without leaving Plane.

**Architecture:** Keyword detection routes `@claude` comments to either `runCommentAgent` (Q&A) or `runAutonomousAgent` (does work). The autonomous agent runs `claude --print --dangerously-skip-permissions` with a rich system prompt, a working directory it clones the repo into, and the Plane MCP server (now with write tools) so Claude can post progress comments and move the issue through states.

**Tech Stack:** TypeScript, Node.js, Claude Code CLI (`claude` binary), `@modelcontextprotocol/sdk`, Hono, Vitest.

**Worktree:** `~/.config/superpowers/worktrees/zenova-agents/comment-mention`

---

## Task 1: Add `getComments` to PlaneClient

**Files:**
- Modify: `packages/orchestrator/src/plane-client.ts`
- Modify: `packages/orchestrator/src/__tests__/plane-client.test.ts`

**Step 1: Write the failing test**

Add to the bottom of the `describe('PlaneClient')` block in `plane-client.test.ts`:

```typescript
it('fetches issue comments', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      results: [
        { id: 'c1', comment_stripped: 'First comment', actor_detail: { display_name: 'Alice' } },
        { id: 'c2', comment_stripped: '@claude fix the bug', actor_detail: { display_name: 'Bob' } },
      ],
    }),
  })
  const comments = await client.getComments('ws', 'proj-1', 'issue-1')
  expect(mockFetch).toHaveBeenCalledWith(
    'http://plane-api:8000/api/v1/workspaces/ws/projects/proj-1/issues/issue-1/comments/',
    expect.objectContaining({ headers: expect.objectContaining({ 'X-API-Key': 'test-token' }) })
  )
  expect(comments).toHaveLength(2)
  expect(comments[0].comment_stripped).toBe('First comment')
})
```

**Step 2: Run to confirm it fails**

```bash
cd ~/.config/superpowers/worktrees/zenova-agents/comment-mention/packages/orchestrator
npm test -- --reporter=verbose 2>&1 | grep -A3 "fetches issue comments"
```

Expected: `FAIL` — `client.getComments is not a function`

**Step 3: Implement `getComments` in `plane-client.ts`**

Add after `getIssue`:

```typescript
async getComments(workspaceSlug: string, projectId: string, issueId: string): Promise<Array<{
  id: string
  comment_stripped: string
  comment_html: string
  actor_detail?: { id: string; display_name: string }
  created_at: string
}>> {
  const res = await fetch(
    this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`),
    { headers: this.headers() }
  )
  if (!res.ok) throw new Error(`Failed to get comments: ${res.status}`)
  const data = await res.json()
  return data.results ?? data
}
```

**Step 4: Run to confirm it passes**

```bash
npm test -- --reporter=verbose 2>&1 | grep -A3 "fetches issue comments"
```

Expected: `✓ fetches issue comments`

**Step 5: Commit**

```bash
cd ~/.config/superpowers/worktrees/zenova-agents/comment-mention
git add packages/orchestrator/src/plane-client.ts packages/orchestrator/src/__tests__/plane-client.test.ts
git commit -m "feat: add getComments to PlaneClient"
```

---

## Task 2: Add write tools to plane-mcp-server.ts

**Files:**
- Modify: `packages/orchestrator/src/plane-mcp-server.ts`

No unit tests for the MCP server (it wraps a live API). The TypeScript compiler is the verification.

**Step 1: Add `planePatch` and `planePost` helper functions**

Add after the existing `planeGet` function (before the `McpServer` setup):

```typescript
async function planePatch(path: string, body: unknown) {
  const res = await fetch(`${PLANE_API_URL}${path}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Plane API error ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

async function planePost(path: string, body: unknown) {
  const res = await fetch(`${PLANE_API_URL}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Plane API error ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}
```

**Step 2: Add `update_issue_state` tool**

Add after the existing `search_issues` tool registration (before the `StdioServerTransport` line):

```typescript
// ─── Tool: update_issue_state ────────────────────────────────────────────────

server.registerTool(
  'update_issue_state',
  {
    description: 'Move a Plane issue to a different state by state name (e.g. "In Progress", "In Review", "Done")',
    inputSchema: {
      workspace: z.string().describe('Workspace slug'),
      project_id: z.string().describe('Project ID (UUID)'),
      issue_id: z.string().describe('Issue ID (UUID)'),
      state_name: z.string().describe('Target state name — must match exactly (case-insensitive)'),
    },
  },
  async ({ workspace, project_id, issue_id, state_name }) => {
    const states = await planeGet(`/api/v1/workspaces/${workspace}/projects/${project_id}/states/`)
    const stateList: any[] = states.results ?? states
    const state = stateList.find((s: any) => s.name.toLowerCase() === state_name.toLowerCase())
    if (!state) {
      throw new Error(
        `State "${state_name}" not found. Available: ${stateList.map((s: any) => s.name).join(', ')}`
      )
    }
    const result = await planePatch(
      `/api/v1/workspaces/${workspace}/projects/${project_id}/issues/${issue_id}/`,
      { state: state.id }
    )
    return {
      content: [{ type: 'text', text: JSON.stringify({ updated: true, state: result.state }) }],
    }
  }
)
```

**Step 3: Add `create_issue` tool**

```typescript
// ─── Tool: create_issue ──────────────────────────────────────────────────────

server.registerTool(
  'create_issue',
  {
    description: 'Create a new issue or subtask in a Plane project',
    inputSchema: {
      workspace: z.string().describe('Workspace slug'),
      project_id: z.string().describe('Project ID (UUID)'),
      title: z.string().describe('Issue title'),
      description: z.string().optional().describe('Issue description (plain text)'),
      priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
      parent_id: z.string().optional().describe('Parent issue ID to create as a subtask'),
    },
  },
  async ({ workspace, project_id, title, description, priority, parent_id }) => {
    const body: Record<string, unknown> = { name: title }
    if (description) body.description_html = `<p>${description}</p>`
    if (priority) body.priority = priority
    if (parent_id) body.parent = parent_id
    const result = await planePost(
      `/api/v1/workspaces/${workspace}/projects/${project_id}/issues/`,
      body
    )
    return {
      content: [{ type: 'text', text: JSON.stringify({ id: result.id, name: result.name }) }],
    }
  }
)
```

**Step 4: Add `add_comment` tool**

```typescript
// ─── Tool: add_comment ───────────────────────────────────────────────────────

server.registerTool(
  'add_comment',
  {
    description: 'Post a comment on a Plane issue. Use this to report progress mid-task.',
    inputSchema: {
      workspace: z.string().describe('Workspace slug'),
      project_id: z.string().describe('Project ID (UUID)'),
      issue_id: z.string().describe('Issue ID (UUID)'),
      text: z.string().describe('Comment text (plain text)'),
    },
  },
  async ({ workspace, project_id, issue_id, text }) => {
    await planePost(
      `/api/v1/workspaces/${workspace}/projects/${project_id}/issues/${issue_id}/comments/`,
      { comment_html: `<p>${text}</p>` }
    )
    return {
      content: [{ type: 'text', text: 'Comment posted.' }],
    }
  }
)
```

**Step 5: Add `update_issue` tool**

```typescript
// ─── Tool: update_issue ──────────────────────────────────────────────────────

server.registerTool(
  'update_issue',
  {
    description: 'Update issue fields: title, description, or priority',
    inputSchema: {
      workspace: z.string().describe('Workspace slug'),
      project_id: z.string().describe('Project ID (UUID)'),
      issue_id: z.string().describe('Issue ID (UUID)'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description (plain text)'),
      priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
    },
  },
  async ({ workspace, project_id, issue_id, title, description, priority }) => {
    const body: Record<string, unknown> = {}
    if (title) body.name = title
    if (description) body.description_html = `<p>${description}</p>`
    if (priority) body.priority = priority
    await planePatch(
      `/api/v1/workspaces/${workspace}/projects/${project_id}/issues/${issue_id}/`,
      body
    )
    return {
      content: [{ type: 'text', text: JSON.stringify({ updated: true }) }],
    }
  }
)
```

**Step 6: TypeScript check**

```bash
cd ~/.config/superpowers/worktrees/zenova-agents/comment-mention/packages/orchestrator
npx tsc --noEmit 2>&1
```

Expected: no output (zero errors)

**Step 7: Commit**

```bash
cd ~/.config/superpowers/worktrees/zenova-agents/comment-mention
git add packages/orchestrator/src/plane-mcp-server.ts
git commit -m "feat: add write tools to Plane MCP server"
```

---

## Task 3: Add `isActionRequest` + `runAutonomousAgent` to agent-runner.ts

**Files:**
- Modify: `packages/orchestrator/src/agent-runner.ts`
- Modify: `packages/orchestrator/src/__tests__/dispatch.test.ts` (add keyword detection tests there, it's the closest unit test file)

**Step 1: Write failing tests for `isActionRequest`**

Create `packages/orchestrator/src/__tests__/agent-runner.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { isActionRequest } from '../agent-runner.js'

describe('isActionRequest', () => {
  it('returns true for action verbs', () => {
    expect(isActionRequest('implement the login feature')).toBe(true)
    expect(isActionRequest('fix the null pointer error')).toBe(true)
    expect(isActionRequest('build a new API endpoint')).toBe(true)
    expect(isActionRequest('refactor the payment module')).toBe(true)
    expect(isActionRequest('write tests for auth')).toBe(true)
    expect(isActionRequest('work on this issue')).toBe(true)
    expect(isActionRequest('debug the crash')).toBe(true)
    expect(isActionRequest('review this PR')).toBe(true)
  })

  it('returns false for Q&A verbs', () => {
    expect(isActionRequest('explain the acceptance criteria')).toBe(false)
    expect(isActionRequest('what does this issue mean?')).toBe(false)
    expect(isActionRequest('how should I approach this?')).toBe(false)
    expect(isActionRequest('list all the tasks')).toBe(false)
    expect(isActionRequest('describe the requirements')).toBe(false)
    expect(isActionRequest('')).toBe(false)
  })
})
```

**Step 2: Run to confirm it fails**

```bash
cd ~/.config/superpowers/worktrees/zenova-agents/comment-mention/packages/orchestrator
npm test -- --reporter=verbose 2>&1 | grep -A5 "isActionRequest"
```

Expected: `FAIL` — `isActionRequest is not a function`

**Step 3: Export `isActionRequest` from `agent-runner.ts`**

Add after the imports (before `runInlineAgent`):

```typescript
const ACTION_VERB_PATTERN =
  /\b(implement|fix|build|create|write|refactor|add|update|test|review|investigate|debug|work\s+on|deploy|setup|set\s+up|configure|migrate|optimize)\b/i

export function isActionRequest(text: string): boolean {
  return ACTION_VERB_PATTERN.test(text)
}
```

**Step 4: Run to confirm tests pass**

```bash
npm test -- --reporter=verbose 2>&1 | grep -A5 "isActionRequest"
```

Expected: all `isActionRequest` tests `✓`

**Step 5: Add `runAutonomousAgent` function**

Add at the bottom of `agent-runner.ts`, after `runCommentAgent`:

```typescript
// ─── Autonomous agent ─────────────────────────────────────────────────────────

export async function runAutonomousAgent(
  commentData: PlaneCommentPayload['data'],
  issueDetails: any,
  secrets: Record<string, string>,
  plane: PlaneClient
): Promise<void> {
  const oauthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN
  if (!oauthToken) {
    throw new Error('runAutonomousAgent requires CLAUDE_CODE_OAUTH_TOKEN')
  }

  const question = (commentData.comment_stripped ?? '').replace(/@claude\b/i, '').trim()
  const actor = commentData.actor_detail?.display_name ?? 'User'

  // 1. Acknowledge immediately
  await plane.addComment(
    commentData.workspace,
    commentData.project,
    commentData.issue_id,
    `🤖 **Claude** — Got it! Working on: *${issueDetails.name ?? 'this issue'}*\n\nI'll post updates as I go.`
  )

  // 2. Fetch full comment history for context
  let priorComments = ''
  try {
    const comments = await plane.getComments(commentData.workspace, commentData.project, commentData.issue_id)
    priorComments = comments
      .map((c) => `  [${c.actor_detail?.display_name ?? 'Unknown'}]: ${c.comment_stripped ?? ''}`)
      .join('\n')
  } catch {
    // Non-fatal — proceed without comment history
  }

  // 3. Set up working directory (Claude will clone the repo inside it)
  const { mkdtemp } = await import('fs/promises')
  const { tmpdir } = await import('os')
  const workDir = await mkdtemp(`${tmpdir()}/claude-work-${commentData.issue_id.slice(0, 8)}-`)

  // 4. Write MCP config with Plane MCP (read + write tools)
  const mcpDir = join(homedir(), '.claude')
  await mkdir(mcpDir, { recursive: true })
  const mcpConfig = {
    mcpServers: {
      plane: {
        type: 'stdio',
        command: 'node',
        args: ['/app/dist/plane-mcp-server.js'],
        env: {
          PLANE_API_URL: secrets.PLANE_API_URL ?? process.env.PLANE_API_URL ?? '',
          PLANE_API_TOKEN: secrets.PLANE_API_TOKEN ?? process.env.PLANE_API_TOKEN ?? '',
        },
      },
    },
  }
  await writeFile(join(mcpDir, 'mcp.json'), JSON.stringify(mcpConfig, null, 2), 'utf-8')

  // 5. Build rich system prompt
  const repoUrl = secrets.REPO_URL ?? ''
  const stateInfo = issueDetails.state_detail?.name ?? issueDetails.state ?? 'Unknown'
  const priorityInfo = issueDetails.priority ?? 'none'
  const labelsInfo = (issueDetails.label_details ?? issueDetails.labels ?? [])
    .map((l: any) => l.name ?? l).join(', ') || 'none'
  const descriptionInfo = issueDetails.description_stripped ?? '(no description)'

  const prompt = `You are an autonomous software engineering agent embedded in Plane (project management).
A team member has asked you to work on a task. Complete it fully and autonomously.

## Issue Context
- **Title:** ${issueDetails.name ?? 'Untitled'}
- **ID:** ${commentData.issue_id}
- **Project:** ${commentData.project}
- **Workspace:** ${commentData.workspace}
- **State:** ${stateInfo} | **Priority:** ${priorityInfo}
- **Labels:** ${labelsInfo}
- **Repository:** ${repoUrl || '(not configured — check project settings)'}

## Description
${descriptionInfo}

## Prior Discussion
${priorComments || '(no prior comments)'}

## Requested by ${actor}
${question || '(no specific instruction — use your best judgment based on the issue description)'}

---

## Your Mission
Complete this task end-to-end. Here's how:

1. **Clone the repo** (if a repo URL is provided above):
   \`\`\`bash
   git clone ${repoUrl || '<repo-url>'} .
   \`\`\`
   Your working directory is already set to a temp folder. Just run git clone with "." as destination.

2. **Understand the codebase** — read relevant files, understand the structure.

3. **Post a progress comment** using the \`add_comment\` MCP tool after you've understood the task:
   - workspace: "${commentData.workspace}"
   - project_id: "${commentData.project}"
   - issue_id: "${commentData.issue_id}"

4. **Implement** the requested changes. Write tests if appropriate.

5. **Run tests** to verify your changes don't break anything.

6. **Commit and push** to a new branch named \`claude/issue-${commentData.issue_id.slice(0, 8)}\`:
   \`\`\`bash
   git checkout -b claude/issue-${commentData.issue_id.slice(0, 8)}
   git add -A
   git commit -m "feat: <describe what you did>"
   git push origin claude/issue-${commentData.issue_id.slice(0, 8)}
   \`\`\`

7. **Move the issue to "In Review"** using the \`update_issue_state\` MCP tool.

8. **Summarize** what you did in your final response. Include:
   - What you changed and why
   - Branch name pushed to
   - Any follow-up recommendations

If no repo URL is configured, skip git steps and focus on analysis, planning, and issue management (creating subtasks, updating state, etc.).

IMPORTANT: Use the Plane MCP tools proactively — post progress, create subtasks, update the issue. Don't just silently work.`

  // 6. Run claude autonomously
  console.log('[autonomous-agent] Using Claude Code CLI with Plane MCP')
  let response: string
  try {
    response = await runWithClaudeAutonomous(oauthToken, prompt, workDir)
  } catch (err) {
    await plane.addComment(
      commentData.workspace,
      commentData.project,
      commentData.issue_id,
      `🤖 **Claude** — Encountered an error during autonomous run:\n\n\`\`\`\n${String(err).slice(0, 500)}\n\`\`\``
    )
    throw err
  }

  // 7. Post final summary
  await plane.addComment(
    commentData.workspace,
    commentData.project,
    commentData.issue_id,
    `🤖 **Claude** — Work complete (requested by ${actor})\n\n${response}`
  )
}

async function runWithClaudeAutonomous(
  oauthToken: string,
  prompt: string,
  workDir: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'claude',
      ['--print', '--dangerously-skip-permissions'],
      {
        cwd: workDir,
        env: {
          ...process.env,
          CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          NO_COLOR: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 300_000,   // 5 minutes for autonomous work
      }
    )

    proc.stdin.write(prompt, 'utf-8')
    proc.stdin.end()

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code, signal) => {
      console.log(`[autonomous-agent] claude exited code=${code} signal=${signal} stdout=${stdout.length}b`)
      if (stderr.trim()) console.log('[autonomous-agent] stderr:', stderr.slice(0, 500))
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim())
      } else {
        reject(new Error(`claude exited ${code ?? signal}. stderr: ${stderr.slice(0, 300) || 'none'}`))
      }
    })

    proc.on('error', (err) => reject(new Error(`spawn claude: ${err.message}`)))
  })
}
```

**Step 6: Run all tests to confirm nothing broke**

```bash
cd ~/.config/superpowers/worktrees/zenova-agents/comment-mention/packages/orchestrator
npm test 2>&1 | tail -10
```

Expected: all tests pass, `Tests N passed`

**Step 7: TypeScript check**

```bash
npx tsc --noEmit 2>&1
```

Expected: no output

**Step 8: Commit**

```bash
cd ~/.config/superpowers/worktrees/zenova-agents/comment-mention
git add packages/orchestrator/src/agent-runner.ts packages/orchestrator/src/__tests__/agent-runner.test.ts
git commit -m "feat: add isActionRequest + runAutonomousAgent"
```

---

## Task 4: Update index.ts comment handler with keyword routing

**Files:**
- Modify: `packages/orchestrator/src/index.ts`

**Step 1: Import `isActionRequest` in the comment handler block**

Find this block in `index.ts`:

```typescript
    const { runCommentAgent } = await import('./agent-runner.js')
    runCommentAgent(comment, issueDetails, secrets, plane).catch((err: Error) =>
```

Replace the import + invocation with routing logic:

```typescript
    const { runCommentAgent, runAutonomousAgent, isActionRequest } = await import('./agent-runner.js')
    const userQuestion = (comment.comment_stripped ?? '').replace(/@claude\b/i, '').trim()

    if (isActionRequest(userQuestion)) {
      console.log('[comment-agent] Routing to autonomous mode')
      runAutonomousAgent(comment, issueDetails, secrets, plane).catch((err: Error) =>
        console.error('[autonomous-agent] error:', err)
      )
    } else {
      console.log('[comment-agent] Routing to Q&A mode')
      runCommentAgent(comment, issueDetails, secrets, plane).catch((err: Error) =>
        console.error('[comment-agent] error:', err)
      )
    }
```

Also update the return to indicate which mode was dispatched:

```typescript
    return c.json({ dispatched: true, mode: isActionRequest(userQuestion) ? 'autonomous' : 'comment' })
```

Wait — `isActionRequest` is imported dynamically inside the try block, so we can't use it in the return statement after the if/else. Restructure the block so the mode string is captured in a variable before the return. See the full replacement below.

**Full replacement — find:**

```typescript
    const { runCommentAgent } = await import('./agent-runner.js')
    runCommentAgent(comment, issueDetails, secrets, plane).catch((err: Error) =>
      console.error('[comment-agent] error:', err)
    )
    return c.json({ dispatched: true, mode: 'comment' })
```

**Replace with:**

```typescript
    const { runCommentAgent, runAutonomousAgent, isActionRequest } = await import('./agent-runner.js')
    const userQuestion = (comment.comment_stripped ?? '').replace(/@claude\b/i, '').trim()
    const autonomous = isActionRequest(userQuestion)

    if (autonomous) {
      console.log('[webhook] @claude → autonomous mode')
      runAutonomousAgent(comment, issueDetails, secrets, plane).catch((err: Error) =>
        console.error('[autonomous-agent] error:', err)
      )
    } else {
      console.log('[webhook] @claude → Q&A mode')
      runCommentAgent(comment, issueDetails, secrets, plane).catch((err: Error) =>
        console.error('[comment-agent] error:', err)
      )
    }
    return c.json({ dispatched: true, mode: autonomous ? 'autonomous' : 'comment' })
```

**Step 2: TypeScript check**

```bash
cd ~/.config/superpowers/worktrees/zenova-agents/comment-mention/packages/orchestrator
npx tsc --noEmit 2>&1
```

Expected: no output

**Step 3: Run all tests**

```bash
npm test 2>&1 | tail -10
```

Expected: all pass

**Step 4: Commit**

```bash
cd ~/.config/superpowers/worktrees/zenova-agents/comment-mention
git add packages/orchestrator/src/index.ts
git commit -m "feat: route @claude action verbs to autonomous agent"
```

---

## Task 5: Push feature branch + merge to master

**Step 1: Push the feature branch**

```bash
cd ~/.config/superpowers/worktrees/zenova-agents/comment-mention
git push origin feature/comment-mention
```

**Step 2: Merge into master**

```bash
cd /workspace/zenova-agents
git merge feature/comment-mention --no-ff -m "feat: @claude comment mention + autonomous agent"
git push origin master
```

**Step 3: Confirm push succeeded**

```bash
git log --oneline -5
```

Expected: top commit is the merge commit.

---

## Task 6: Delete + recreate Coolify app and deploy

The new `@modelcontextprotocol/sdk` dep and `plane-mcp-server.ts` require a fresh build.

**Step 1: Get the current Dockerfile content**

Read: `packages/orchestrator/Dockerfile`

The Dockerfile must compile TypeScript (`npm run build`) so `dist/plane-mcp-server.js` is produced. Verify the Dockerfile has `RUN npm run build` (tsc).

**Step 2: Delete the existing Coolify app**

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer 3|5cYUsOOyuMn6hYdNZMGitOot8qPVgtpsTUJSaLSDa43de776" \
  "https://zenova.id/api/v1/applications/n40488k8kooc44o8w4c00go0"
```

Expected: `{"success":true}` or `204 No Content`

**Step 3: Base64-encode the Dockerfile**

```bash
base64 -w 0 /workspace/zenova-agents/packages/orchestrator/Dockerfile
```

Save the output for Step 4.

**Step 4: Create new Coolify app**

```bash
curl -s -X POST \
  -H "Authorization: Bearer 3|5cYUsOOyuMn6hYdNZMGitOot8qPVgtpsTUJSaLSDa43de776" \
  -H "Content-Type: application/json" \
  "https://zenova.id/api/v1/applications/dockerfile" \
  -d '{
    "project_uuid": "doo8oscoskkgk0kcc48g84w0",
    "server_uuid": "dkkkg0osg8s44ks08wc8kowo",
    "destination_uuid": "sowg000sog8o0wgkcok48kcs",
    "name": "orchestrator",
    "dockerfile": "<BASE64_FROM_STEP_3>",
    "domains": "https://orchestrator.zenova.id",
    "instant_deploy": false
  }'
```

Note the new `uuid` from the response. Update MEMORY.md with the new UUID.

**Step 5: Set environment variables**

Use the UUID from Step 4. Set all required env vars (PORT=80, REDIS_URL, PLANE_API_URL, PLANE_API_TOKEN, WEBHOOK_SECRET, NODE_ENV=production, CLAUDE_CODE_OAUTH_TOKEN if available at this level).

**Step 6: Trigger deploy**

```bash
curl -s -X POST \
  -H "Authorization: Bearer 3|5cYUsOOyuMn6hYdNZMGitOot8qPVgtpsTUJSaLSDa43de776" \
  "https://zenova.id/api/v1/applications/<NEW_UUID>/deploy"
```

**Step 7: Watch deploy logs**

```bash
curl -s \
  -H "Authorization: Bearer 3|5cYUsOOyuMn6hYdNZMGitOot8qPVgtpsTUJSaLSDa43de776" \
  "https://zenova.id/api/v1/applications/<NEW_UUID>/logs/deployments" | python3 -m json.tool | head -60
```

**Step 8: Verify health**

```bash
curl -s https://orchestrator.zenova.id/health
```

Expected: `{"status":"ok","timestamp":"..."}`

---

## Verification Checklist

- [ ] `npm test` — all 28+ tests pass (27 existing + new isActionRequest tests)
- [ ] `npx tsc --noEmit` — zero errors
- [ ] `curl https://orchestrator.zenova.id/health` — returns 200
- [ ] Send test comment webhook with `@claude explain what this does` → returns `mode: "comment"`
- [ ] Send test comment webhook with `@claude implement the feature` → returns `mode: "autonomous"`
- [ ] Check Plane issue for `🤖 Got it! Working on:` acknowledgment comment
