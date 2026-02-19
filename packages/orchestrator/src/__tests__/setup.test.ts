import { describe, it, expect, vi, beforeEach } from 'vitest'
import { bootstrapWorkspace } from '../setup.js'

const mockPlane = {
  getWorkspaceMembers: vi.fn(),
  registerWebhook: vi.fn(),
}

vi.mock('../plane-client.js', () => ({
  PlaneClient: vi.fn().mockImplementation(() => mockPlane),
}))

describe('bootstrapWorkspace', () => {
  beforeEach(() => vi.clearAllMocks())

  it('throws when plane credentials are invalid', async () => {
    mockPlane.getWorkspaceMembers.mockRejectedValueOnce(new Error('401'))
    await expect(
      bootstrapWorkspace({ planeUrl: 'http://plane', apiToken: 'bad', workspaceSlug: 'ws', webhookUrl: 'http://hook', redis: null as any })
    ).rejects.toThrow('401')
  })

  it('registers webhook on success', async () => {
    mockPlane.getWorkspaceMembers.mockResolvedValueOnce([])
    mockPlane.registerWebhook.mockResolvedValueOnce({ id: 'wh1', url: 'http://hook' })
    const result = await bootstrapWorkspace({
      planeUrl: 'http://plane', apiToken: 'tok', workspaceSlug: 'ws',
      webhookUrl: 'http://hook', redis: null as any,
    })
    expect(mockPlane.registerWebhook).toHaveBeenCalledWith('ws', 'http://hook', expect.any(String))
    expect(result.webhookId).toBe('wh1')
    expect(result.webhookSecret).toEqual(expect.any(String))
  })

  it('returns member count', async () => {
    mockPlane.getWorkspaceMembers.mockResolvedValueOnce([{ id: 'm1' }, { id: 'm2' }])
    mockPlane.registerWebhook.mockResolvedValueOnce({ id: 'wh2', url: 'http://hook' })
    const result = await bootstrapWorkspace({
      planeUrl: 'http://plane', apiToken: 'tok', workspaceSlug: 'ws',
      webhookUrl: 'http://hook', redis: null as any,
    })
    expect(result.memberCount).toBe(2)
  })
})
