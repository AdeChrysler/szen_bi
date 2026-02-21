import { EventEmitter } from 'events';
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
export class StreamParser extends EventEmitter {
    buffer = '';
    fullText = '';
    currentTool = null;
    constructor(stream) {
        super();
        stream.on('data', (chunk) => this.onData(chunk));
        stream.on('end', () => this.onEnd());
        stream.on('error', (err) => this.emit('error', err));
    }
    getFullText() {
        return this.fullText;
    }
    onData(chunk) {
        this.buffer += chunk.toString();
        const lines = this.buffer.split('\n');
        // Keep the last (possibly incomplete) line in the buffer
        this.buffer = lines.pop() ?? '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            this.parseLine(trimmed);
        }
    }
    onEnd() {
        // Process any remaining data in buffer
        if (this.buffer.trim()) {
            this.parseLine(this.buffer.trim());
            this.buffer = '';
        }
        this.emit('done', this.fullText);
    }
    parseLine(line) {
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            // Malformed JSON — skip
            return;
        }
        const type = obj.type;
        if (!type)
            return;
        switch (type) {
            case 'content_block_start': {
                const block = obj.content_block;
                if (block?.type === 'tool_use') {
                    this.currentTool = { name: block.name ?? 'unknown', id: block.id ?? '' };
                    const event = {
                        type: 'tool_start',
                        toolName: this.currentTool.name,
                        toolId: this.currentTool.id,
                        raw: obj,
                    };
                    this.emit('event', event);
                }
                break;
            }
            case 'content_block_delta': {
                const delta = obj.delta;
                if (delta?.type === 'text_delta' && delta.text) {
                    this.fullText += delta.text;
                    const event = { type: 'text', text: delta.text, raw: obj };
                    this.emit('event', event);
                }
                // input_json_delta for tool inputs — we don't need to track these
                break;
            }
            case 'content_block_stop': {
                if (this.currentTool) {
                    this.currentTool = null;
                }
                break;
            }
            case 'result': {
                // Final result message from Claude CLI
                const resultText = obj.result ?? '';
                if (resultText && !this.fullText) {
                    this.fullText = resultText;
                }
                const event = { type: 'result', text: resultText, raw: obj };
                this.emit('event', event);
                break;
            }
            case 'assistant': {
                // Full assistant message (sometimes emitted as final summary)
                const content = obj.message?.content ?? [];
                for (const block of content) {
                    if (block.type === 'text' && block.text) {
                        if (!this.fullText)
                            this.fullText = block.text;
                    }
                    if (block.type === 'tool_use') {
                        const event = {
                            type: 'tool_start',
                            toolName: block.name,
                            toolId: block.id,
                            toolInput: block.input,
                            raw: block,
                        };
                        this.emit('event', event);
                    }
                }
                break;
            }
            case 'system': {
                const event = { type: 'system', raw: obj };
                this.emit('event', event);
                break;
            }
            default: {
                // message_start, message_delta, message_stop — generally informational
                // Check for error content in message_delta
                if (type === 'message_delta' && obj.delta?.stop_reason === 'error') {
                    const event = { type: 'error', text: 'Claude stopped with error', raw: obj };
                    this.emit('event', event);
                }
                break;
            }
        }
    }
}
/** Map tool names to human-readable activity labels */
export function toolDisplayName(toolName) {
    const map = {
        'Read': 'Reading files',
        'Write': 'Writing files',
        'Edit': 'Editing files',
        'Bash': 'Running commands',
        'Glob': 'Searching files',
        'Grep': 'Searching codebase',
        'WebFetch': 'Fetching web content',
        'WebSearch': 'Searching the web',
        'Task': 'Running subtask',
        // MCP tools
        'get_issue': 'Reading issue details',
        'list_issues': 'Listing issues',
        'get_project': 'Reading project details',
        'get_comments': 'Reading comments',
        'search_issues': 'Searching issues',
        'update_issue_state': 'Updating issue state',
        'create_issue': 'Creating issue',
        'add_comment': 'Posting comment',
        'update_issue': 'Updating issue',
    };
    return map[toolName] ?? `Using ${toolName}`;
}
