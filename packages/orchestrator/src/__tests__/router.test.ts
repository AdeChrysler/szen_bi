import { describe, it, expect } from 'vitest'
import { AgentRouter } from '../router.js'
import type { AgentConfig } from '../types.js'

const agents: AgentConfig[] = [
  { name: 'dev', assigneeId: 'agent-dev-id', dockerImage: 'zenova/agent-dev:latest', tools: ['claude-code', 'codex', 'git'], timeout: 1800, maxConcurrency: 3, promptFile: 'agents/dev/prompt.md' },
  { name: 'creative', assigneeId: 'agent-creative-id', dockerImage: 'zenova/agent-creative:latest', tools: ['openai-dalle'], timeout: 900, maxConcurrency: 2, promptFile: 'agents/creative/prompt.md' },
]

describe('AgentRouter', () => {
  const router = new AgentRouter(agents)

  it('routes by assignee ID', () => {
    expect(router.routeByAssignee('agent-dev-id')?.name).toBe('dev')
  })

  it('routes by label name', () => {
    expect(router.routeByLabel('creative')?.name).toBe('creative')
  })

  it('returns undefined for unknown assignee', () => {
    expect(router.routeByAssignee('unknown')).toBeUndefined()
  })

  it('resolves agent from issue data (assignee priority)', () => {
    expect(router.resolve({ assignees: ['agent-dev-id'], labels: [{ id: 'l1', name: 'creative' }] })?.name).toBe('dev')
  })

  it('falls back to label when no assignee matches', () => {
    expect(router.resolve({ assignees: ['human-id'], labels: [{ id: 'l1', name: 'creative' }] })?.name).toBe('creative')
  })
})
