function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
/** Minimal markdown→HTML: bold, italic, inline code, code blocks, links, line breaks */
function md(text) {
    let html = escapeHtml(text);
    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    // Line breaks (double newline → paragraph, single → <br>)
    html = html
        .split('\n\n')
        .map(block => {
        if (block.startsWith('<pre>'))
            return block;
        return `<p>${block.replace(/\n/g, '<br>')}</p>`;
    })
        .join('');
    return html;
}
function activityIcon(activity) {
    if (activity.completed)
        return '✅';
    return '⏳';
}
export function formatProgressComment(activities, status = 'working') {
    const statusLabel = status === 'complete' ? 'Complete' : status === 'error' ? 'Error' : 'Working...';
    const header = `<p><strong>🤖 Claude — ${statusLabel}</strong></p>`;
    if (activities.length === 0) {
        return `${header}<p>Analyzing the request...</p>`;
    }
    const items = activities.map(a => {
        const icon = activityIcon(a);
        return `<li>${icon} ${escapeHtml(a.label)}</li>`;
    }).join('');
    return `${header}<ul>${items}</ul>`;
}
export function formatFinalResponse(response, actor) {
    const byLine = actor ? ` (requested by ${escapeHtml(actor)})` : '';
    const header = `<p><strong>🤖 Claude — Complete${byLine}</strong></p><hr>`;
    return `${header}${md(response)}`;
}
export function formatErrorComment(error) {
    return `<p><strong>🤖 Claude — Error</strong></p><p>Something went wrong while processing this request:</p><pre><code>${escapeHtml(error.slice(0, 1000))}</code></pre>`;
}
export function formatAwaitingInput(question) {
    return `<p><strong>🤖 Claude — Needs Input</strong></p>${md(question)}<p><em>Reply to this issue to continue the conversation.</em></p>`;
}
export function formatThinkingComment() {
    return `<p><strong>🤖 Claude — Working...</strong></p><p>Analyzing the request...</p>`;
}
