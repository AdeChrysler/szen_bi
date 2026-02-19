import type { AgentConfig } from './types.js'

export class AgentRouter {
  private byAssignee: Map<string, AgentConfig>
  private byLabel: Map<string, AgentConfig>

  constructor(private agents: AgentConfig[]) {
    this.byAssignee = new Map(agents.map((a) => [a.assigneeId, a]))
    this.byLabel = new Map(agents.map((a) => [a.name, a]))
  }

  routeByAssignee(assigneeId: string): AgentConfig | undefined {
    return this.byAssignee.get(assigneeId)
  }

  routeByLabel(labelName: string): AgentConfig | undefined {
    return this.byLabel.get(labelName.toLowerCase())
  }

  resolve(issue: { assignees: string[]; labels: Array<{ id: string; name: string }> }): AgentConfig | undefined {
    for (const assigneeId of issue.assignees) {
      const config = this.routeByAssignee(assigneeId)
      if (config) return config
    }
    for (const label of issue.labels) {
      const config = this.routeByLabel(label.name)
      if (config) return config
    }
    return undefined
  }
}
