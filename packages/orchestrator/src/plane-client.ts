export class PlaneClient {
  private botApiToken?: string

  constructor(
    private baseUrl: string,
    private apiToken: string,
    opts?: { botApiToken?: string }
  ) {
    if (opts?.botApiToken) {
      this.botApiToken = opts.botApiToken
    }
  }

  /**
   * Set the bot user API token used for comment operations.
   * When set, addComment / addCommentHtml / updateComment will
   * authenticate as the bot user so comments appear under its name
   * (e.g. "ZenithSpace Agent") instead of the workspace admin.
   */
  setBotToken(token: string) {
    this.botApiToken = token
  }

  private headers() {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiToken,
    }
  }

  /**
   * Headers used for comment operations. Uses the bot API token when
   * available so that comments are attributed to the bot user; falls
   * back to the main workspace API token for backwards compatibility.
   */
  private commentHeaders() {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.botApiToken ?? this.apiToken,
    }
  }

  private url(path: string) {
    return `${this.baseUrl}${path}`
  }

  async getIssue(workspaceSlug: string, projectId: string, issueId: string) {
    const res = await fetch(
      this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/`),
      { headers: this.headers() }
    )
    if (!res.ok) throw new Error(`Failed to get issue: ${res.status}`)
    return res.json()
  }

  async getComments(workspaceSlug: string, projectId: string, issueId: string): Promise<Array<{
    id: string
    comment_stripped: string
    comment_html: string
    actor_detail?: { id: string; display_name: string }
    created_at: string
  }>> {
    const res = await fetch(
      this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`),
      { headers: this.headers() }
    )
    if (!res.ok) throw new Error(`Failed to get comments: ${res.status}`)
    const data = await res.json()
    return data.results ?? data
  }

  async updateIssueState(workspaceSlug: string, projectId: string, issueId: string, stateId: string) {
    const res = await fetch(
      this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/`),
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ state: stateId }),
      }
    )
    if (!res.ok) throw new Error(`Failed to update issue state: ${res.status}`)
    return res.json()
  }

  async addComment(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    comment: string,
    opts?: { external_source?: string; external_id?: string }
  ) {
    const body: Record<string, string> = { comment_html: `<p>${comment}</p>` }
    if (opts?.external_source) body.external_source = opts.external_source
    if (opts?.external_id) body.external_id = opts.external_id
    const res = await fetch(
      this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`),
      {
        method: 'POST',
        headers: this.commentHeaders(),
        body: JSON.stringify(body),
      }
    )
    if (!res.ok) throw new Error(`Failed to add comment: ${res.status}`)
    return res.json()
  }

  async addCommentHtml(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    html: string,
    opts?: { external_source?: string; external_id?: string }
  ) {
    const body: Record<string, string> = { comment_html: html }
    if (opts?.external_source) body.external_source = opts.external_source
    if (opts?.external_id) body.external_id = opts.external_id
    const res = await fetch(
      this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`),
      {
        method: 'POST',
        headers: this.commentHeaders(),
        body: JSON.stringify(body),
      }
    )
    if (!res.ok) throw new Error(`Failed to add comment: ${res.status}`)
    return res.json()
  }

  async updateComment(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    commentId: string,
    html: string
  ) {
    const res = await fetch(
      this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/${commentId}/`),
      {
        method: 'PATCH',
        headers: this.commentHeaders(),
        body: JSON.stringify({ comment_html: html }),
      }
    )
    if (!res.ok) throw new Error(`Failed to update comment: ${res.status}`)
    return res.json()
  }

  async addIssueLink(workspaceSlug: string, projectId: string, issueId: string, url: string, title: string) {
    const res = await fetch(
      this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/links/`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ url, title }),
      }
    )
    if (!res.ok) throw new Error(`Failed to add link: ${res.status}`)
    return res.json()
  }

  async getProjectStates(workspaceSlug: string, projectId: string) {
    const res = await fetch(
      this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/states/`),
      { headers: this.headers() }
    )
    if (!res.ok) throw new Error(`Failed to get states: ${res.status}`)
    return res.json()
  }

  async getWorkspaceMembers(workspaceSlug: string): Promise<Array<{ id: string; member__email: string; member__display_name: string }>> {
    const res = await fetch(
      this.url(`/api/v1/workspaces/${workspaceSlug}/members/`),
      { headers: this.headers() }
    )
    if (!res.ok) throw new Error(`Failed to get members: ${res.status}`)
    const data = await res.json()
    return data.results ?? data
  }

  async registerWebhook(workspaceSlug: string, url: string, secret: string): Promise<{ id: string; url: string }> {
    const res = await fetch(
      this.url(`/api/v1/workspaces/${workspaceSlug}/webhooks/`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          url,
          is_active: true,
          issue: true,
          comment: true,
          secret,
        }),
      }
    )
    if (!res.ok) throw new Error(`Failed to register webhook: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async resolveStateByGroup(workspaceSlug: string, projectId: string, group: string): Promise<string | null> {
    const states = await this.getProjectStates(workspaceSlug, projectId)
    const list: Array<{ id: string; group: string }> = states.results ?? states
    const match = list.find((s) => s.group === group)
    return match?.id ?? null
  }
}
