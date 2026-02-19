#!/bin/bash
# scripts/local-test.sh
# Quick smoke test: send a fake webhook to the orchestrator
set -euo pipefail

ORCH_URL="${1:-http://localhost:4000}"

echo "=== Health Check ==="
curl -s "$ORCH_URL/health" | jq .

echo ""
echo "=== Status ==="
curl -s "$ORCH_URL/status" | jq .

echo ""
echo "=== Sending test webhook (dev agent) ==="
curl -s -X POST "$ORCH_URL/webhooks/plane" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "issue",
    "action": "updated",
    "data": {
      "id": "test-issue-001",
      "name": "Build a login page",
      "description_stripped": "Create a simple login page with email and password fields",
      "priority": "high",
      "state": {"name": "Todo", "group": "backlog"},
      "assignees": ["REPLACE-WITH-DEV-AGENT-UUID"],
      "labels": [{"id": "l1", "name": "dev"}],
      "project": "test-project",
      "workspace": "test-workspace"
    }
  }' | jq .

echo ""
echo "=== Status after dispatch ==="
curl -s "$ORCH_URL/status" | jq .
