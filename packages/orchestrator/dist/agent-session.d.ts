import type { Redis } from 'ioredis';
import type { AgentSession, SessionState, AgentActivity } from './types.js';
export declare class InMemorySessionManager {
    private sessions;
    private issueSessions;
    private activeSessions;
    private issueLocks;
    createSession(opts: {
        issueId: string;
        projectId: string;
        workspaceSlug: string;
        mode: 'comment' | 'autonomous';
        triggeredBy: string;
        triggerCommentId: string;
        parentSessionId?: string;
    }): Promise<AgentSession | null>;
    getSession(id: string): Promise<AgentSession | null>;
    updateState(id: string, state: SessionState): Promise<void>;
    addActivity(id: string, activity: AgentActivity): Promise<void>;
    markActivityComplete(id: string, label: string): Promise<void>;
    setProgressCommentId(id: string, commentId: string): Promise<void>;
    setFinalResponse(id: string, response: string): Promise<void>;
    setError(id: string, error: string): Promise<void>;
    getActiveSessionForIssue(issueId: string): Promise<AgentSession | null>;
    getAwaitingSessionForIssue(issueId: string): Promise<AgentSession | null>;
    getActiveSessions(): Promise<AgentSession[]>;
    cleanupStaleSessions(): Promise<number>;
    getSessionsByIssue(issueId: string): Promise<AgentSession[]>;
}
export declare class SessionManager {
    private redis;
    constructor(redis: Redis);
    createSession(opts: {
        issueId: string;
        projectId: string;
        workspaceSlug: string;
        mode: 'comment' | 'autonomous';
        triggeredBy: string;
        triggerCommentId: string;
        parentSessionId?: string;
    }): Promise<AgentSession | null>;
    getSession(id: string): Promise<AgentSession | null>;
    updateState(id: string, state: SessionState): Promise<void>;
    addActivity(id: string, activity: AgentActivity): Promise<void>;
    markActivityComplete(id: string, label: string): Promise<void>;
    setProgressCommentId(id: string, commentId: string): Promise<void>;
    setFinalResponse(id: string, response: string): Promise<void>;
    setError(id: string, error: string): Promise<void>;
    getActiveSessionForIssue(issueId: string): Promise<AgentSession | null>;
    getAwaitingSessionForIssue(issueId: string): Promise<AgentSession | null>;
    getActiveSessions(): Promise<AgentSession[]>;
    cleanupStaleSessions(): Promise<number>;
    getSessionsByIssue(issueId: string): Promise<AgentSession[]>;
    private saveSession;
}
