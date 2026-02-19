#!/bin/bash
set -euo pipefail

echo "=== Zenova Landing Agent Starting ==="
echo "Task ID: ${TASK_ID}"
echo "Issue: ${ISSUE_TITLE}"

post_comment() {
  local msg="$1"
  if [ -n "${PLANE_API_URL:-}" ] && [ -n "${PLANE_API_TOKEN:-}" ]; then
    jq -n --arg html "<p>${msg}</p>" '{comment_html: $html}' | \
      curl -s -X POST "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/comments/" \
        -H "X-API-Key: ${PLANE_API_TOKEN}" -H "Content-Type: application/json" -d @- > /dev/null 2>&1 || true
  fi
}

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

post_comment "🚀 Landing agent picked up this issue. Starting work..."
transition_state "started"

echo "${GITHUB_TOKEN}" | gh auth login --with-token

post_comment "📦 Cloning repository..."
REPO_URL="${REPO_URL:-}"
if [ -n "$REPO_URL" ]; then
  git clone "$REPO_URL" /workspace/repo
  cd /workspace/repo
fi

git config user.email "landing-agent@zenova.id"
git config user.name "Zenova Landing Agent"

BRANCH_NAME="agent/landing/${TASK_ID}"
git checkout -b "$BRANCH_NAME"
post_comment "🌿 Created branch: \`${BRANCH_NAME}\`"

post_comment "🎨 Building landing page with Claude Code..."
PROMPT="$(cat /agent/prompt.md)

## Current Task
**Issue:** ${ISSUE_TITLE}
**Description:** ${ISSUE_DESCRIPTION}
**Instructions:** Build the landing page or marketing content described. Create production-quality HTML/CSS/JS or framework components. When done, commit with a clear message."

claude --print --dangerously-skip-permissions "$PROMPT"

post_comment "⬆️ Pushing changes..."
git push origin "$BRANCH_NAME"

PR_URL=$(gh pr create \
  --title "[Landing Agent] ${ISSUE_TITLE}" \
  --body "$(printf 'Automated by Zenova Landing Agent\n\nTask: %s\nIssue: %s' "${TASK_ID}" "${ISSUE_ID}")" \
  --head "$BRANCH_NAME" 2>&1)

echo "PR created: $PR_URL"

if [ -n "${PLANE_API_URL:-}" ] && [ -n "${PLANE_API_TOKEN:-}" ]; then
  jq -n --arg url "$PR_URL" --arg title "Pull Request" '{url: $url, title: $title}' | \
    curl -s -X POST "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/links/" \
      -H "X-API-Key: ${PLANE_API_TOKEN}" -H "Content-Type: application/json" -d @- > /dev/null 2>&1 || true

  post_comment "✅ Done! PR ready for review: ${PR_URL}"
fi

transition_state "unstarted"

echo "=== Landing Agent Complete ==="
