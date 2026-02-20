import { describe, it, expect, beforeEach } from 'vitest';
import { TaskQueue } from '../queue.js';
class MockRedis {
    store = new Map();
    sorted = new Map();
    async zadd(key, score, member) {
        if (!this.sorted.has(key))
            this.sorted.set(key, []);
        const list = this.sorted.get(key);
        list.push({ score, member });
        list.sort((a, b) => a.score - b.score);
    }
    async zpopmin(key) {
        const list = this.sorted.get(key);
        if (!list || list.length === 0)
            return [];
        const item = list.shift();
        return [item.member, String(item.score)];
    }
    async zcard(key) {
        return this.sorted.get(key)?.length ?? 0;
    }
    async zrange(key, start, stop) {
        const list = this.sorted.get(key) ?? [];
        return list.slice(start, stop + 1).map((i) => i.member);
    }
    async set(key, value) {
        this.store.set(key, value);
    }
    async get(key) {
        return this.store.get(key) ?? null;
    }
    async del(key) {
        this.store.delete(key);
        this.sorted.delete(key);
    }
}
function makeTask(id, priority) {
    return { id, issueId: `issue-${id}`, projectId: 'proj-1', workspaceSlug: 'ws', agentType: 'dev', priority, payload: {}, queuedAt: new Date().toISOString() };
}
describe('TaskQueue', () => {
    let queue;
    beforeEach(() => {
        queue = new TaskQueue(new MockRedis());
    });
    it('enqueues a task', async () => {
        await queue.enqueue(makeTask('t1', 2));
        expect(await queue.depth()).toBe(1);
    });
    it('dequeues highest priority first (lowest number)', async () => {
        await queue.enqueue(makeTask('t1', 2));
        await queue.enqueue(makeTask('t2', 0));
        await queue.enqueue(makeTask('t3', 1));
        const next = await queue.dequeue();
        expect(next?.id).toBe('t2');
    });
    it('returns null when empty', async () => {
        expect(await queue.dequeue()).toBeNull();
    });
});
