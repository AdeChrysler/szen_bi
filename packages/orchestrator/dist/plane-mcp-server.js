#!/usr/bin/env node
/**
 * Plane MCP Server
 * stdio-based MCP server that wraps the Plane API.
 * Started as a subprocess by Claude CLI via mcp.json config.
 *
 * Tools exposed:
 *   get_issue       — full issue details
 *   list_issues     — list issues in a project with optional filters
 *   get_project     — project metadata (name, states, members)
 *   get_comments    — all comments on an issue
 *   search_issues   — text search across issues in a workspace
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const PLANE_API_URL = process.env.PLANE_API_URL ?? 'http://localhost:8000';
const PLANE_API_TOKEN = process.env.PLANE_API_TOKEN ?? '';
function headers() {
    return {
        'Content-Type': 'application/json',
        'X-API-Key': PLANE_API_TOKEN,
    };
}
async function planeGet(path) {
    const res = await fetch(`${PLANE_API_URL}${path}`, { headers: headers() });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Plane API error ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}
async function planePatch(path, body) {
    const res = await fetch(`${PLANE_API_URL}${path}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Plane API error ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}
async function planePost(path, body) {
    const res = await fetch(`${PLANE_API_URL}${path}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Plane API error ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}
// ─── Server setup ────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'plane-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
// ─── Tool: get_issue ─────────────────────────────────────────────────────────
server.registerTool('get_issue', {
    description: 'Get full details of a Plane issue by ID',
    inputSchema: {
        workspace: z.string().describe('Workspace slug (e.g. "my-org")'),
        project_id: z.string().describe('Project ID (UUID)'),
        issue_id: z.string().describe('Issue ID (UUID)'),
    },
}, async ({ workspace, project_id, issue_id }) => {
    const issue = await planeGet(`/api/v1/workspaces/${workspace}/projects/${project_id}/issues/${issue_id}/`);
    return {
        content: [{ type: 'text', text: JSON.stringify(issue, null, 2) }],
    };
});
// ─── Tool: list_issues ───────────────────────────────────────────────────────
server.registerTool('list_issues', {
    description: 'List issues in a Plane project with optional filters',
    inputSchema: {
        workspace: z.string().describe('Workspace slug'),
        project_id: z.string().describe('Project ID (UUID)'),
        state: z.string().optional().describe('Filter by state group (e.g. "started", "unstarted", "done")'),
        priority: z.string().optional().describe('Filter by priority: urgent, high, medium, low, none'),
        label: z.string().optional().describe('Filter by label name'),
    },
}, async ({ workspace, project_id, state, priority, label }) => {
    const params = new URLSearchParams();
    if (state)
        params.set('state__group', state);
    if (priority)
        params.set('priority', priority);
    if (label)
        params.set('label__name', label);
    const query = params.toString() ? `?${params}` : '';
    const data = await planeGet(`/api/v1/workspaces/${workspace}/projects/${project_id}/issues/${query}`);
    const issues = data.results ?? data;
    const summary = issues.map((i) => ({
        id: i.id,
        name: i.name,
        state: i.state_detail?.name ?? i.state,
        priority: i.priority,
        assignees: i.assignees,
    }));
    return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
    };
});
// ─── Tool: get_project ───────────────────────────────────────────────────────
server.registerTool('get_project', {
    description: 'Get project details including name, states, and members',
    inputSchema: {
        workspace: z.string().describe('Workspace slug'),
        project_id: z.string().describe('Project ID (UUID)'),
    },
}, async ({ workspace, project_id }) => {
    const [project, states, members] = await Promise.all([
        planeGet(`/api/v1/workspaces/${workspace}/projects/${project_id}/`),
        planeGet(`/api/v1/workspaces/${workspace}/projects/${project_id}/states/`),
        planeGet(`/api/v1/workspaces/${workspace}/projects/${project_id}/members/`),
    ]);
    const result = {
        id: project.id,
        name: project.name,
        description: project.description,
        states: (states.results ?? states).map((s) => ({ id: s.id, name: s.name, group: s.group })),
        members: (members.results ?? members).map((m) => ({
            id: m.member ?? m.id,
            display_name: m.member__display_name ?? m.display_name,
            email: m.member__email ?? m.email,
        })),
    };
    return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
});
// ─── Tool: get_comments ──────────────────────────────────────────────────────
server.registerTool('get_comments', {
    description: 'Get all comments on a Plane issue',
    inputSchema: {
        workspace: z.string().describe('Workspace slug'),
        project_id: z.string().describe('Project ID (UUID)'),
        issue_id: z.string().describe('Issue ID (UUID)'),
    },
}, async ({ workspace, project_id, issue_id }) => {
    const data = await planeGet(`/api/v1/workspaces/${workspace}/projects/${project_id}/issues/${issue_id}/comments/`);
    const comments = data.results ?? data;
    const summary = comments.map((c) => ({
        id: c.id,
        author: c.actor_detail?.display_name ?? c.actor,
        text: c.comment_stripped ?? c.comment_html,
        created_at: c.created_at,
    }));
    return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
    };
});
// ─── Tool: search_issues ─────────────────────────────────────────────────────
server.registerTool('search_issues', {
    description: 'Search for issues by keyword across all projects in a workspace',
    inputSchema: {
        workspace: z.string().describe('Workspace slug'),
        query: z.string().describe('Search keywords'),
    },
}, async ({ workspace, query }) => {
    const data = await planeGet(`/api/v1/workspaces/${workspace}/issues/?search=${encodeURIComponent(query)}`);
    const issues = data.results ?? data;
    const summary = issues.map((i) => ({
        id: i.id,
        project: i.project,
        name: i.name,
        state: i.state_detail?.name ?? i.state,
        priority: i.priority,
    }));
    return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
    };
});
// ─── Tool: update_issue_state ────────────────────────────────────────────────
server.registerTool('update_issue_state', {
    description: 'Move a Plane issue to a different state by state name (e.g. "In Progress", "In Review", "Done")',
    inputSchema: {
        workspace: z.string().describe('Workspace slug'),
        project_id: z.string().describe('Project ID (UUID)'),
        issue_id: z.string().describe('Issue ID (UUID)'),
        state_name: z.string().describe('Target state name — case-insensitive exact match'),
    },
}, async ({ workspace, project_id, issue_id, state_name }) => {
    const states = await planeGet(`/api/v1/workspaces/${workspace}/projects/${project_id}/states/`);
    const stateList = states.results ?? states;
    const state = stateList.find((s) => s.name.toLowerCase() === state_name.toLowerCase());
    if (!state) {
        throw new Error(`State "${state_name}" not found. Available: ${stateList.map((s) => s.name).join(', ')}`);
    }
    const result = await planePatch(`/api/v1/workspaces/${workspace}/projects/${project_id}/issues/${issue_id}/`, { state: state.id });
    return {
        content: [{ type: 'text', text: JSON.stringify({ updated: true, state: result.state }) }],
    };
});
// ─── Tool: create_issue ──────────────────────────────────────────────────────
server.registerTool('create_issue', {
    description: 'Create a new issue or subtask in a Plane project',
    inputSchema: {
        workspace: z.string().describe('Workspace slug'),
        project_id: z.string().describe('Project ID (UUID)'),
        title: z.string().describe('Issue title'),
        description: z.string().optional().describe('Issue description (plain text)'),
        priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
        parent_id: z.string().optional().describe('Parent issue ID to create as a subtask'),
    },
}, async ({ workspace, project_id, title, description, priority, parent_id }) => {
    const body = { name: title };
    if (description)
        body.description_html = `<p>${description}</p>`;
    if (priority)
        body.priority = priority;
    if (parent_id)
        body.parent = parent_id;
    const result = await planePost(`/api/v1/workspaces/${workspace}/projects/${project_id}/issues/`, body);
    return {
        content: [{ type: 'text', text: JSON.stringify({ id: result.id, name: result.name }) }],
    };
});
// ─── Tool: add_comment ───────────────────────────────────────────────────────
server.registerTool('add_comment', {
    description: 'Post a comment on a Plane issue. Use this to report progress mid-task.',
    inputSchema: {
        workspace: z.string().describe('Workspace slug'),
        project_id: z.string().describe('Project ID (UUID)'),
        issue_id: z.string().describe('Issue ID (UUID)'),
        text: z.string().describe('Comment text (plain text)'),
    },
}, async ({ workspace, project_id, issue_id, text }) => {
    await planePost(`/api/v1/workspaces/${workspace}/projects/${project_id}/issues/${issue_id}/comments/`, { comment_html: `<p>${text}</p>` });
    return {
        content: [{ type: 'text', text: 'Comment posted.' }],
    };
});
// ─── Tool: update_issue ──────────────────────────────────────────────────────
server.registerTool('update_issue', {
    description: 'Update issue fields: title, description, or priority',
    inputSchema: {
        workspace: z.string().describe('Workspace slug'),
        project_id: z.string().describe('Project ID (UUID)'),
        issue_id: z.string().describe('Issue ID (UUID)'),
        title: z.string().optional().describe('New title'),
        description: z.string().optional().describe('New description (plain text)'),
        priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
    },
}, async ({ workspace, project_id, issue_id, title, description, priority }) => {
    const body = {};
    if (title)
        body.name = title;
    if (description)
        body.description_html = `<p>${description}</p>`;
    if (priority)
        body.priority = priority;
    if (Object.keys(body).length === 0) {
        throw new Error('update_issue: at least one of title, description, or priority must be provided');
    }
    await planePatch(`/api/v1/workspaces/${workspace}/projects/${project_id}/issues/${issue_id}/`, body);
    return {
        content: [{ type: 'text', text: JSON.stringify({ updated: true }) }],
    };
});
// ─── Start server ────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
