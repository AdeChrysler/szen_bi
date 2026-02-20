const QUEUE_KEY = 'zenova:task-queue';
const TASK_PREFIX = 'zenova:task:';
export class TaskQueue {
    redis;
    constructor(redis) {
        this.redis = redis;
    }
    async enqueue(task) {
        await this.redis.set(`${TASK_PREFIX}${task.id}`, JSON.stringify(task));
        await this.redis.zadd(QUEUE_KEY, task.priority, task.id);
    }
    async dequeue() {
        const result = await this.redis.zpopmin(QUEUE_KEY);
        if (!result || result.length === 0)
            return null;
        const taskId = result[0];
        const data = await this.redis.get(`${TASK_PREFIX}${taskId}`);
        if (!data)
            return null;
        await this.redis.del(`${TASK_PREFIX}${taskId}`);
        return JSON.parse(data);
    }
    async depth() {
        return this.redis.zcard(QUEUE_KEY);
    }
    async peek(count = 10) {
        return this.redis.zrange(QUEUE_KEY, 0, count - 1);
    }
}
