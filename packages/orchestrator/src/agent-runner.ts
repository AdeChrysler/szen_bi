import { spawn } from 'child_process'
import { writeFile, mkdir, mkdtemp } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { PlaneClient } from './plane-client.js'
import type { QueuedTask, PlaneCommentPayload } from './types.js'

const ACTION_VERB_PATTERN =
  /\b(implement|fix|build|create|write|refactor|add|update|test|review|investigate|debug|work\s+on|deploy|setup|set\s+up|configure|migrate|optimize)\b/i

export function isActionRequest(text: string): boolean {
  return ACTION_VERB_PATTERN.test(text)
}

export async function runInlineAgent(
  task: QueuedTask,
  secrets: Record<string, string>,
  plane: PlaneClient
): Promise<void> {
  const oauthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN
  const apiKey = secrets.ANTHROPIC_API_KEY

  if (!oauthToken && !apiKey) {
    throw new Error('No Anthropic credentials (set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in admin settings)')
  }

  const issueDetails = [
    `Title: ${task.payload.name}`,
    task.payload.description_stripped ? `Description:\n${task.payload.description_stripped}` : '',
    `Priority: ${task.payload.priority}`,
    `State: ${task.payload.state?.name ?? 'Unknown'}`,
  ].filter(Boolean).join('\n\n')

  const prompt = `You are a senior software engineer and technical lead reviewing a project management ticket.

When given a ticket/issue, provide:
1. **Analysis** — What exactly needs to be done and why
2. **Implementation Plan** — Step-by-step technical approach
3. **Code** — Concrete code snippets or pseudocode where relevant
4. **Acceptance Criteria** — How to verify the task is done correctly

Be specific, technical, and actionable. Assume TypeScript/Node.js unless stated otherwise.

---

Please analyze this ticket:

${issueDetails}`

  let response: string

  if (oauthToken) {
    console.log('[agent] Using Claude Code CLI (OAuth)')
    response = await runWithClaudeCLI(oauthToken, prompt)
  } else {
    console.log('[agent] Using Anthropic API key')
    response = await runWithApiKey(apiKey!, prompt)
  }

  await plane.addComment(
    task.workspaceSlug,
    task.projectId,
    task.issueId,
    `🤖 **Claude Agent Analysis**\n\n${response}`
  )
}

async function runWithClaudeCLI(oauthToken: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // CLAUDE_CODE_OAUTH_TOKEN env var overrides credentials file — no file writing needed
    const proc = spawn('claude', ['--print'], {
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 110_000,
    })

    // Write prompt to stdin and close it
    proc.stdin.write(prompt, 'utf-8')
    proc.stdin.end()

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code, signal) => {
      console.log(`[agent] claude exited code=${code} signal=${signal} stdout=${stdout.length}b stderr=${stderr.length}b`)
      if (stderr.trim()) console.log('[agent] stderr:', stderr.slice(0, 500))
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim())
      } else {
        reject(new Error(`claude exited ${code ?? signal}. stderr: ${stderr.slice(0, 300) || 'none'}`))
      }
    })

    proc.on('error', (err) => reject(new Error(`spawn claude: ${err.message}`)))
  })
}

async function runWithApiKey(apiKey: string, prompt: string): Promise<string> {
  const client = new Anthropic({ apiKey })
  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })
  return message.content[0].type === 'text' ? message.content[0].text : ''
}

// ─── Comment mention agent ────────────────────────────────────────────────────

export async function runCommentAgent(
  commentData: PlaneCommentPayload['data'],
  issueDetails: any,
  secrets: Record<string, string>,
  plane: PlaneClient
): Promise<void> {
  const oauthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN
  if (!oauthToken) {
    throw new Error('runCommentAgent requires CLAUDE_CODE_OAUTH_TOKEN (MCP needs Claude Code CLI)')
  }

  // Extract the user's question by stripping the @claude prefix
  const rawText = commentData.comment_stripped ?? ''
  const question = rawText.replace(/@claude\b/i, '').trim()

  // Build rich context from the issue
  const stateInfo = issueDetails.state_detail?.name ?? issueDetails.state ?? 'Unknown'
  const priorityInfo = issueDetails.priority ?? 'none'
  const labelsInfo = (issueDetails.label_details ?? issueDetails.labels ?? [])
    .map((l: any) => l.name ?? l)
    .join(', ') || 'none'
  const descriptionInfo = issueDetails.description_stripped ?? ''

  const prompt = `You are Claude, an AI assistant embedded in Plane (project management).
A user has mentioned you in a comment. Respond helpfully and concisely.

**Current Issue:**
Title: ${issueDetails.name ?? 'Untitled'}
State: ${stateInfo} | Priority: ${priorityInfo}
Labels: ${labelsInfo}
Description: ${descriptionInfo || '(no description)'}

**User's question/request:**
${question || '(no specific question — provide a helpful summary or analysis)'}

---
You have access to Plane tools via MCP:
- get_issue: look up any issue by ID
- list_issues: browse project tasks
- get_project: get project details
- get_comments: read discussion on any issue
- search_issues: find related work

Use tools when you need to reference other tasks. Keep your response focused and actionable.`

  // Write MCP config so Claude CLI can use the Plane MCP server as a subprocess
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

  console.log('[comment-agent] Using Claude Code CLI with Plane MCP server')
  const response = await runWithClaudeCLI(oauthToken, prompt)

  const actor = commentData.actor_detail?.display_name ?? 'User'
  await plane.addComment(
    commentData.workspace,
    commentData.project,
    commentData.issue_id,
    `🤖 **Claude** (replying to ${actor})\n\n${response}`
  )
}

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

  // 3. Set up working directory
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
  const shortId = commentData.issue_id.slice(0, 8)
  const branchName = `claude/issue-${shortId}`

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

6. **Commit and push** to a new branch named \`${branchName}\`:
   \`\`\`bash
   git checkout -b ${branchName}
   git add -A
   git commit -m "feat: <describe what you did>"
   git push origin ${branchName}
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
          GIT_AUTHOR_NAME: 'Claude Agent',
          GIT_AUTHOR_EMAIL: 'claude-agent@zenova.id',
          GIT_COMMITTER_NAME: 'Claude Agent',
          GIT_COMMITTER_EMAIL: 'claude-agent@zenova.id',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 300_000,
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
