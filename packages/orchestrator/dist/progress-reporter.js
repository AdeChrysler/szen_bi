import { toolDisplayName } from './stream-parser.js';
import { formatProgressComment, formatThinkingComment, formatFinalResponse, formatErrorComment } from './comment-format.js';
const THROTTLE_MS = 7_000; // Max 1 Plane API call per 7 seconds
export class ProgressReporter {
    plane;
    sessionManager;
    sessionId;
    workspace;
    projectId;
    issueId;
    progressCommentId = null;
    activities = [];
    lastUpdateTime = 0;
    pendingUpdate = false;
    throttleTimer = null;
    currentToolLabel = null;
    constructor(plane, sessionManager, sessionId, workspace, projectId, issueId) {
        this.plane = plane;
        this.sessionManager = sessionManager;
        this.sessionId = sessionId;
        this.workspace = workspace;
        this.projectId = projectId;
        this.issueId = issueId;
    }
    /** Post the initial "thinking" comment. Call this immediately on trigger. */
    async postThinkingComment() {
        try {
            const html = formatThinkingComment();
            const result = await this.plane.addCommentHtml(this.workspace, this.projectId, this.issueId, html, { external_source: 'zenova-agent', external_id: `progress-${this.sessionId}` });
            this.progressCommentId = result.id;
            await this.sessionManager.setProgressCommentId(this.sessionId, result.id);
            console.log(`[progress] Posted thinking comment ${result.id} for session ${this.sessionId}`);
            return result.id;
        }
        catch (err) {
            console.error(`[progress] Failed to post thinking comment:`, err);
            return null;
        }
    }
    /** Handle a parsed stream event from the Claude CLI */
    async handleEvent(event) {
        switch (event.type) {
            case 'tool_start': {
                const label = toolDisplayName(event.toolName ?? 'unknown');
                // Avoid duplicate consecutive labels
                if (this.currentToolLabel && this.currentToolLabel !== label) {
                    this.markCurrentComplete();
                }
                // Check if this label already exists as non-completed
                const existing = this.activities.find(a => a.label === label && !a.completed);
                if (!existing) {
                    const activity = {
                        type: 'tool_start',
                        label,
                        timestamp: Date.now(),
                        detail: event.toolName,
                    };
                    this.activities.push(activity);
                    await this.sessionManager.addActivity(this.sessionId, activity);
                }
                this.currentToolLabel = label;
                this.scheduleUpdate();
                break;
            }
            case 'tool_result': {
                this.markCurrentComplete();
                this.scheduleUpdate();
                break;
            }
            case 'text': {
                // Text deltas don't need activity tracking, but update session state
                if (this.activities.length === 0) {
                    const activity = {
                        type: 'text',
                        label: 'Analyzing the request',
                        timestamp: Date.now(),
                        completed: true,
                    };
                    this.activities.push(activity);
                    await this.sessionManager.addActivity(this.sessionId, activity);
                    this.scheduleUpdate();
                }
                break;
            }
            case 'error': {
                const activity = {
                    type: 'error',
                    label: 'Error encountered',
                    timestamp: Date.now(),
                    detail: event.text,
                };
                this.activities.push(activity);
                await this.sessionManager.addActivity(this.sessionId, activity);
                this.scheduleUpdate();
                break;
            }
        }
    }
    /** Mark all in-progress activities as complete and update the progress comment to "Complete" */
    async finalize(finalResponse, actor) {
        this.clearThrottle();
        // Mark remaining activities as complete
        for (const a of this.activities) {
            if (!a.completed)
                a.completed = true;
        }
        // Update progress comment to show "Complete"
        if (this.progressCommentId) {
            try {
                const html = formatProgressComment(this.activities, 'complete');
                await this.plane.updateComment(this.workspace, this.projectId, this.issueId, this.progressCommentId, html);
            }
            catch (err) {
                console.error(`[progress] Failed to update progress comment:`, err);
            }
        }
        // Post separate final response comment
        try {
            const html = formatFinalResponse(finalResponse, actor);
            await this.plane.addCommentHtml(this.workspace, this.projectId, this.issueId, html, { external_source: 'zenova-agent', external_id: `response-${this.sessionId}` });
        }
        catch (err) {
            console.error(`[progress] Failed to post final response:`, err);
        }
        await this.sessionManager.setFinalResponse(this.sessionId, finalResponse);
        await this.sessionManager.updateState(this.sessionId, 'complete');
    }
    /** Post error and clean up */
    async finalizeError(error) {
        this.clearThrottle();
        // Update progress comment to show error
        if (this.progressCommentId) {
            try {
                const html = formatProgressComment(this.activities, 'error');
                await this.plane.updateComment(this.workspace, this.projectId, this.issueId, this.progressCommentId, html);
            }
            catch (err) {
                console.error(`[progress] Failed to update progress comment on error:`, err);
            }
        }
        // Post error comment
        try {
            const html = formatErrorComment(error);
            await this.plane.addCommentHtml(this.workspace, this.projectId, this.issueId, html, { external_source: 'zenova-agent', external_id: `error-${this.sessionId}` });
        }
        catch (err) {
            console.error(`[progress] Failed to post error comment:`, err);
        }
        await this.sessionManager.setError(this.sessionId, error);
    }
    markCurrentComplete() {
        if (this.currentToolLabel) {
            const activity = this.activities.find(a => a.label === this.currentToolLabel && !a.completed);
            if (activity) {
                activity.completed = true;
                this.sessionManager.markActivityComplete(this.sessionId, this.currentToolLabel).catch(() => { });
            }
            this.currentToolLabel = null;
        }
    }
    scheduleUpdate() {
        const now = Date.now();
        const elapsed = now - this.lastUpdateTime;
        if (elapsed >= THROTTLE_MS) {
            this.flushUpdate();
        }
        else if (!this.pendingUpdate) {
            this.pendingUpdate = true;
            this.throttleTimer = setTimeout(() => {
                this.pendingUpdate = false;
                this.flushUpdate();
            }, THROTTLE_MS - elapsed);
        }
    }
    flushUpdate() {
        this.lastUpdateTime = Date.now();
        if (!this.progressCommentId)
            return;
        const html = formatProgressComment(this.activities, 'working');
        this.plane.updateComment(this.workspace, this.projectId, this.issueId, this.progressCommentId, html)
            .catch(err => console.error(`[progress] Failed to update progress:`, err));
    }
    clearThrottle() {
        if (this.throttleTimer) {
            clearTimeout(this.throttleTimer);
            this.throttleTimer = null;
        }
        this.pendingUpdate = false;
    }
}
