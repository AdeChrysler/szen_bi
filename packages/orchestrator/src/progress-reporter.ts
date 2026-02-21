import type { PlaneClient } from './plane-client.js'
import type { SessionManager, InMemorySessionManager } from './agent-session.js'
import type { ParsedStreamEvent } from './stream-parser.js'
import type { AgentActivity } from './types.js'
import { toolDisplayName } from './stream-parser.js'
import { formatProgressComment, formatThinkingComment, formatFinalResponse, formatErrorComment } from './comment-format.js'

const THROTTLE_MS = 7_000  // Max 1 Plane API call per 7 seconds

export class ProgressReporter {
  private progressCommentId: string | null = null
  private activities: AgentActivity[] = []
  private lastUpdateTime = 0
  private pendingUpdate = false
  private throttleTimer: ReturnType<typeof setTimeout> | null = null
  private currentToolLabel: string | null = null

  constructor(
    private plane: PlaneClient,
    private sessionManager: SessionManager | InMemorySessionManager,
    private sessionId: string,
    private workspace: string,
    private projectId: string,
    private issueId: string,
  ) {}

  /** Post the initial "thinking" comment. Call this immediately on trigger. */
  async postThinkingComment(): Promise<string | null> {
    try {
      const html = formatThinkingComment()
      const result = await this.plane.addCommentHtml(
        this.workspace,
        this.projectId,
        this.issueId,
        html,
        { external_source: 'zenova-agent', external_id: `progress-${this.sessionId}` }
      )
      this.progressCommentId = result.id
      await this.sessionManager.setProgressCommentId(this.sessionId, result.id)
      console.log(`[progress] Posted thinking comment ${result.id} for session ${this.sessionId}`)
      return result.id
    } catch (err) {
      console.error(`[progress] Failed to post thinking comment:`, err)
      return null
    }
  }

  /** Handle a parsed stream event from the Claude CLI */
  async handleEvent(event: ParsedStreamEvent): Promise<void> {
    switch (event.type) {
      case 'tool_start': {
        const label = toolDisplayName(event.toolName ?? 'unknown')
        // Avoid duplicate consecutive labels
        if (this.currentToolLabel && this.currentToolLabel !== label) {
          this.markCurrentComplete()
        }
        // Check if this label already exists as non-completed
        const existing = this.activities.find(a => a.label === label && !a.completed)
        if (!existing) {
          const activity: AgentActivity = {
            type: 'tool_start',
            label,
            timestamp: Date.now(),
            detail: event.toolName,
          }
          this.activities.push(activity)
          await this.sessionManager.addActivity(this.sessionId, activity)
        }
        this.currentToolLabel = label
        this.scheduleUpdate()
        break
      }

      case 'tool_result': {
        this.markCurrentComplete()
        this.scheduleUpdate()
        break
      }

      case 'text': {
        // Text deltas don't need activity tracking, but update session state
        if (this.activities.length === 0) {
          const activity: AgentActivity = {
            type: 'text',
            label: 'Analyzing the request',
            timestamp: Date.now(),
            completed: true,
          }
          this.activities.push(activity)
          await this.sessionManager.addActivity(this.sessionId, activity)
          this.scheduleUpdate()
        }
        break
      }

      case 'error': {
        const activity: AgentActivity = {
          type: 'error',
          label: 'Error encountered',
          timestamp: Date.now(),
          detail: event.text,
        }
        this.activities.push(activity)
        await this.sessionManager.addActivity(this.sessionId, activity)
        this.scheduleUpdate()
        break
      }
    }
  }

  /** Mark all in-progress activities as complete and update the progress comment to "Complete" */
  async finalize(finalResponse: string, actor?: string): Promise<void> {
    this.clearThrottle()

    // Mark remaining activities as complete
    for (const a of this.activities) {
      if (!a.completed) a.completed = true
    }

    // Update progress comment to show "Complete"
    if (this.progressCommentId) {
      try {
        const html = formatProgressComment(this.activities, 'complete')
        await this.plane.updateComment(this.workspace, this.projectId, this.issueId, this.progressCommentId, html)
      } catch (err) {
        console.error(`[progress] Failed to update progress comment:`, err)
      }
    }

    // Post separate final response comment
    try {
      const html = formatFinalResponse(finalResponse, actor)
      await this.plane.addCommentHtml(
        this.workspace,
        this.projectId,
        this.issueId,
        html,
        { external_source: 'zenova-agent', external_id: `response-${this.sessionId}` }
      )
    } catch (err) {
      console.error(`[progress] Failed to post final response:`, err)
    }

    await this.sessionManager.setFinalResponse(this.sessionId, finalResponse)
    await this.sessionManager.updateState(this.sessionId, 'complete')
  }

  /** Post error and clean up */
  async finalizeError(error: string): Promise<void> {
    this.clearThrottle()

    // Update progress comment to show error
    if (this.progressCommentId) {
      try {
        const html = formatProgressComment(this.activities, 'error')
        await this.plane.updateComment(this.workspace, this.projectId, this.issueId, this.progressCommentId, html)
      } catch (err) {
        console.error(`[progress] Failed to update progress comment on error:`, err)
      }
    }

    // Post error comment
    try {
      const html = formatErrorComment(error)
      await this.plane.addCommentHtml(
        this.workspace,
        this.projectId,
        this.issueId,
        html,
        { external_source: 'zenova-agent', external_id: `error-${this.sessionId}` }
      )
    } catch (err) {
      console.error(`[progress] Failed to post error comment:`, err)
    }

    await this.sessionManager.setError(this.sessionId, error)
  }

  private markCurrentComplete() {
    if (this.currentToolLabel) {
      const activity = this.activities.find(a => a.label === this.currentToolLabel && !a.completed)
      if (activity) {
        activity.completed = true
        this.sessionManager.markActivityComplete(this.sessionId, this.currentToolLabel).catch(() => {})
      }
      this.currentToolLabel = null
    }
  }

  private scheduleUpdate() {
    const now = Date.now()
    const elapsed = now - this.lastUpdateTime

    if (elapsed >= THROTTLE_MS) {
      this.flushUpdate()
    } else if (!this.pendingUpdate) {
      this.pendingUpdate = true
      this.throttleTimer = setTimeout(() => {
        this.pendingUpdate = false
        this.flushUpdate()
      }, THROTTLE_MS - elapsed)
    }
  }

  private flushUpdate() {
    this.lastUpdateTime = Date.now()
    if (!this.progressCommentId) return

    const html = formatProgressComment(this.activities, 'working')
    this.plane.updateComment(this.workspace, this.projectId, this.issueId, this.progressCommentId, html)
      .catch(err => console.error(`[progress] Failed to update progress:`, err))
  }

  private clearThrottle() {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer)
      this.throttleTimer = null
    }
    this.pendingUpdate = false
  }
}
