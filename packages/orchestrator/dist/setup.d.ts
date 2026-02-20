export interface BootstrapOptions {
    planeUrl: string;
    apiToken: string;
    workspaceSlug: string;
    webhookUrl: string;
    redis: any;
}
export interface BootstrapResult {
    webhookId: string;
    webhookSecret: string;
    memberCount: number;
}
export declare function bootstrapWorkspace(opts: BootstrapOptions): Promise<BootstrapResult>;
