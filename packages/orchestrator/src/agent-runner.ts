import { spawn } from 'child_process'
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
