import type { AgentConfig } from './types.js';
export declare class AgentRouter {
    private agents;
    private byAssignee;
    private byLabel;
    constructor(agents: AgentConfig[]);
    routeByAssignee(assigneeId: string): AgentConfig | undefined;
    routeByLabel(labelName: string): AgentConfig | undefined;
    resolve(issue: {
        assignees?: string[];
        labels?: Array<{
            id: string;
            name: string;
        }>;
    }): AgentConfig | undefined;
}
