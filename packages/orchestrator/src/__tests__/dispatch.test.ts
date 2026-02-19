import { describe, it, expect } from 'vitest'
import { Dispatcher } from '../config.js'
import type { AgentConfig, PlaneWebhookPayload } from '../types.js'

const agents: AgentConfig[] = [{ name: 'dev', assigneeId: 'agent-dev-uuid', dockerImage: 'zenova/agent-dev', tools: [], timeout: 1800, maxConcurrency: 3, promptFile: '' }]

describe('Dispatcher', () => {
  it('identifies agent-assignable issue', () => {
    const dispatcher = new Dispatcher(agents)
    const payload: PlaneWebhookPayload = { event: 'issue', action: 'updated', data: { id: 'i1', name: 'Test', priority: 'high', state: { name: 'Todo', group: 'backlog' }, assignees: ['agent-dev-uuid'], labels: [], project: 'p1', workspace: 'w1' } }
    const result = dispatcher.shouldDispatch(payload)
    expect(result).not.toBeNull()
    expect(result!.agentConfig.name).toBe('dev')
    expect(result!.priority).toBe(1)
  })

  it('ignores non-agent issues', () => {
    const dispatcher = new Dispatcher(agents)
    const payload: PlaneWebhookPayload = { event: 'issue', action: 'updated', data: { id: 'i2', name: 'Human task', priority: 'medium', state: { name: 'Todo', group: 'backlog' }, assignees: ['human-uuid'], labels: [], project: 'p1', workspace: 'w1' } }
    expect(dispatcher.shouldDispatch(payload)).toBeNull()
  })

  it('ignores non-issue events', () => {
    const dispatcher = new Dispatcher(agents)
    const payload: PlaneWebhookPayload = { event: 'project', action: 'updated', data: {} as any }
    expect(dispatcher.shouldDispatch(payload)).toBeNull()
  })
})
