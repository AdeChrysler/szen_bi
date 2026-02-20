import Anthropic from '@anthropic-ai/sdk'
import { PlaneClient } from './plane-client.js'
import type { QueuedTask } from './types.js'

export async function runInlineAgent(
  task: QueuedTask,
  secrets: Record<string, string>,
  plane: PlaneClient
): Promise<void> {
  const apiKey = secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('No Anthropic API key available')

  const client = new Anthropic({ apiKey })

  const issueDetails = [
    `Title: ${task.payload.name}`,
    task.payload.description_stripped ? `Description:\n${task.payload.description_stripped}` : '',
    `Priority: ${task.payload.priority}`,
    `State: ${task.payload.state?.name ?? 'Unknown'}`,
  ].filter(Boolean).join('\n\n')

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    system: `You are a senior software engineer and technical lead. You are reviewing tickets from a project management system.

When given a ticket/issue, provide:
1. **Analysis** — What exactly needs to be done and why
2. **Implementation Plan** — Step-by-step technical approach
3. **Code** — Concrete code snippets or pseudocode where relevant
4. **Acceptance Criteria** — How to verify the task is done correctly

Be specific, technical, and actionable. Assume the codebase uses TypeScript/Node.js unless stated otherwise.`,
    messages: [
      {
        role: 'user',
        content: `Please analyze this ticket and provide a complete technical plan:\n\n${issueDetails}`,
      },
    ],
  })

  const response = message.content[0].type === 'text' ? message.content[0].text : ''

  // Format for Plane comment (HTML)
  const html = response
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/```[\w]*\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .split('\n\n')
    .map(p => p.startsWith('<') ? p : `<p>${p}</p>`)
    .join('\n')

  await plane.addComment(
    task.workspaceSlug,
    task.projectId,
    task.issueId,
    `🤖 **Claude Agent Analysis**\n\n${response}`
  )
}
