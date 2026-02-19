import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContainerManager } from '../docker.js'
import type { AgentConfig, QueuedTask } from '../types.js'

const mockContainer = { start: vi.fn(), wait: vi.fn().mockResolvedValue({ StatusCode: 0 }), logs: vi.fn().mockResolvedValue('output'), remove: vi.fn(), id: 'container-123' }
const mockDocker = { createContainer: vi.fn().mockResolvedValue(mockContainer), getContainer: vi.fn().mockReturnValue(mockContainer) }

describe('ContainerManager', () => {
  let manager: ContainerManager
  beforeEach(() => { manager = new ContainerManager(mockDocker as any); vi.clearAllMocks() })

  it('creates container with correct image', async () => {
    const agent: AgentConfig = { name: 'dev', assigneeId: 'a1', dockerImage: 'zenova/agent-dev:latest', tools: [], timeout: 1800, maxConcurrency: 3, promptFile: '' }
    const task: QueuedTask = { id: 'task-1', issueId: 'issue-1', projectId: 'proj-1', workspaceSlug: 'ws', agentType: 'dev', priority: 2, payload: { name: 'Test' } as any, queuedAt: new Date().toISOString() }
    const containerId = await manager.runAgent(agent, task, { GITHUB_TOKEN: 'gh-tok' })
    expect(mockDocker.createContainer).toHaveBeenCalledWith(expect.objectContaining({ Image: 'zenova/agent-dev:latest' }))
    expect(mockContainer.start).toHaveBeenCalled()
    expect(containerId).toBe('container-123')
  })

  it('tracks running containers', async () => {
    const agent: AgentConfig = { name: 'dev', assigneeId: 'a1', dockerImage: 'zenova/agent-dev:latest', tools: [], timeout: 1800, maxConcurrency: 3, promptFile: '' }
    const task: QueuedTask = { id: 'task-1', issueId: 'i1', projectId: 'p1', workspaceSlug: 'ws', agentType: 'dev', priority: 2, payload: {} as any, queuedAt: new Date().toISOString() }
    await manager.runAgent(agent, task, {})
    expect(manager.getRunningCount('dev')).toBe(1)
  })
})
