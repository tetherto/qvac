#!/usr/bin/env bash
# QVAC-26667 prototype: builds @qvac/inference against the workspace stack.
#
# Linked to workspace embed 0.55, inference's model-fit and rerank code no
# longer type-checks: embed's breaking releases #5470 and #5398 are not yet
# consumed by inference. That skew is unrelated to decisions. tsc still emits
# JavaScript but exits 2, so the package's own `build` (compile && aliases)
# stops before rewriting the `@/` imports.
#
# This script accepts exactly those diagnostics, fails on any other, then
# always runs the alias rewrite and checks that no `@/` import is left.
#
#   bash scripts/decision-prototype/build-inference.sh   # from the repo root
set -uo pipefail

cd "$(dirname "$0")/../../packages/inference" || exit 1

# The known skew, as "<file>: <TS code>" pairs.
KNOWN='^src/model-fit/classify\.ts\([0-9]+,[0-9]+\): error TS(2339|2345):
^src/plugins/builtin/llamacpp-rerank/plugin\.ts\([0-9]+,[0-9]+\): error TS2322:'

log=$(mktemp)
trap 'rm -f "$log"' EXIT

npx tsc -p tsconfig.build.json --noEmitOnError false >"$log" 2>&1
status=$?

if [ "$status" -ne 0 ]; then
  errors=$(grep -E 'error TS[0-9]+:' "$log")
  unexpected=$(printf '%s\n' "$errors" | grep -vE "$KNOWN")
  # Exit 2 means "emitted with errors"; anything else did not emit.
  if [ "$status" -ne 2 ] || [ -z "$errors" ] || [ -n "$unexpected" ]; then
    cat "$log"
    echo "✖ tsc failed (exit $status) beyond the known model-fit/rerank skew" >&2
    exit 1
  fi
  echo "▸ tsc: $(printf '%s\n' "$errors" | wc -l | tr -d ' ') known diagnostics in model-fit/classify.ts and llamacpp-rerank/plugin.ts (embed #5470/#5398 skew), output emitted"
fi

npx tsc-alias -p tsconfig.alias.json || exit 1

left=$(grep -rlE "(from |import\(|require\()['\"]@/" dist --include='*.js' --include='*.d.ts')
if [ -n "$left" ]; then
  printf '%s\n' "$left"
  echo "✖ unresolved @/ imports remain in dist" >&2
  exit 1
fi
echo "✔ @qvac/inference built (dist/, aliases rewritten)"
