# Connecting Zenova Agents to Your Plane Workspace

## Quick Setup (< 5 minutes)

1. Deploy Zenova Agents (see `deploy/README.md`)
2. Open `https://your-orchestrator-url/connect` in your browser
3. Enter your Plane URL, workspace slug, and API token
4. Choose which agents to enable
5. Add your GitHub + Claude tokens
6. Click "Run Setup" — agents are registered automatically

## What Gets Created

- Webhook subscription in your Plane workspace (auto-configured)
- Workspace-scoped API key storage in Redis (namespaced by workspace slug)

## Using Agents

Assign any Plane issue to an agent user (e.g. `@dev-agent`).
The agent will:
1. Post a comment: "🤖 Dev agent picked up this issue..."
2. Transition issue to "In Progress"
3. Clone your repo, create a branch, run Claude Code
4. Create a PR and post the link to the issue
5. Transition issue to "In Review"

## Agent Types

| Agent | Triggered by | Output |
|-------|-------------|--------|
| `@dev-agent` | Assignment or `dev` label | GitHub PR with code changes |
| `@landing-agent` | Assignment or `landing` label | GitHub PR with landing page |
| `@strategy-agent` | Assignment or `strategy` label | Strategy doc posted as comment |
| `@creative-agent` | Assignment or `creative` label | Generated assets |

## Multiple Workspaces

One Zenova Agents instance can serve multiple Plane workspaces. Each workspace gets its own namespaced config in Redis. Run the `/connect` wizard once per workspace.

## Troubleshooting

- **Agent not picking up issues**: Check webhook is active in Plane → Settings → Webhooks
- **Auth errors**: Re-run the setup wizard and re-enter API tokens
- **Container fails**: Check `GET /status` for running agents and queue depth
- **Wrong repo**: Use `/admin` to set per-project repo mappings under your workspace

## Manual Webhook Setup (fallback)

If the wizard fails, manually configure in Plane → Settings → Webhooks:
- URL: `https://your-orchestrator-url/webhooks/plane`
- Events: Issue (created, updated)
- Then set your API keys via `/admin`
