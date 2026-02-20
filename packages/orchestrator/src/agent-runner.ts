import { spawn, execSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { PlaneClient } from './plane-client.js'
import type { QueuedTask } from './types.js'

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
    console.log('[agent] Using Claude Code CLI with OAuth token')
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
  // Write OAuth credentials so Claude Code CLI can authenticate via claude.ai
  const claudeDir = join(homedir(), '.claude')
  mkdirSync(claudeDir, { recursive: true, mode: 0o700 })
  const credPath = join(claudeDir, '.credentials.json')
  writeFileSync(
    credPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: oauthToken,
        tokenType: 'Bearer',
        expiresAt: Date.now() + 3600_000 * 24 * 30,
        scopes: ['user:inference'],
        subscriptionType: 'pro',
      },
    }),
    { encoding: 'utf-8', mode: 0o600 }
  )
  console.log('[agent] Credentials written:', credPath)

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['--print', '--dangerously-skip-permissions', prompt], {
      env: {
        ...process.env,
        HOME: homedir(),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_TELEMETRY_DISABLED: '1',
      },
      timeout: 120_000,
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      console.log(`[agent] claude exited ${code}, stdout=${stdout.length}b stderr=${stderr.length}b`)
      if (stderr) console.log('[agent] stderr:', stderr.slice(0, 500))
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim())
      } else {
        reject(new Error(`claude CLI exited ${code}. ${stderr.slice(0, 300) || 'No output'}`))
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
