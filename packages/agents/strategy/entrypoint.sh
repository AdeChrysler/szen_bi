#!/bin/bash
set -euo pipefail

echo "=== Zenova Strategy Agent Starting ==="
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

post_comment "📊 Strategy agent started. Analyzing request..."
transition_state "started"

PROMPT="$(cat /agent/prompt.md)

## Current Task
**Issue:** ${ISSUE_TITLE}
**Description:** ${ISSUE_DESCRIPTION}
**Instructions:** Produce a thorough strategic analysis or document based on this task. Write it in Markdown."

post_comment "🧠 Running analysis with Claude..."
OUTPUT=$(claude --print --dangerously-skip-permissions "$PROMPT")

# Post output as a comment (truncate to 4000 chars to avoid Plane limits)
if [ -n "${PLANE_API_URL:-}" ] && [ -n "${PLANE_API_TOKEN:-}" ]; then
  TRUNCATED=$(echo "$OUTPUT" | head -c 4000)
  jq -n --arg html "<p><strong>Strategy output:</strong></p><pre>${TRUNCATED}</pre>" '{comment_html: $html}' | \
    curl -s -X POST "${PLANE_API_URL}/api/v1/workspaces/${WORKSPACE_SLUG}/projects/${PROJECT_ID}/issues/${ISSUE_ID}/comments/" \
      -H "X-API-Key: ${PLANE_API_TOKEN}" -H "Content-Type: application/json" -d @- > /dev/null 2>&1 || true
fi

post_comment "✅ Strategy analysis complete."
transition_state "completed"

echo "=== Strategy Agent Complete ==="
