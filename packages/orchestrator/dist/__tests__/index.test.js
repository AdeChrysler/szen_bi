import { describe, it, expect } from 'vitest';
import { app } from '../index.js';
describe('orchestrator server', () => {
    it('health check returns ok', async () => {
        const res = await app.request('/health');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('ok');
    });
    it('webhook endpoint returns 503 when not initialized', async () => {
        const res = await app.request('/webhooks/plane', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'issue', action: 'updated', data: { id: 'i1', name: 'Test', priority: 'high', state: { name: 'Todo', group: 'backlog' }, assignees: ['a1'], labels: [], project: 'p1', workspace: 'w1' } })
        });
        expect(res.status).toBe(503);
    });
    it('stores and retrieves workspace-scoped config via API', async () => {
        const res1 = await app.request('/admin/api/settings/my-workspace', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { GITHUB_TOKEN: 'ghp_abc123' }, repos: {} }),
        });
        expect(res1.status).toBe(200);
        const res2 = await app.request('/admin/api/settings/my-workspace');
        expect(res2.status).toBe(200);
        const data = await res2.json();
        expect(data.settings).toBeDefined();
    });
    it('/setup returns 400 when required params missing', async () => {
        const res = await app.request('/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ planeUrl: 'http://plane' }),
        });
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.ok).toBe(false);
    });
});
