#!/bin/bash
set -e

TASK_ID=$1
if [ -z "$TASK_ID" ]; then
  echo "Usage: ./run-task.sh <asana-task-id>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PITCH_CONTEXT=$(cat "$SCRIPT_DIR/.claude/pitch-context.md" 2>/dev/null || echo "No pitch context found.")
CONDUCT=$(cat "$SCRIPT_DIR/.claude/agent-conduct.md" 2>/dev/null || echo "")
TASKS_MD=$(cat "$SCRIPT_DIR/.claude/tasks.md" 2>/dev/null || echo "No tasks.md found.")

echo "============================================"
echo "  run-task.sh — Agent-First Task Pipeline"
echo "  Task ID: $TASK_ID"
echo "  Started: $(date)"
echo "============================================"
echo ""

# Step 1: Implement
echo "=== STEP 1: IMPLEMENT (task $TASK_ID) ==="
echo ""

claude -p "$(cat "$SCRIPT_DIR/.claude/prompts/implementer.md")

Follow these rules:
$CONDUCT

Pitch context:
$PITCH_CONTEXT

Task breakdown:
$TASKS_MD

Asana task ID: $TASK_ID"

echo ""
echo "=== GATE 1: build + test ==="

# Determine build system
if [ -f "$SCRIPT_DIR/Makefile" ] || command -v bare-make &>/dev/null; then
  echo "Running: bare-make build && bare-make test"
  bare-make build
  bare-make test
elif [ -f "$SCRIPT_DIR/packages/qvac-sdk/package.json" ]; then
  echo "Running: bun run build && bun run test:unit (SDK)"
  cd "$SCRIPT_DIR/packages/qvac-sdk"
  bun run build
  bun run test:unit
  cd "$SCRIPT_DIR"
else
  echo "WARNING: No recognized build system found. Skipping gate."
fi

echo "Gate 1 PASSED"
echo ""

# Step 2: Review
echo "=== STEP 2: REVIEW (task $TASK_ID) ==="
echo ""

claude -p "$(cat "$SCRIPT_DIR/.claude/prompts/reviewer.md")

Follow these rules:
$CONDUCT

Asana task ID: $TASK_ID
Review all changes on the current branch since last merge from main."

echo ""
echo "=== GATE 2: build + test ==="

if [ -f "$SCRIPT_DIR/Makefile" ] || command -v bare-make &>/dev/null; then
  echo "Running: bare-make build && bare-make test"
  bare-make build
  bare-make test
elif [ -f "$SCRIPT_DIR/packages/qvac-sdk/package.json" ]; then
  echo "Running: bun run build && bun run test:unit (SDK)"
  cd "$SCRIPT_DIR/packages/qvac-sdk"
  bun run build
  bun run test:unit
  cd "$SCRIPT_DIR"
else
  echo "WARNING: No recognized build system found. Skipping gate."
fi

echo "Gate 2 PASSED"
echo ""

# Step 3: Finalize
echo "=== STEP 3: FINALIZE (task $TASK_ID) ==="
echo ""

claude -p "$(cat "$SCRIPT_DIR/.claude/prompts/hardener.md")

Follow these rules:
$CONDUCT

Asana task ID: $TASK_ID
Push to the current branch, check CI, update Asana with final summary."

echo ""
echo "============================================"
echo "  DONE (task $TASK_ID)"
echo "  Finished: $(date)"
echo "============================================"
