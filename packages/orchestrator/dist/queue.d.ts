import type { Redis } from 'ioredis';
import type { QueuedTask } from './types.js';
export declare class TaskQueue {
    private redis;
    constructor(redis: Redis);
    enqueue(task: QueuedTask): Promise<void>;
    dequeue(): Promise<QueuedTask | null>;
    depth(): Promise<number>;
    peek(count?: number): Promise<string[]>;
}
