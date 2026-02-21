export declare class PlaneClient {
    private baseUrl;
    private apiToken;
    constructor(baseUrl: string, apiToken: string);
    private headers;
    private url;
    getIssue(workspaceSlug: string, projectId: string, issueId: string): Promise<any>;
    getComments(workspaceSlug: string, projectId: string, issueId: string): Promise<Array<{
        id: string;
        comment_stripped: string;
        comment_html: string;
        actor_detail?: {
            id: string;
            display_name: string;
        };
        created_at: string;
    }>>;
    updateIssueState(workspaceSlug: string, projectId: string, issueId: string, stateId: string): Promise<any>;
    addComment(workspaceSlug: string, projectId: string, issueId: string, comment: string, opts?: {
        external_source?: string;
        external_id?: string;
    }): Promise<any>;
    addCommentHtml(workspaceSlug: string, projectId: string, issueId: string, html: string, opts?: {
        external_source?: string;
        external_id?: string;
    }): Promise<any>;
    updateComment(workspaceSlug: string, projectId: string, issueId: string, commentId: string, html: string): Promise<any>;
    addIssueLink(workspaceSlug: string, projectId: string, issueId: string, url: string, title: string): Promise<any>;
    getProjectStates(workspaceSlug: string, projectId: string): Promise<any>;
    getWorkspaceMembers(workspaceSlug: string): Promise<Array<{
        id: string;
        member__email: string;
        member__display_name: string;
    }>>;
    registerWebhook(workspaceSlug: string, url: string, secret: string): Promise<{
        id: string;
        url: string;
    }>;
    resolveStateByGroup(workspaceSlug: string, projectId: string, group: string): Promise<string | null>;
}
