#!/bin/bash
set -euo pipefail
echo "=== Zenova Landing Page Agent Starting ==="
echo "Task ID: ${TASK_ID}"
echo "Issue: ${ISSUE_TITLE}"
echo "${GITHUB_TOKEN}" | gh auth login --with-token
REPO_URL="${REPO_URL:-}"
if [ -n "$REPO_URL" ]; then
  git clone "$REPO_URL" /workspace/repo
  cd /workspace/repo
fi
BRANCH_NAME="agent/${AGENT_TYPE}/${TASK_ID}"
git checkout -b "$BRANCH_NAME"
PROMPT="$(cat /agent/prompt.md)

## Current Task
**Issue:** ${ISSUE_TITLE}
**Description:** ${ISSUE_DESCRIPTION}
**Instructions:** Work on this task. Generate all necessary landing page components, routes, and styles. When done, commit and push your branch, then create a pull request."

claude --print --dangerously-skip-permissions "$PROMPT"
git push origin "$BRANCH_NAME"
PR_URL=$(gh pr create --title "[Landing] ${ISSUE_TITLE}" --body "Automated by Zenova Landing Page Agent\n\nTask: ${TASK_ID}\nIssue: ${ISSUE_ID}" --head "$BRANCH_NAME" 2>&1)
echo "PR created: $PR_URL"
if [ -n "${PLANE_API_URL:-}" ] && [ -n "${PLANE_API_TOKEN:-}" ]; then
  jq -n --arg url "$PR_URL" --arg title "Pull Request" '{url: $url, title: $title}' | \
    curl -s -X POST "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/links/" \
      -H "X-API-Key: ${PLANE_API_TOKEN}" -H "Content-Type: application/json" -d @-
  jq -n --arg html "<p>Landing page agent completed. PR: ${PR_URL}</p>" '{comment_html: $html}' | \
    curl -s -X POST "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/comments/" \
      -H "X-API-Key: ${PLANE_API_TOKEN}" -H "Content-Type: application/json" -d @-
fi
echo "=== Landing Page Agent Complete ==="
