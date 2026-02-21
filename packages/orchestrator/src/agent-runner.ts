import { spawn } from 'child_process'
import { writeFile, mkdir, mkdtemp } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { PlaneClient } from './plane-client.js'
import { SessionManager, InMemorySessionManager } from './agent-session.js'
import { ProgressReporter } from './progress-reporter.js'
import { StreamParser } from './stream-parser.js'
import type { QueuedTask, PlaneCommentPayload } from './types.js'

const ACTION_VERB_PATTERN =
  /^(please\s+)?(can\s+you\s+|could\s+you\s+)?(implement|fix|build|create|write|refactor|add|update|test|review|investigate|debug|work\s+on|deploy|setup|set\s+up|configure|migrate|optimize)(?!\s+(me|my|us|our|your|their)\b)\b/i

export function isActionRequest(text: string): boolean {
  return ACTION_VERB_PATTERN.test(text)
}

// ─── Unified agent entry point ──────────────────────────────────────────────

export interface RunAgentOpts {
  commentData: PlaneCommentPayload['data']
  issueDetails: any
  secrets: Record<string, string>
  plane: PlaneClient
  sessionManager: SessionManager | InMemorySessionManager
  mode: 'comment' | 'autonomous'
  followUpSessionId?: string   // parent session for follow-ups
}

export async function runAgent(opts: RunAgentOpts): Promise<void> {
  const { commentData, issueDetails, secrets, plane, sessionManager, mode, followUpSessionId } = opts
  const oauthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN
  const apiKey = secrets.ANTHROPIC_API_KEY
  const actor = commentData.actor_detail?.display_name ?? 'User'

  if (!oauthToken && !apiKey) {
    throw new Error('No Anthropic credentials (set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)')
  }

  // 1. Create session
  const session = await sessionManager.createSession({
    issueId: commentData.issue_id,
    projectId: commentData.project,
    workspaceSlug: commentData.workspace,
    mode,
    triggeredBy: actor,
    triggerCommentId: commentData.id,
    parentSessionId: followUpSessionId,
  })

  if (!session) {
    console.log(`[agent] Cannot create session — another session is active for issue ${commentData.issue_id}`)
    await plane.addComment(
      commentData.workspace,
      commentData.project,
      commentData.issue_id,
      `I'm already working on this issue. Please wait for the current task to finish.`,
      { external_source: 'zenova-agent' }
    )
    return
  }

  // 2. Create progress reporter and post thinking comment
  const reporter = new ProgressReporter(
    plane, sessionManager, session.id,
    commentData.workspace, commentData.project, commentData.issue_id
  )
  await reporter.postThinkingComment()
  await sessionManager.updateState(session.id, 'active')

  // 3. Build prompt and MCP config
  const prompt = buildPrompt(commentData, issueDetails, secrets, mode, followUpSessionId)
  const mcpConfigPath = await writeMcpConfig(commentData.issue_id, secrets)

  // 4. Run agent (streaming if oauth, fallback if API key only)
  if (oauthToken) {
    await runWithStreaming(oauthToken, prompt, mcpConfigPath, mode, reporter, actor, commentData, secrets)
  } else {
    await runWithApiFallback(apiKey!, prompt, reporter, actor)
  }
}

// ─── Streaming CLI execution ────────────────────────────────────────────────

async function runWithStreaming(
  oauthToken: string,
  prompt: string,
  mcpConfigPath: string,
  mode: 'comment' | 'autonomous',
  reporter: ProgressReporter,
  actor: string,
  commentData: PlaneCommentPayload['data'],
  secrets: Record<string, string>,
): Promise<void> {
  const isAutonomous = mode === 'autonomous'
  let workDir: string | undefined

  const claudeArgs = ['--print', '--verbose', '--output-format', 'stream-json']
  if (mcpConfigPath) claudeArgs.push('--mcp-config', mcpConfigPath)

  if (isAutonomous) {
    claudeArgs.push('--dangerously-skip-permissions')
    workDir = await mkdtemp(`${tmpdir()}/claude-work-${commentData.issue_id.slice(0, 8)}-`)
  }

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    NO_COLOR: '1',
  }

  if (isAutonomous) {
    env.GIT_TERMINAL_PROMPT = '0'
    env.GIT_AUTHOR_NAME = 'Claude Agent'
    env.GIT_AUTHOR_EMAIL = 'claude-agent@zenova.id'
    env.GIT_COMMITTER_NAME = 'Claude Agent'
    env.GIT_COMMITTER_EMAIL = 'claude-agent@zenova.id'
    if (secrets.GITHUB_TOKEN) env.GITHUB_TOKEN = secrets.GITHUB_TOKEN
  }

  const timeout = isAutonomous ? 300_000 : 110_000

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', claudeArgs, {
      cwd: workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
    })

    proc.stdin.write(prompt, 'utf-8')
    proc.stdin.end()

    // Parse streaming output
    const parser = new StreamParser(proc.stdout)
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    parser.on('event', (event) => {
      reporter.handleEvent(event).catch(err =>
        console.error('[agent] Progress event error:', err)
      )
    })

    parser.on('error', (err) => {
      console.error('[agent] Stream parser error:', err)
    })

    proc.on('close', async (code, signal) => {
      const fullText = parser.getFullText()
      console.log(`[agent] claude exited code=${code} signal=${signal} response=${fullText.length}b`)
      if (stderr.trim()) console.log('[agent] stderr:', stderr.slice(0, 500))

      try {
        if (code === 0 && fullText.trim()) {
          await reporter.finalize(fullText.trim(), actor)
          resolve()
        } else {
          const errMsg = `Claude exited ${code ?? signal}. ${stderr.slice(0, 300) || fullText.slice(0, 300) || 'no output'}`
          await reporter.finalizeError(errMsg)
          reject(new Error(errMsg))
        }
      } catch (err) {
        reject(err)
      }
    })

    proc.on('error', async (err) => {
      await reporter.finalizeError(`Failed to spawn Claude CLI: ${err.message}`)
      reject(new Error(`spawn claude: ${err.message}`))
    })
  })
}

// ─── API key fallback (no streaming) ────────────────────────────────────────

async function runWithApiFallback(
  apiKey: string,
  prompt: string,
  reporter: ProgressReporter,
  actor: string,
): Promise<void> {
  try {
    const client = new Anthropic({ apiKey })
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    })
    const response = message.content[0].type === 'text' ? message.content[0].text : ''
    await reporter.finalize(response, actor)
  } catch (err) {
    await reporter.finalizeError(String(err))
    throw err
  }
}

// ─── Prompt building ────────────────────────────────────────────────────────

function buildPrompt(
  commentData: PlaneCommentPayload['data'],
  issueDetails: any,
  secrets: Record<string, string>,
  mode: 'comment' | 'autonomous',
  followUpSessionId?: string,
): string {
  const rawText = commentData.comment_stripped ?? ''
  const question = rawText.replace(/@claude\b/i, '').trim()
  const stateInfo = issueDetails.state_detail?.name ?? issueDetails.state ?? 'Unknown'
  const priorityInfo = issueDetails.priority ?? 'none'
  const labelsInfo = (issueDetails.label_details ?? issueDetails.labels ?? [])
    .map((l: any) => l.name ?? l).join(', ') || 'none'
  const descriptionInfo = issueDetails.description_stripped ?? '(no description)'

  if (mode === 'comment') {
    return buildCommentPrompt(issueDetails, question, stateInfo, priorityInfo, labelsInfo, descriptionInfo, followUpSessionId)
  }
  return buildAutonomousPrompt(commentData, issueDetails, secrets, question, stateInfo, priorityInfo, labelsInfo, descriptionInfo)
}

function buildCommentPrompt(
  issueDetails: any,
  question: string,
  stateInfo: string,
  priorityInfo: string,
  labelsInfo: string,
  descriptionInfo: string,
  followUpSessionId?: string,
): string {
  const followUpNote = followUpSessionId
    ? '\n\nThis is a follow-up to a previous conversation. The user is continuing the discussion.'
    : ''

  return `You are Claude, an AI assistant embedded in Plane (project management).
A user has mentioned you in a comment. Respond helpfully and concisely.${followUpNote}

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
}

function buildAutonomousPrompt(
  commentData: PlaneCommentPayload['data'],
  issueDetails: any,
  secrets: Record<string, string>,
  question: string,
  stateInfo: string,
  priorityInfo: string,
  labelsInfo: string,
  descriptionInfo: string,
): string {
  const repoUrl = secrets.REPO_URL ?? ''
  const actor = commentData.actor_detail?.display_name ?? 'User'
  const shortId = commentData.issue_id.slice(0, 8)
  const branchName = `claude/issue-${shortId}`

  return `You are an autonomous software engineering agent embedded in Plane (project management).
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

3. **Implement** the requested changes. Write tests if appropriate.

4. **Run tests** to verify your changes don't break anything.

5. **Commit and push** to a new branch named \`${branchName}\`:
   \`\`\`bash
   git checkout -b ${branchName}
   git add -A
   git commit -m "feat: <describe what you did>"
   git push origin ${branchName}
   \`\`\`

6. **Move the issue to "In Review"** using the \`update_issue_state\` MCP tool.

7. **Summarize** what you did in your final response. Include:
   - What you changed and why
   - Branch name pushed to
   - Any follow-up recommendations

If no repo URL is configured, skip git steps and focus on analysis, planning, and issue management.

IMPORTANT: Use the Plane MCP tools proactively — update the issue state, create subtasks if needed. Don't just silently work.`
}

// ─── MCP config helper ──────────────────────────────────────────────────────

async function writeMcpConfig(issueId: string, secrets: Record<string, string>): Promise<string> {
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
  const mcpConfigFile = `mcp-${issueId.slice(0, 8)}.json`
  const fullPath = join(mcpDir, mcpConfigFile)
  await writeFile(fullPath, JSON.stringify(mcpConfig, null, 2), 'utf-8')
  return fullPath
}

// ─── Legacy inline agent (for Docker dispatch path) ─────────────────────────

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
    response = await runWithClaudeCLISimple(oauthToken, prompt)
  } else {
    console.log('[agent] Using Anthropic API key')
    const client = new Anthropic({ apiKey: apiKey! })
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    })
    response = message.content[0].type === 'text' ? message.content[0].text : ''
  }

  await plane.addComment(
    task.workspaceSlug,
    task.projectId,
    task.issueId,
    `🤖 **Claude Agent Analysis**\n\n${response}`
  )
}

/** Simple non-streaming CLI execution (for legacy inline path) */
async function runWithClaudeCLISimple(oauthToken: string, prompt: string, mcpConfigPath?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const claudeArgs: string[] = ['--print']
    if (mcpConfigPath) claudeArgs.push('--mcp-config', mcpConfigPath)
    const proc = spawn('claude', claudeArgs, {
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 110_000,
    })

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
