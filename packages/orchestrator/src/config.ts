import { readFileSync } from 'fs'
import { parse } from 'yaml'
import { AgentRouter } from './router.js'
import type { AgentConfig, PlaneWebhookPayload } from './types.js'

export function loadAgentConfigs(configPath: string): AgentConfig[] {
  const raw = readFileSync(configPath, 'utf-8')
  const parsed = parse(raw)
  return parsed.agents as AgentConfig[]
}

const PRIORITY_MAP: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }

export class Dispatcher {
  private router: AgentRouter
  constructor(private agents: AgentConfig[]) { this.router = new AgentRouter(agents) }

  shouldDispatch(payload: PlaneWebhookPayload): { agentConfig: AgentConfig; priority: number } | null {
    if (payload.event !== 'issue') return null
    const agentConfig = this.router.resolve({ assignees: payload.data.assignees, labels: payload.data.labels })
    if (!agentConfig) return null
    return { agentConfig, priority: PRIORITY_MAP[payload.data.priority] ?? 2 }
  }
}
