import { PlaneClient } from './plane-client.js';
import type { QueuedTask, PlaneCommentPayload } from './types.js';
export declare function isActionRequest(text: string): boolean;
export declare function runInlineAgent(task: QueuedTask, secrets: Record<string, string>, plane: PlaneClient): Promise<void>;
export declare function runCommentAgent(commentData: PlaneCommentPayload['data'], issueDetails: any, secrets: Record<string, string>, plane: PlaneClient): Promise<void>;
export declare function runAutonomousAgent(commentData: PlaneCommentPayload['data'], issueDetails: any, secrets: Record<string, string>, plane: PlaneClient): Promise<void>;
