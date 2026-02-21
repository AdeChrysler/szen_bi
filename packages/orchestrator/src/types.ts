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

export interface PlaneCommentPayload {
  event: 'comment' | 'issue_comment'
  action: 'created' | 'updated' | 'deleted'
  data: {
    id: string
    issue: string              // Plane sends issue UUID here
    issue_id: string           // set by normalizer (= issue)
    project: string
    workspace: string          // normalized to slug by normalizer
    comment_stripped: string   // normalized from comment_html if missing
    comment_html: string
    actor?: string             // actor user ID
    actor_detail?: { id: string; display_name: string }
    external_source?: string
    external_id?: string
    created_by?: string
  }
}

// ─── Agent Session Types ────────────────────────────────────────────────────

export type SessionState = 'pending' | 'active' | 'awaiting_input' | 'error' | 'complete'

export type ActivityType = 'thought' | 'tool_start' | 'tool_result' | 'text' | 'error' | 'system'

export interface AgentActivity {
  type: ActivityType
  label: string        // human-readable (e.g. "Reading files", "Searching codebase")
  timestamp: number
  detail?: string      // tool name, file path, etc.
  completed?: boolean
}

export interface AgentSession {
  id: string
  issueId: string
  projectId: string
  workspaceSlug: string
  state: SessionState
  mode: 'comment' | 'autonomous'
  triggeredBy: string         // actor display name
  triggerCommentId: string
  progressCommentId?: string  // Plane comment ID for in-place updates
  activities: AgentActivity[]
  finalResponse?: string
  error?: string
  createdAt: number
  updatedAt: number
  parentSessionId?: string    // for follow-up sessions
}

// ─── Claude CLI Stream Types ────────────────────────────────────────────────

export interface StreamMessage {
  type: 'assistant' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_start' | 'message_delta' | 'message_stop' | 'result' | 'system'
  subtype?: string
  [key: string]: any
}

export interface StreamContent {
  type: 'text' | 'tool_use'
  text?: string
  id?: string
  name?: string
  input?: any
}
