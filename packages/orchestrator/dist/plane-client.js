export class PlaneClient {
    baseUrl;
    apiToken;
    constructor(baseUrl, apiToken) {
        this.baseUrl = baseUrl;
        this.apiToken = apiToken;
    }
    headers() {
        return {
            'Content-Type': 'application/json',
            'X-API-Key': this.apiToken,
        };
    }
    url(path) {
        return `${this.baseUrl}${path}`;
    }
    async getIssue(workspaceSlug, projectId, issueId) {
        const res = await fetch(this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/`), { headers: this.headers() });
        if (!res.ok)
            throw new Error(`Failed to get issue: ${res.status}`);
        return res.json();
    }
    async getComments(workspaceSlug, projectId, issueId) {
        const res = await fetch(this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`), { headers: this.headers() });
        if (!res.ok)
            throw new Error(`Failed to get comments: ${res.status}`);
        const data = await res.json();
        return data.results ?? data;
    }
    async updateIssueState(workspaceSlug, projectId, issueId, stateId) {
        const res = await fetch(this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/`), {
            method: 'PATCH',
            headers: this.headers(),
            body: JSON.stringify({ state: stateId }),
        });
        if (!res.ok)
            throw new Error(`Failed to update issue state: ${res.status}`);
        return res.json();
    }
    async addComment(workspaceSlug, projectId, issueId, comment, opts) {
        const body = { comment_html: `<p>${comment}</p>` };
        if (opts?.external_source)
            body.external_source = opts.external_source;
        if (opts?.external_id)
            body.external_id = opts.external_id;
        const res = await fetch(this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`), {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(body),
        });
        if (!res.ok)
            throw new Error(`Failed to add comment: ${res.status}`);
        return res.json();
    }
    async addCommentHtml(workspaceSlug, projectId, issueId, html, opts) {
        const body = { comment_html: html };
        if (opts?.external_source)
            body.external_source = opts.external_source;
        if (opts?.external_id)
            body.external_id = opts.external_id;
        const res = await fetch(this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`), {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(body),
        });
        if (!res.ok)
            throw new Error(`Failed to add comment: ${res.status}`);
        return res.json();
    }
    async updateComment(workspaceSlug, projectId, issueId, commentId, html) {
        const res = await fetch(this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/${commentId}/`), {
            method: 'PATCH',
            headers: this.headers(),
            body: JSON.stringify({ comment_html: html }),
        });
        if (!res.ok)
            throw new Error(`Failed to update comment: ${res.status}`);
        return res.json();
    }
    async addIssueLink(workspaceSlug, projectId, issueId, url, title) {
        const res = await fetch(this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/links/`), {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ url, title }),
        });
        if (!res.ok)
            throw new Error(`Failed to add link: ${res.status}`);
        return res.json();
    }
    async getProjectStates(workspaceSlug, projectId) {
        const res = await fetch(this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/states/`), { headers: this.headers() });
        if (!res.ok)
            throw new Error(`Failed to get states: ${res.status}`);
        return res.json();
    }
    async getWorkspaceMembers(workspaceSlug) {
        const res = await fetch(this.url(`/api/v1/workspaces/${workspaceSlug}/members/`), { headers: this.headers() });
        if (!res.ok)
            throw new Error(`Failed to get members: ${res.status}`);
        const data = await res.json();
        return data.results ?? data;
    }
    async registerWebhook(workspaceSlug, url, secret) {
        const res = await fetch(this.url(`/api/v1/workspaces/${workspaceSlug}/webhooks/`), {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({
                url,
                is_active: true,
                issue: true,
                comment: true,
                secret,
            }),
        });
        if (!res.ok)
            throw new Error(`Failed to register webhook: ${res.status} ${await res.text()}`);
        return res.json();
    }
    async resolveStateByGroup(workspaceSlug, projectId, group) {
        const states = await this.getProjectStates(workspaceSlug, projectId);
        const list = states.results ?? states;
        const match = list.find((s) => s.group === group);
        return match?.id ?? null;
    }
}
