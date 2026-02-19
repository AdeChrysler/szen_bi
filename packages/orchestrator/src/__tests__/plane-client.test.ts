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
})
