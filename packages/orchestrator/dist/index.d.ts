import { Hono } from 'hono';
import { Dispatcher } from './config.js';
import { TaskQueue } from './queue.js';
import { ContainerManager } from './docker.js';
import { PlaneClient } from './plane-client.js';
export declare const app: Hono<import("hono/types").BlankEnv, import("hono/types").BlankSchema, "/">;
export declare function init(deps: {
    dispatcher: Dispatcher;
    queue: TaskQueue;
    containers: ContainerManager;
    plane: PlaneClient;
    webhookSecret?: string;
    redis?: any;
}): void;
export default app;
