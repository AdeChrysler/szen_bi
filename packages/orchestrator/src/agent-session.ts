import type { Redis } from 'ioredis'
import type { AgentSession, SessionState, AgentActivity } from './types.js'
import { randomUUID } from 'crypto'

const SESSION_KEY = (id: string) => `zenova:session:${id}`
const ISSUE_SESSIONS_KEY = (issueId: string) => `zenova:issue-sessions:${issueId}`
const ACTIVE_SESSIONS_KEY = 'zenova:active-sessions'
const SESSION_LOCK_KEY = (issueId: string) => `zenova:session-lock:${issueId}`

const STALE_TIMEOUT_MS = 10 * 60 * 1000      // 10 minutes
const TERMINAL_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days

// ─── In-memory SessionManager (works without Redis) ──────────────────────────

export class InMemorySessionManager {
  private sessions = new Map<string, AgentSession>()
  private issueSessions = new Map<string, string[]>()  // issueId -> sessionIds (newest first)
  private activeSessions = new Set<string>()
  private issueLocks = new Map<string, number>()  // issueId -> expiry timestamp

  async createSession(opts: {
    issueId: string
    projectId: string
    workspaceSlug: string
    mode: 'comment' | 'autonomous'
    triggeredBy: string
    triggerCommentId: string
    parentSessionId?: string
  }): Promise<AgentSession | null> {
    // Check lock
    const lockExpiry = this.issueLocks.get(opts.issueId)
    if (lockExpiry && lockExpiry > Date.now()) {
      console.log(`[session-mem] Lock exists for issue ${opts.issueId} — another session is active`)
      return null
    }

    // Set lock (10 min)
    this.issueLocks.set(opts.issueId, Date.now() + 600_000)

    const session: AgentSession = {
      id: randomUUID(),
      issueId: opts.issueId,
      projectId: opts.projectId,
      workspaceSlug: opts.workspaceSlug,
      state: 'pending',
      mode: opts.mode,
      triggeredBy: opts.triggeredBy,
      triggerCommentId: opts.triggerCommentId,
      activities: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      parentSessionId: opts.parentSessionId,
    }

    this.sessions.set(session.id, session)
    const existing = this.issueSessions.get(opts.issueId) ?? []
    existing.unshift(session.id)
    this.issueSessions.set(opts.issueId, existing)
    this.activeSessions.add(session.id)

    console.log(`[session-mem] Created ${session.id} for issue ${opts.issueId} (${opts.mode})`)
    return session
  }

  async getSession(id: string): Promise<AgentSession | null> {
    return this.sessions.get(id) ?? null
  }

  async updateState(id: string, state: SessionState): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    session.state = state
    session.updatedAt = Date.now()
    if (state === 'complete' || state === 'error') {
      this.activeSessions.delete(id)
      this.issueLocks.delete(session.issueId)
    }
  }

  async addActivity(id: string, activity: AgentActivity): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    if (activity.type === 'tool_start' || activity.type === 'text') session.state = 'active'
    session.activities.push(activity)
    session.updatedAt = Date.now()
  }

  async markActivityComplete(id: string, label: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    for (let i = session.activities.length - 1; i >= 0; i--) {
      if (session.activities[i].label === label && !session.activities[i].completed) {
        session.activities[i].completed = true
        break
      }
    }
    session.updatedAt = Date.now()
  }

  async setProgressCommentId(id: string, commentId: string): Promise<void> {
    const session = this.sessions.get(id)
    if (session) session.progressCommentId = commentId
  }

  async setFinalResponse(id: string, response: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    session.finalResponse = response
    session.updatedAt = Date.now()
  }

  async setError(id: string, error: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    session.error = error
    session.state = 'error'
    session.updatedAt = Date.now()
    this.activeSessions.delete(id)
    this.issueLocks.delete(session.issueId)
  }

  async getActiveSessionForIssue(issueId: string): Promise<AgentSession | null> {
    if (!this.issueLocks.has(issueId)) return null
    const ids = this.issueSessions.get(issueId) ?? []
    if (!ids.length) return null
    const session = this.sessions.get(ids[0])
    if (!session) return null
    if (session.state === 'active' || session.state === 'awaiting_input' || session.state === 'pending') return session
    return null
  }

  async getAwaitingSessionForIssue(issueId: string): Promise<AgentSession | null> {
    const ids = this.issueSessions.get(issueId) ?? []
    for (const sid of ids.slice(0, 5)) {
      const session = this.sessions.get(sid)
      if (session?.state === 'awaiting_input') return session
    }
    return null
  }

  async getActiveSessions(): Promise<AgentSession[]> {
    const sessions: AgentSession[] = []
    for (const id of this.activeSessions) {
      const s = this.sessions.get(id)
      if (s) sessions.push(s)
    }
    return sessions
  }

  async cleanupStaleSessions(): Promise<number> {
    let cleaned = 0
    const now = Date.now()
    for (const id of [...this.activeSessions]) {
      const session = this.sessions.get(id)
      if (!session) { this.activeSessions.delete(id); cleaned++; continue }
      if (now - session.updatedAt > STALE_TIMEOUT_MS) {
        console.log(`[session-mem] Cleaning up stale session ${id}`)
        await this.setError(id, 'Session timed out (no activity for 10 minutes)')
        cleaned++
      }
    }
    return cleaned
  }

  async getSessionsByIssue(issueId: string): Promise<AgentSession[]> {
    const ids = this.issueSessions.get(issueId) ?? []
    const sessions: AgentSession[] = []
    for (const id of ids.slice(0, 20)) {
      const s = this.sessions.get(id)
      if (s) sessions.push(s)
    }
    return sessions
  }
}

// ─── Redis-backed SessionManager ─────────────────────────────────────────────

export class SessionManager {
  constructor(private redis: Redis) {}

  async createSession(opts: {
    issueId: string
    projectId: string
    workspaceSlug: string
    mode: 'comment' | 'autonomous'
    triggeredBy: string
    triggerCommentId: string
    parentSessionId?: string
  }): Promise<AgentSession | null> {
    // Concurrent session prevention: try to acquire lock
    const lockKey = SESSION_LOCK_KEY(opts.issueId)
    const lockAcquired = await this.redis.set(lockKey, '1', 'EX', 600, 'NX')
    if (!lockAcquired) {
      console.log(`[session] Lock exists for issue ${opts.issueId} — another session is active`)
      return null
    }

    const session: AgentSession = {
      id: randomUUID(),
      issueId: opts.issueId,
      projectId: opts.projectId,
      workspaceSlug: opts.workspaceSlug,
      state: 'pending',
      mode: opts.mode,
      triggeredBy: opts.triggeredBy,
      triggerCommentId: opts.triggerCommentId,
      activities: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      parentSessionId: opts.parentSessionId,
    }

    await this.saveSession(session)
    await this.redis.zadd(ISSUE_SESSIONS_KEY(opts.issueId), session.createdAt, session.id)
    await this.redis.sadd(ACTIVE_SESSIONS_KEY, session.id)

    console.log(`[session] Created ${session.id} for issue ${opts.issueId} (${opts.mode})`)
    return session
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const data = await this.redis.get(SESSION_KEY(id))
    if (!data) return null
    return JSON.parse(data) as AgentSession
  }

  async updateState(id: string, state: SessionState): Promise<void> {
    const session = await this.getSession(id)
    if (!session) return

    session.state = state
    session.updatedAt = Date.now()

    if (state === 'complete' || state === 'error') {
      await this.redis.srem(ACTIVE_SESSIONS_KEY, id)
      await this.redis.del(SESSION_LOCK_KEY(session.issueId))
      // Set TTL on terminal sessions
      await this.redis.set(SESSION_KEY(id), JSON.stringify(session), 'EX', TERMINAL_TTL_SECONDS)
    } else {
      await this.saveSession(session)
    }
  }

  async addActivity(id: string, activity: AgentActivity): Promise<void> {
    const session = await this.getSession(id)
    if (!session) return

    // Auto-transition state based on activity
    if (activity.type === 'tool_start' || activity.type === 'text') {
      session.state = 'active'
    }

    session.activities.push(activity)
    session.updatedAt = Date.now()
    await this.saveSession(session)
  }

  async markActivityComplete(id: string, label: string): Promise<void> {
    const session = await this.getSession(id)
    if (!session) return

    // Find last matching non-completed activity and mark it complete
    for (let i = session.activities.length - 1; i >= 0; i--) {
      if (session.activities[i].label === label && !session.activities[i].completed) {
        session.activities[i].completed = true
        break
      }
    }
    session.updatedAt = Date.now()
    await this.saveSession(session)
  }

  async setProgressCommentId(id: string, commentId: string): Promise<void> {
    const session = await this.getSession(id)
    if (!session) return
    session.progressCommentId = commentId
    await this.saveSession(session)
  }

  async setFinalResponse(id: string, response: string): Promise<void> {
    const session = await this.getSession(id)
    if (!session) return
    session.finalResponse = response
    session.updatedAt = Date.now()
    await this.saveSession(session)
  }

  async setError(id: string, error: string): Promise<void> {
    const session = await this.getSession(id)
    if (!session) return
    session.error = error
    session.state = 'error'
    session.updatedAt = Date.now()
    await this.redis.srem(ACTIVE_SESSIONS_KEY, id)
    await this.redis.del(SESSION_LOCK_KEY(session.issueId))
    await this.redis.set(SESSION_KEY(id), JSON.stringify(session), 'EX', TERMINAL_TTL_SECONDS)
  }

  async getActiveSessionForIssue(issueId: string): Promise<AgentSession | null> {
    const lockExists = await this.redis.exists(SESSION_LOCK_KEY(issueId))
    if (!lockExists) return null

    // Get most recent session for this issue
    const sessionIds = await this.redis.zrevrange(ISSUE_SESSIONS_KEY(issueId), 0, 0)
    if (!sessionIds.length) return null

    const session = await this.getSession(sessionIds[0])
    if (!session) return null

    // Only return if in an active/awaiting state
    if (session.state === 'active' || session.state === 'awaiting_input' || session.state === 'pending') {
      return session
    }
    return null
  }

  async getAwaitingSessionForIssue(issueId: string): Promise<AgentSession | null> {
    const sessionIds = await this.redis.zrevrange(ISSUE_SESSIONS_KEY(issueId), 0, 5)
    for (const sid of sessionIds) {
      const session = await this.getSession(sid)
      if (session?.state === 'awaiting_input') return session
    }
    return null
  }

  async getActiveSessions(): Promise<AgentSession[]> {
    const ids = await this.redis.smembers(ACTIVE_SESSIONS_KEY)
    const sessions: AgentSession[] = []
    for (const id of ids) {
      const s = await this.getSession(id)
      if (s) sessions.push(s)
    }
    return sessions
  }

  async cleanupStaleSessions(): Promise<number> {
    const ids = await this.redis.smembers(ACTIVE_SESSIONS_KEY)
    let cleaned = 0
    const now = Date.now()

    for (const id of ids) {
      const session = await this.getSession(id)
      if (!session) {
        await this.redis.srem(ACTIVE_SESSIONS_KEY, id)
        cleaned++
        continue
      }

      if (now - session.updatedAt > STALE_TIMEOUT_MS) {
        console.log(`[session] Cleaning up stale session ${id} (${session.state}, last update ${Math.round((now - session.updatedAt) / 1000)}s ago)`)
        await this.setError(id, 'Session timed out (no activity for 10 minutes)')
        cleaned++
      }
    }

    return cleaned
  }

  async getSessionsByIssue(issueId: string): Promise<AgentSession[]> {
    const ids = await this.redis.zrevrange(ISSUE_SESSIONS_KEY(issueId), 0, 20)
    const sessions: AgentSession[] = []
    for (const id of ids) {
      const s = await this.getSession(id)
      if (s) sessions.push(s)
    }
    return sessions
  }

  private async saveSession(session: AgentSession): Promise<void> {
    await this.redis.set(SESSION_KEY(session.id), JSON.stringify(session))
  }
}
