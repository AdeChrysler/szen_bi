export class PlaneClient {
  constructor(
    private baseUrl: string,
    private apiToken: string
  ) {}

  private headers() {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiToken,
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

  async addComment(workspaceSlug: string, projectId: string, issueId: string, comment: string) {
    const res = await fetch(
      this.url(`/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ comment_html: `<p>${comment}</p>` }),
      }
    )
    if (!res.ok) throw new Error(`Failed to add comment: ${res.status}`)
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
}
