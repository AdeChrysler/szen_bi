import type Dockerode from 'dockerode';
import type { AgentConfig, QueuedTask, RunningAgent } from './types.js';
export type OnAgentComplete = (taskId: string, agentType: string) => void;
export declare class ContainerManager {
    private docker;
    private running;
    private onComplete;
    constructor(docker: Dockerode);
    setOnComplete(callback: OnAgentComplete): void;
    runAgent(agent: AgentConfig, task: QueuedTask, secrets: Record<string, string>): Promise<string>;
    getRunningCount(agentType: string): number;
    getRunning(): RunningAgent[];
    markCompleted(taskId: string): void;
}
