import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { AgentRouter } from './router.js';
export function loadAgentConfigs(configPath) {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parse(raw);
    return parsed.agents;
}
const PRIORITY_MAP = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
export class Dispatcher {
    agents;
    router;
    constructor(agents) {
        this.agents = agents;
        this.router = new AgentRouter(agents);
    }
    shouldDispatch(payload) {
        if (payload.event !== 'issue')
            return null;
        const agentConfig = this.router.resolve({ assignees: payload.data.assignees, labels: payload.data.labels });
        if (!agentConfig)
            return null;
        return { agentConfig, priority: PRIORITY_MAP[payload.data.priority] ?? 2 };
    }
}
