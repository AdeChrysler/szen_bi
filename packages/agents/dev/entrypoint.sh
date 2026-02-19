#!/bin/bash
set -euo pipefail

echo "=== Zenova Dev Agent Starting ==="
echo "Task ID: ${TASK_ID}"
echo "Issue: ${ISSUE_TITLE}"

# Helper: post comment to Plane issue
post_comment() {
  local msg="$1"
  if [ -n "${PLANE_API_URL:-}" ] && [ -n "${PLANE_API_TOKEN:-}" ]; then
    jq -n --arg html "<p>${msg}</p>" '{comment_html: $html}' | \
      curl -s -X POST "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/comments/" \
        -H "X-API-Key: ${PLANE_API_TOKEN}" -H "Content-Type: application/json" -d @- > /dev/null 2>&1 || true
  fi
}

# Helper: transition issue state by group name
transition_state() {
  local group="$1"
  if [ -n "${PLANE_API_URL:-}" ] && [ -n "${PLANE_API_TOKEN:-}" ]; then
    STATE_ID=$(curl -s "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/states/" \
      -H "X-API-Key: ${PLANE_API_TOKEN}" | \
      jq -r --arg g "$group" '.results // . | map(select(.group == $g)) | first | .id // empty')
    if [ -n "$STATE_ID" ]; then
      jq -n --arg s "$STATE_ID" '{state: $s}' | \
        curl -s -X PATCH "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/" \
          -H "X-API-Key: ${PLANE_API_TOKEN}" -H "Content-Type: application/json" -d @- > /dev/null 2>&1 || true
    fi
  fi
}

# Transition to In Progress
post_comment "🤖 Dev agent picked up this issue. Starting work..."
transition_state "started"

# Auth GitHub
echo "${GITHUB_TOKEN}" | gh auth login --with-token

# Clone repo
post_comment "📦 Cloning repository..."
REPO_URL="${REPO_URL:-}"
if [ -n "$REPO_URL" ]; then
  git clone "$REPO_URL" /workspace/repo
  cd /workspace/repo
fi

# Configure git identity
git config user.email "dev-agent@zenova.id"
git config user.name "Zenova Dev Agent"

# Create branch
BRANCH_NAME="agent/${AGENT_TYPE}/${TASK_ID}"
git checkout -b "$BRANCH_NAME"
post_comment "🌿 Created branch: \`${BRANCH_NAME}\`"

# Run Claude Code
post_comment "🧠 Running Claude Code on this task..."
PROMPT="$(cat /agent/prompt.md)

## Current Task
**Issue:** ${ISSUE_TITLE}
**Description:** ${ISSUE_DESCRIPTION}
**Instructions:** Work on this task. Create all necessary changes. When done, commit your changes with a clear message."

claude --print --dangerously-skip-permissions "$PROMPT"

# Push branch
post_comment "⬆️ Pushing changes..."
git push origin "$BRANCH_NAME"

# Create PR
PR_URL=$(gh pr create \
  --title "[Agent] ${ISSUE_TITLE}" \
  --body "$(printf 'Automated by Zenova Dev Agent\n\nTask: %s\nIssue: %s' "${TASK_ID}" "${ISSUE_ID}")" \
  --head "$BRANCH_NAME" 2>&1)

echo "PR created: $PR_URL"

# Post PR link and final comment
if [ -n "${PLANE_API_URL:-}" ] && [ -n "${PLANE_API_TOKEN:-}" ]; then
  # Add PR as issue link
  jq -n --arg url "$PR_URL" --arg title "Pull Request" '{url: $url, title: $title}' | \
    curl -s -X POST "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/links/" \
      -H "X-API-Key: ${PLANE_API_TOKEN}" -H "Content-Type: application/json" -d @- > /dev/null 2>&1 || true

  post_comment "✅ Done! PR ready for review: ${PR_URL}"
fi

# Transition to In Review
transition_state "unstarted"

echo "=== Dev Agent Complete ==="
