import { PlaneClient } from './plane-client.js';
import { SessionManager, InMemorySessionManager } from './agent-session.js';
import type { QueuedTask, PlaneCommentPayload } from './types.js';
export declare function isActionRequest(text: string): boolean;
export interface RunAgentOpts {
    commentData: PlaneCommentPayload['data'];
    issueDetails: any;
    secrets: Record<string, string>;
    plane: PlaneClient;
    sessionManager: SessionManager | InMemorySessionManager;
    mode: 'comment' | 'autonomous';
    followUpSessionId?: string;
}
export declare function runAgent(opts: RunAgentOpts): Promise<void>;
export declare function runInlineAgent(task: QueuedTask, secrets: Record<string, string>, plane: PlaneClient): Promise<void>;
