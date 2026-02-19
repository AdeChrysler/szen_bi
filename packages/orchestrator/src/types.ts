export interface PlaneWebhookPayload {
  event: string
  action: string
  data: {
    id: string
    name: string
    description_html?: string
    description_stripped?: string
    priority: 'urgent' | 'high' | 'medium' | 'low' | 'none'
    state: { name: string; group: string }
    assignees: string[]
    labels: Array<{ id: string; name: string }>
    project: string
    workspace: string
  }
}

export interface AgentConfig {
  name: string
  assigneeId: string
  dockerImage: string
  tools: string[]
  timeout: number
  maxConcurrency: number
  promptFile: string
}

export interface QueuedTask {
  id: string
  issueId: string
  projectId: string
  workspaceSlug: string
  agentType: string
  priority: number
  payload: PlaneWebhookPayload['data']
  queuedAt: string
}

export interface RunningAgent {
  taskId: string
  containerId: string
  agentType: string
  issueId: string
  startedAt: string
}
