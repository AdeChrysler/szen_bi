export class AgentRouter {
    agents;
    byAssignee;
    byLabel;
    constructor(agents) {
        this.agents = agents;
        this.byAssignee = new Map(agents.map((a) => [a.assigneeId, a]));
        this.byLabel = new Map(agents.map((a) => [a.name, a]));
    }
    routeByAssignee(assigneeId) {
        return this.byAssignee.get(assigneeId);
    }
    routeByLabel(labelName) {
        return this.byLabel.get(labelName.toLowerCase());
    }
    resolve(issue) {
        for (const assigneeId of issue.assignees ?? []) {
            const config = this.routeByAssignee(assigneeId);
            if (config)
                return config;
        }
        for (const label of issue.labels ?? []) {
            const config = this.routeByLabel(label.name);
            if (config)
                return config;
        }
        return undefined;
    }
}
