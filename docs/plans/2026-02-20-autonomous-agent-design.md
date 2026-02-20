# Autonomous Claude Agent in Plane

**Date:** 2026-02-20
**Status:** Approved — implementing

## Problem

Developers switch contexts constantly: open terminal → find task in Plane → read all comments → clone repo → work → push → go back to Plane → update issue. Every task requires multiple manual handoffs.

## Solution

`@claude <action> <task>` in any Plane comment triggers Claude to work on the issue end-to-end: reads full context, clones repo, implements, pushes, updates Plane — without the developer leaving Plane.

## Trigger Routing

| Mention | Mode | Example |
|---|---|---|
| Q&A verbs | Answer only | `@claude explain what this does` |
| Action verbs | Autonomous agent | `@claude implement the login endpoint` |

**Action verbs:** implement, fix, build, create, write, work, refactor, add, update, test, review, investigate, debug
**Q&A verbs:** everything else (explain, what, how, why, list, describe, summarize)

## Autonomous Mode Flow

1. Post acknowledgment comment immediately
2. Fetch full context: issue + all comments + linked issues + project states
3. Clone repo from project→repo mapping (Redis)
4. Write `~/.claude/mcp.json` with Plane MCP server (read + write tools)
5. Run `claude --print --dangerously-skip-permissions` in cloned repo dir
   - Claude uses Bash, Read, Write, Edit, Grep, Glob (built-in)
   - Claude uses Plane MCP tools to post progress and update issue
6. On completion: push branch, post summary + branch/PR link, move issue to "In Review"

## New Plane MCP Write Tools

- `update_issue_state(workspace, project_id, issue_id, state_name)` — resolves state by name
- `create_issue(workspace, project_id, title, description, priority?)` — create subtasks
- `add_comment(workspace, project_id, issue_id, text)` — post progress mid-task
- `update_issue(workspace, project_id, issue_id, fields)` — change priority/assignee/title

## Capabilities Unlocked

**Code work:**
- Fix bugs, implement features, refactor code, write tests
- Push to branch `claude/issue-<id>`, post PR link

**Project management:**
- Break epics into subtasks (create_issue)
- Move issues through states (update_issue_state)
- Update priority, assignee (update_issue)

**Research:**
- Investigate failures (reads code + runs tests via Bash)
- Cross-reference related issues via MCP tools

## Files Changed

| File | Change |
|---|---|
| `plane-mcp-server.ts` | +4 write tools |
| `agent-runner.ts` | +`runAutonomousAgent` function |
| `index.ts` | Keyword router (action vs Q&A) |

## Non-Goals (this sprint)

- GitHub MCP for PR creation (use git push + branch URL instead)
- Scheduled triggers (daily standup)
- Multi-turn conversation threads
