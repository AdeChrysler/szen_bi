import type Dockerode from 'dockerode'
import type { AgentConfig, QueuedTask, RunningAgent } from './types.js'

export class ContainerManager {
  private running = new Map<string, RunningAgent>()

  constructor(private docker: Dockerode) {}

  async runAgent(agent: AgentConfig, task: QueuedTask, secrets: Record<string, string>): Promise<string> {
    const containerName = `zenova-agent-${agent.name}-${task.id}-${Date.now()}`
    const env = [
      `TASK_ID=${task.id}`,
      `ISSUE_ID=${task.issueId}`,
      `PROJECT_ID=${task.projectId}`,
      `WORKSPACE_SLUG=${task.workspaceSlug}`,
      `ISSUE_TITLE=${task.payload.name || ''}`,
      `ISSUE_DESCRIPTION=${task.payload.description_stripped || ''}`,
      `AGENT_TYPE=${agent.name}`,
      ...Object.entries(secrets).map(([k, v]) => `${k}=${v}`),
    ]
    const container = await this.docker.createContainer({
      Image: agent.dockerImage,
      name: containerName,
      Env: env,
      HostConfig: {
        Memory: 2 * 1024 * 1024 * 1024,
        NanoCpus: 2 * 1e9,
        AutoRemove: false,
      },
    })
    await container.start()
    this.running.set(task.id, {
      taskId: task.id, containerId: container.id, agentType: agent.name,
      issueId: task.issueId, startedAt: new Date().toISOString(),
    })
    setTimeout(async () => {
      if (this.running.has(task.id)) {
        try {
          const c = this.docker.getContainer(container.id)
          await c.stop({ t: 10 })
          await c.remove()
        } catch {}
        this.running.delete(task.id)
      }
    }, agent.timeout * 1000)
    return container.id
  }

  getRunningCount(agentType: string): number {
    return [...this.running.values()].filter(r => r.agentType === agentType).length
  }

  getRunning(): RunningAgent[] { return [...this.running.values()] }
  markCompleted(taskId: string): void { this.running.delete(taskId) }
}
