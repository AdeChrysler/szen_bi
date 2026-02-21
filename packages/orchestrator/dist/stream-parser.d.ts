import { EventEmitter } from 'events';
import type { Readable } from 'stream';
export type StreamEventType = 'text' | 'tool_start' | 'tool_result' | 'system' | 'error' | 'result';
export interface ParsedStreamEvent {
    type: StreamEventType;
    text?: string;
    toolName?: string;
    toolId?: string;
    toolInput?: any;
    toolResult?: string;
    raw: any;
}
/**
 * Parses Claude CLI --output-format stream-json NDJSON output.
 *
 * Claude CLI stream-json emits one JSON object per line:
 * - { type: "assistant", message: { content: [...] } }  → final result
 * - { type: "content_block_start", content_block: { type: "tool_use", name: "..." } }
 * - { type: "content_block_delta", delta: { type: "text_delta", text: "..." } }
 * - { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "..." } }
 * - { type: "content_block_stop" }
 * - { type: "message_start" | "message_delta" | "message_stop" }
 * - { type: "result", result: "...", ... }  → final summary
 * - { type: "system", ... }  → system messages
 */
export declare class StreamParser extends EventEmitter {
    private buffer;
    private fullText;
    private currentTool;
    constructor(stream: Readable);
    getFullText(): string;
    private onData;
    private onEnd;
    private parseLine;
}
/** Map tool names to human-readable activity labels */
export declare function toolDisplayName(toolName: string): string;
