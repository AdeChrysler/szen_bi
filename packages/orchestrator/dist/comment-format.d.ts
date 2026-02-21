import type { AgentActivity } from './types.js';
export declare function formatProgressComment(activities: AgentActivity[], status?: 'working' | 'complete' | 'error'): string;
export declare function formatFinalResponse(response: string, actor?: string): string;
export declare function formatErrorComment(error: string): string;
export declare function formatAwaitingInput(question: string): string;
export declare function formatThinkingComment(): string;
