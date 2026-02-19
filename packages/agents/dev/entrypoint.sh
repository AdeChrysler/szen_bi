#!/bin/bash
set -euo pipefail
echo "=== Zenova Dev Agent Starting ==="
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
**Instructions:** Work on this task. Create all necessary changes. When done, commit and push your branch, then create a pull request."

claude --print --dangerously-skip-permissions "$PROMPT"
git push origin "$BRANCH_NAME"
PR_URL=$(gh pr create --title "[Agent] ${ISSUE_TITLE}" --body "Automated by Zenova Dev Agent\n\nTask: ${TASK_ID}\nIssue: ${ISSUE_ID}" --head "$BRANCH_NAME" 2>&1)
echo "PR created: $PR_URL"
if [ -n "${PLANE_API_URL:-}" ] && [ -n "${PLANE_API_TOKEN:-}" ]; then
  curl -s -X POST "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/links/" -H "X-API-Key: ${PLANE_API_TOKEN}" -H "Content-Type: application/json" -d "{\"url\": \"${PR_URL}\", \"title\": \"Pull Request\"}"
  curl -s -X POST "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/comments/" -H "X-API-Key: ${PLANE_API_TOKEN}" -H "Content-Type: application/json" -d "{\"comment_html\": \"<p>Dev agent completed. PR: ${PR_URL}</p>\"}"
fi
echo "=== Dev Agent Complete ==="
