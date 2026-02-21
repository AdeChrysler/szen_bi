import type { AgentActivity } from './types.js';
export declare function formatProgressComment(activities: AgentActivity[], status?: 'working' | 'complete' | 'error'): string;
export declare function formatFinalResponse(response: string, actor?: string): string;
export declare function formatErrorComment(error: string): string;
/** Combined comment: completed progress steps + final response, all in one comment */
export declare function formatFinalCombinedComment(activities: AgentActivity[], response: string, actor?: string): string;
/** Combined comment: completed progress steps + error, all in one comment */
export declare function formatErrorCombinedComment(activities: AgentActivity[], error: string): string;
export declare function formatAwaitingInput(question: string): string;
export declare function formatThinkingComment(): string;
