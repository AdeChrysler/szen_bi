# Zenova Platform — Native Agent Integration Design

**Date**: 2026-02-19
**Status**: Approved
**Author**: Six Zenith Digital / Claude Code

---

## Vision

Transform the existing `zenova-agents` orchestrator + Plane.so deployment into a vertically integrated AI agent factory: a white-labeled project management platform with agents as a first-class primitive. The platform (Zenova) is the engine that manufactures new SaaS products by driving AI agents through issues.

> **Engine builds engine**: Create a project in Zenova → assign issues to AI agents → agents autonomously ship code, landing pages, copy, and assets → new SaaS products emerge.

---

## Current State

- `zenova-agents` orchestrator: working Node.js/TypeScript/Hono service
- 4 agent types: `dev`, `creative`, `strategy`, `landing` — Docker containers
- Integration model: manual webhook URL in Plane.so admin settings
- `/admin` UI: settings page for API keys, repo mappings, agent status
- Pain point: setup is manual and not native to Plane UI

## What We're Copying from Cyrus/Linear

Cyrus (github.com/ceedaragents/cyrus) proves the right UX:
- Agent registers as an **OAuth app**
- User clicks "Connect" on an integrations page
- OAuth consent flow → agent appears as workspace member
- Issues assigned to that member → agent activates automatically
- Agent streams activity back to the issue in real time

We replicate this pattern in two phases.

---

## Phase 1 — Standalone Connect App (Ship First)

### Goal
Give any self-hosted Plane workspace a one-click agent setup experience **without forking Plane**. Ships fast, proves the UX.

### Architecture

```
User → connect.zenova.id/setup
            ↓
     [3-step wizard]
     Step 1: Enter Plane URL + API token → validate live
     Step 2: Select projects, map to GitHub repos, choose agents
     Step 3: Auto-setup runs → redirects back to Plane
            ↓
     Behind the scenes:
     - Creates agent bot users in workspace via Plane API
     - Registers webhook subscription via Plane API
     - Stores workspace config in orchestrator (Redis)
     - Returns deep-link to Plane workspace
```

### New Components

**`packages/connect` — Setup wizard web app**
- React + Vite (or Next.js), served by orchestrator at `/connect/*`
- Step 1: Plane URL + API token (live validation against Plane API)
- Step 2: Project selector (fetched from Plane), GitHub repo mapping, agent toggles
- Step 3: Progress screen showing: user creation, webhook registration, health check
- Success: "Your agents are ready" + deep-link button back to Plane

**Orchestrator additions (`packages/orchestrator`)**

New endpoints:
- `POST /setup` — receives Plane URL + token, runs full workspace bootstrap
- `GET /connect/status/:workspaceSlug` — returns live agent health for dashboard
- `GET /connect` — serves the wizard SPA

New setup logic:
- `PlaneClient.createBotUser(name, email)` — creates agent as workspace member
- `PlaneClient.registerWebhook(url, secret)` — auto-registers webhook
- Multi-workspace support: Redis keys namespaced by `workspaceSlug`

### Agent Enhancements for Cyrus Parity

All existing agents gain:

1. **Streaming activity comments** — agent posts incremental status to Plane issue:
   ```
   🔍 Analyzing issue context...
   📦 Creating branch: feat/issue-123-add-auth
   🧠 Running Claude Code...
   ✅ PR ready: https://github.com/org/repo/pull/456
   ```

2. **Automatic issue transitions** — agent moves issue through states:
   - On pickup: `Todo` → `In Progress`
   - On PR creation: `In Progress` → `In Review`
   - On failure: adds `⚠️ Agent failed` comment, stays in `In Progress`

3. **PR linking** — agent posts PR URL as an issue link in Plane (uses existing `addIssueLink`)

4. **Sub-task creation** — for complex issues, agent creates child issues in Plane for each work chunk

---

## Phase 2 — Fork Plane.so → Zenova Platform

### Goal
Absorb Phase 1 natively. Fork Plane.so, white-label as Zenova, add agents as a first-class platform feature. Removes dependency on vanilla Plane.

### What Gets Forked

**Repository**: Fork `makeplane/plane` → `sixzenith/zenova`

**Django API changes (`apiserver/`)**

New `agents` app:
```
apiserver/agents/
  models.py       — AgentApp, AgentInstallation, AgentSession
  views.py        — register, list, oauth consent, token exchange
  serializers.py
  urls.py
```

Key models:
- `AgentApp` — registered OAuth app (name, client_id, client_secret, webhook_url, capabilities)
- `AgentInstallation` — workspace × agent app (access_token, active_projects, config)
- `AgentSession` — per-issue agent run (status, log, pr_url, started_at, completed_at)

New API endpoints:
- `POST /api/v1/integrations/agents/register` — OAuth app registration
- `GET /api/v1/integrations/agents/` — list installed agents for workspace
- `GET /oauth/authorize` — OAuth2 PKCE consent screen
- `POST /oauth/token` — token exchange
- Issue model gains: `agent_session_id`, `agent_status` fields
- Webhook enhancement: fire `agent.assigned` event with richer payload

**Next.js web app changes (`web/`)**

New pages:
- `pages/[workspaceSlug]/settings/integrations/agents/` — Agents integrations page
  - Grid of available agents (like Linear's integrations marketplace)
  - Per-agent: description, capabilities, "Connect" button → OAuth flow
  - Installed agents: status, active projects, "Configure" / "Disconnect"
- Issue detail enhancements:
  - **Agent Activity sidebar tab** — live log stream from agent session
  - **Agent status badge** on issue card (idle / running / review / failed)
  - **PR link chip** on issue when agent creates a PR
  - **Re-run agent button** for failed/stuck issues

**Rebranding**
- Replace all `plane` / `Plane` references with `zenova` / `Zenova`
- New color scheme (dark, professional)
- New logo/favicon
- Remove Plane.so telemetry/analytics

### Phase 2 Migration

When Phase 2 ships:
- Phase 1 connect wizard becomes a redirect: "If you self-host vanilla Plane, use this wizard. If you use Zenova, just go to Settings > Integrations > Agents."
- Orchestrator becomes the reference OAuth app implementation

---

## The Engine Loop

```
New product idea
      ↓
Create project in Zenova
      ↓
Write high-level issues ("Build auth system", "Create landing page")
      ↓
Assign to @dev-agent, @landing-agent, @creative-agent
      ↓
Agents spin up Docker containers, run Claude Code
      ↓
Streaming status updates in issue comments
      ↓
PRs created → appear as issue links
      ↓
Human reviews + merges PR
      ↓
Issue auto-closes → marked Done
      ↓
New SaaS product ships
      ↓
(Repeat for every feature, bug, marketing asset)
```

This is the core thesis: **Zenova replaces a human engineering team for the mechanical parts of building software**, while humans focus on product direction and quality review.

---

## Linear Features We Must Replicate

Based on Linear's agent integration and Cyrus capabilities:

| Feature | Current | Phase 1 | Phase 2 |
|---------|---------|---------|---------|
| One-click agent setup | ❌ manual webhook | ✅ wizard | ✅ native OAuth |
| Agent appears as workspace member | ❌ | ✅ | ✅ |
| Streaming activity in issue | ❌ | ✅ comments | ✅ native feed |
| Issue auto-transitions | ❌ | ✅ | ✅ |
| PR linking | partial | ✅ | ✅ |
| Sub-task creation | ❌ | ✅ | ✅ |
| Multi-agent per issue | ❌ | ❌ | ✅ |
| Agent marketplace | ❌ | ❌ | ✅ |
| Native OAuth flow | ❌ | ✅ wizard | ✅ OAuth2 PKCE |
| Agent session replay | ❌ | ❌ | ✅ |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Platform fork | Python/Django (API), Next.js (web) |
| Orchestrator | Node.js, TypeScript, Hono |
| Connect wizard | React, Vite, Tailwind |
| Agents | Docker containers, Claude Code, GitHub CLI |
| Queue | Redis |
| Storage | PostgreSQL (via Plane fork) |
| Hosting | Coolify (self-hosted) |

---

## Success Criteria

**Phase 1 done when:**
- New Plane workspace can be set up with agents in < 5 minutes using the wizard
- Zero manual webhook configuration required
- Agent posts status comments to every assigned issue
- Issues auto-transition through states

**Phase 2 done when:**
- Zenova ships as a white-labeled product distinct from Plane.so
- Agents page is accessible under Settings > Integrations
- Connecting an agent requires only clicking "Connect" + OAuth consent
- At least one new SaaS product has been fully built using Zenova as the factory
