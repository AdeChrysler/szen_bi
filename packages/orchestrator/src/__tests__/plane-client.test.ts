import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PlaneClient } from '../plane-client.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('PlaneClient', () => {
  let client: PlaneClient

  beforeEach(() => {
    client = new PlaneClient('http://plane-api:8000', 'test-token')
    mockFetch.mockReset()
  })

  it('updates issue state', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'issue-1' }) })
    await client.updateIssueState('ws', 'proj-1', 'issue-1', 'state-2')
    expect(mockFetch).toHaveBeenCalledWith(
      'http://plane-api:8000/api/v1/workspaces/ws/projects/proj-1/issues/issue-1/',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ state: 'state-2' }) })
    )
  })

  it('posts a comment', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'c1' }) })
    await client.addComment('ws', 'proj-1', 'issue-1', 'Agent started')
    expect(mockFetch).toHaveBeenCalledWith(
      'http://plane-api:8000/api/v1/workspaces/ws/projects/proj-1/issues/issue-1/comments/',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('fetches issue details', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'issue-1', name: 'Test' }) })
    const issue = await client.getIssue('ws', 'proj-1', 'issue-1')
    expect(issue.name).toBe('Test')
  })

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
})
