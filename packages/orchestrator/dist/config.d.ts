import type { AgentConfig, PlaneWebhookPayload } from './types.js';
export declare function loadAgentConfigs(configPath: string): AgentConfig[];
export declare class Dispatcher {
    private agents;
    private router;
    constructor(agents: AgentConfig[]);
    shouldDispatch(payload: PlaneWebhookPayload): {
        agentConfig: AgentConfig;
        priority: number;
    } | null;
}
