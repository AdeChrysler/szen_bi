import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContainerManager } from '../docker.js';
const mockContainer = { start: vi.fn(), wait: vi.fn().mockReturnValue(new Promise(() => { })), logs: vi.fn().mockResolvedValue('output'), remove: vi.fn(), id: 'container-123' };
const mockDocker = { createContainer: vi.fn().mockResolvedValue(mockContainer), getContainer: vi.fn().mockReturnValue(mockContainer) };
describe('ContainerManager', () => {
    let manager;
    beforeEach(() => { manager = new ContainerManager(mockDocker); vi.clearAllMocks(); });
    it('creates container with correct image', async () => {
        mockContainer.wait.mockReturnValue(new Promise(() => { }));
        const agent = { name: 'dev', assigneeId: 'a1', dockerImage: 'zenova/agent-dev:latest', tools: [], timeout: 1800, maxConcurrency: 3, promptFile: '' };
        const task = { id: 'task-1', issueId: 'issue-1', projectId: 'proj-1', workspaceSlug: 'ws', agentType: 'dev', priority: 2, payload: { name: 'Test' }, queuedAt: new Date().toISOString() };
        const containerId = await manager.runAgent(agent, task, { GITHUB_TOKEN: 'gh-tok' });
        expect(mockDocker.createContainer).toHaveBeenCalledWith(expect.objectContaining({ Image: 'zenova/agent-dev:latest' }));
        expect(mockContainer.start).toHaveBeenCalled();
        expect(containerId).toBe('container-123');
    });
    it('tracks running containers', async () => {
        mockContainer.wait.mockReturnValue(new Promise(() => { }));
        const agent = { name: 'dev', assigneeId: 'a1', dockerImage: 'zenova/agent-dev:latest', tools: [], timeout: 1800, maxConcurrency: 3, promptFile: '' };
        const task = { id: 'task-1', issueId: 'i1', projectId: 'p1', workspaceSlug: 'ws', agentType: 'dev', priority: 2, payload: {}, queuedAt: new Date().toISOString() };
        await manager.runAgent(agent, task, {});
        expect(manager.getRunningCount('dev')).toBe(1);
    });
    it('removes container from running after completion', async () => {
        let resolveWait;
        mockContainer.wait.mockReturnValue(new Promise(r => { resolveWait = r; }));
        const agent = { name: 'dev', assigneeId: 'a1', dockerImage: 'zenova/agent-dev:latest', tools: [], timeout: 1800, maxConcurrency: 3, promptFile: '' };
        const task = { id: 'task-2', issueId: 'i2', projectId: 'p1', workspaceSlug: 'ws', agentType: 'dev', priority: 2, payload: {}, queuedAt: new Date().toISOString() };
        await manager.runAgent(agent, task, {});
        expect(manager.getRunningCount('dev')).toBe(1);
        resolveWait({ StatusCode: 0 });
        await new Promise(r => setTimeout(r, 10));
        expect(manager.getRunningCount('dev')).toBe(0);
    });
});
