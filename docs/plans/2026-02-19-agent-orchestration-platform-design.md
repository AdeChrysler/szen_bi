# Zenova Agent Orchestration Platform - Design Document

**Date**: 2026-02-19
**Status**: Approved
**Author**: Six Zenith Digital / Claude Code

---

## Overview

Build a Linear-style AI agent delegation system on top of self-hosted Plane.so. Engineers create issues in Plane, assign them to AI agent users, and agents autonomously pick up work, execute it in isolated Docker containers, and submit PRs for human review. Agents run 24/7 to maximize organizational throughput.

This goes beyond code — agents handle landing pages, social media strategy, image/video generation, and any task that can be described in a Plane issue.

## Goals

- **Autonomous execution**: Agents work without constant human babysitting
- **24/7 operation**: Maximize AI quota usage across the organization
- **Human review**: All output goes through PR-based review before going live
- **Flexible agent types**: Easy to add new specialized agents (dev, creative, strategy, etc.)
- **Status visibility**: Real-time progress updates in Plane issues

## Non-Goals (for now)

- Agent-to-agent delegation (agents spawning sub-agents)
- Auto-merging PRs without human review
- Multi-repo orchestration in a single task
- Billing/cost tracking per task

---

## Architecture

```
+-----------------------------------------------------------+
|                     PLANE.SO (Hub)                         |
|  Issues -> Assign to @dev-agent / @creative-agent / etc.  |
|  Status updates <- Agent reports progress                 |
|  PR links <- Agent attaches GitHub PR URLs                |
+---------------+-------------------------------^-----------+
                | Webhook                       | API
                v                               |
+-----------------------------------------------------------+
|               ORCHESTRATOR SERVICE                        |
|  - Receives Plane webhooks                                |
|  - Routes to correct agent pool by label/assignee         |
|  - Manages Docker containers (start/stop/monitor)         |
|  - Priority queue (Redis-backed)                          |
|  - OAuth token management for AI providers                |
|  - Concurrency limits per agent type                      |
+---------+---------+---------+---------+-------------------+
          |         |         |         |
          v         v         v         v
     +--------+ +--------+ +--------+ +--------+
     |Dev     | |Creative| |Strategy| |Landing |
     |Agent   | |Agent   | |Agent   | |Agent   |
     |        | |        | |        | |        |
     |Claude  | |OpenAI  | |Claude  | |Claude  |
     |Code,   | |DALL-E, | |API,    | |Code,   |
     |Codex,  | |Runway, | |Search, | |Next.js,|
     |Git     | |Canvas  | |Docs    | |Git     |
     +--------+ +--------+ +--------+ +--------+
          |         |         |         |
          v         v         v         v
+-----------------------------------------------------------+
|                      GITHUB                               |
|  PRs, branches, artifacts, assets                         |
+-----------------------------------------------------------+
```

### Components

1. **Plane.so** (self-hosted via Coolify @ zenova.id)
   - Central hub for all task management
   - Agent users created as workspace members (e.g., @dev-agent)
   - Webhooks configured to fire on issue assignment changes
   - Labels used for routing: `dev`, `creative`, `strategy`, `landing`

2. **Orchestrator Service** (Node.js + TypeScript + Hono)
   - Lightweight HTTP server (~800 lines)
   - Receives Plane webhooks
   - Routes issues to correct agent type based on assignee + labels
   - Manages Docker container lifecycle via Docker API
   - Redis-backed priority queue
   - Posts status updates back to Plane via API
   - Manages OAuth tokens for AI providers

3. **Agent Containers** (Docker)
   - One Docker image per agent type
   - Each has its own toolset and system prompt
   - Receives issue context (title, description, acceptance criteria) as env vars
   - Clones target repo, does work, creates PR
   - Posts progress comments to Plane issue
   - Self-terminates when done (with timeout safety net)

4. **Redis** - Priority queue, running agent state, rate limiting

5. **GitHub** - Where all agent output lands as PRs

---

## Agent Types

| Agent | Assignee | Docker Image | Tools | Output |
|-------|----------|-------------|-------|--------|
| Dev Agent | @dev-agent | zenova/agent-dev | Claude Code CLI, Codex, Git, GH CLI | PRs with code |
| Creative Agent | @creative-agent | zenova/agent-creative | OpenAI DALL-E/GPT, image tools | Assets in PR |
| Strategy Agent | @strategy-agent | zenova/agent-strategy | Claude API, web search | Markdown docs in PR |
| Landing Page Agent | @landing-agent | zenova/agent-landing | Claude Code CLI, frontend frameworks | Full page code PR |

Adding a new agent type requires:
1. New Docker image with tools installed
2. System prompt (prompt.md) defining agent behavior
3. Entry in `config/agents.yaml`
4. No orchestrator code changes needed

---

## Issue Lifecycle

1. **Created**: Human creates issue in Plane with labels + assigns to agent user
2. **Queued**: Orchestrator receives webhook, validates, adds to priority queue
3. **Dispatched**: Container spins up with issue context
4. **In Progress**: Agent updates Plane status, posts progress comments
5. **PR Created**: Agent pushes branch, creates PR, links to Plane issue
6. **In Review**: Agent marks issue as review-ready, container exits
7. **Changes Requested**: If human comments, orchestrator can re-spin agent
8. **Done**: Human merges PR, closes issue in Plane

---

## Priority System

- **Urgent**: Processed immediately, can preempt lower priority if at concurrency limit
- **High**: Next in queue after urgent
- **Medium**: Standard processing order
- **Low**: Background tasks, processed when capacity available

Priority is set via Plane issue priority field (native feature).

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Hub | Plane.so (Docker, self-hosted) |
| Orchestrator | Node.js + TypeScript + Hono |
| Queue/State | Redis |
| Agent Runtime | Docker containers |
| Container Mgmt | Docker API (dockerode) |
| AI Auth | OAuth (where supported), encrypted keys fallback |
| Version Control | GitHub + gh CLI |
| Deployment | Coolify @ zenova.id |

---

## Project Structure

```
zenova-agents/
├── docker-compose.yml
├── packages/
│   ├── orchestrator/
│   │   ├── src/
│   │   │   ├── index.ts           # Hono server + webhook endpoints
│   │   │   ├── router.ts          # Issue -> agent type routing
│   │   │   ├── queue.ts           # Redis-backed priority queue
│   │   │   ├── docker.ts          # Container lifecycle (dockerode)
│   │   │   ├── plane-client.ts    # Plane API client
│   │   │   ├── github.ts          # PR creation + linking
│   │   │   └── config.ts          # Agent type definitions
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── agents/
│       ├── dev/
│       │   ├── Dockerfile
│       │   ├── entrypoint.sh
│       │   └── prompt.md
│       ├── creative/
│       │   ├── Dockerfile
│       │   ├── entrypoint.sh
│       │   └── prompt.md
│       ├── strategy/
│       │   ├── Dockerfile
│       │   ├── entrypoint.sh
│       │   └── prompt.md
│       └── landing/
│           ├── Dockerfile
│           ├── entrypoint.sh
│           └── prompt.md
├── config/
│   ├── agents.yaml
│   └── plane.yaml
└── docs/
    └── plans/
```

---

## Security Considerations

- OAuth tokens stored encrypted, never in container env vars directly (use Docker secrets or mounted files)
- Each agent container runs with minimal privileges (no Docker socket access)
- Containers have resource limits (CPU, memory, timeout)
- Agent GitHub tokens scoped to specific repos only
- Plane API tokens scoped to minimum required permissions

---

## Deployment (Coolify @ zenova.id)

All services deployed as Docker Compose stack on Coolify:
- Plane.so (with PostgreSQL, Redis, MinIO)
- Orchestrator service
- Shared Redis (or reuse Plane's Redis)
- Agent images built and pushed to container registry

---

## Future Considerations (not in scope now)

- Agent-to-agent delegation (parent tasks spawning child tasks)
- Cost tracking per task/agent
- Auto-scaling agent containers based on queue depth
- Slack/Discord notifications for agent activity
- Dashboard for agent performance metrics
- n8n integration for complex multi-step workflows
