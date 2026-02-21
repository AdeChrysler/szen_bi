import type { PlaneClient } from './plane-client.js';
import type { SessionManager, InMemorySessionManager } from './agent-session.js';
import type { ParsedStreamEvent } from './stream-parser.js';
export declare class ProgressReporter {
    private plane;
    private sessionManager;
    private sessionId;
    private workspace;
    private projectId;
    private issueId;
    private progressCommentId;
    private activities;
    private lastUpdateTime;
    private pendingUpdate;
    private throttleTimer;
    private currentToolLabel;
    constructor(plane: PlaneClient, sessionManager: SessionManager | InMemorySessionManager, sessionId: string, workspace: string, projectId: string, issueId: string);
    /** Post the initial "thinking" comment. Call this immediately on trigger. */
    postThinkingComment(): Promise<string | null>;
    /** Handle a parsed stream event from the Claude CLI */
    handleEvent(event: ParsedStreamEvent): Promise<void>;
    /** Mark all in-progress activities as complete and update the progress comment to "Complete" */
    finalize(finalResponse: string, actor?: string): Promise<void>;
    /** Post error and clean up */
    finalizeError(error: string): Promise<void>;
    private markCurrentComplete;
    private scheduleUpdate;
    private flushUpdate;
    private clearThrottle;
}
