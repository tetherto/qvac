#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

make_fixture() {
  local name="$1"
  local root="$TEST_ROOT/$name"

  mkdir -p \
    "$root/.agents/skills/example" \
    "$root/packages/ocr-ggml/.agent/agents" \
    "$root/packages/ocr-ggml/.agent/knowledge" \
    "$root/packages/ocr-ggml/.agent/skills"
  cp "$REPO_ROOT/packages/ocr-ggml/.agent/setup.sh" \
    "$root/packages/ocr-ggml/.agent/setup.sh"
  printf '%s\n' '---' 'name: example' 'description: Test skill' '---' \
    > "$root/.agents/skills/example/SKILL.md"
  printf '%s\n' '# Conduct' > "$root/packages/ocr-ggml/.agent/conduct.md"
  printf '%s\n' '{}' > "$root/packages/ocr-ggml/.agent/settings.json"
  printf '%s\n' '{"servers":{}}' > "$root/packages/ocr-ggml/.agent/mcp.json"
  printf '%s\n' "$root"
}

run_setup() {
  local root="$1"

  (
    cd "$root"
    bash packages/ocr-ggml/.agent/setup.sh claude
  )
}

test_unmanaged_directory_is_preserved() {
  local root
  root="$(make_fixture unmanaged-directory)"
  mkdir -p "$root/.claude/skills/example"
  printf '%s\n' 'keep me' > "$root/.claude/skills/example/notes.txt"

  if run_setup "$root" > "$root/setup.log" 2>&1; then
    fail "setup accepted an unmanaged skill directory"
  fi
  [ -f "$root/.claude/skills/example/notes.txt" ] ||
    fail "setup deleted a file from an unmanaged skill directory"
  [ ! -e "$root/.claude/skills/example/example" ] ||
    fail "setup created a nested link inside an unmanaged skill directory"
  [ ! -e "$root/.claude/agent-conduct.md" ] ||
    fail "setup generated other Claude files before reporting the collision"
}

test_untrusted_manifest_does_not_grant_ownership() {
  local root
  root="$(make_fixture untrusted-manifest)"
  mkdir -p "$root/.claude/skills/example"
  printf '%s\n' 'keep me' > "$root/.claude/skills/example/notes.txt"
  printf '%s\n' 'example' > "$root/.claude/skills/.qvac-repository-skills"

  if run_setup "$root" > "$root/setup.log" 2>&1; then
    fail "setup trusted a manifest entry without verifying its destination"
  fi
  [ -f "$root/.claude/skills/example/notes.txt" ] ||
    fail "setup deleted a user file named by an untrusted manifest"
}

test_individual_legacy_link_is_migrated() {
  local root
  local target
  root="$(make_fixture legacy-link)"
  mkdir -p "$root/.claude/skills" "$root/.cursor/skills/example"
  printf '%s\n' 'keep me' > "$root/.cursor/skills/example/notes.txt"
  ln -s ../../.cursor/skills/example "$root/.claude/skills/example"

  run_setup "$root" > "$root/setup.log" 2>&1
  target="$(readlink "$root/.claude/skills/example")"
  [ "$target" = '../../.agents/skills/example' ] ||
    fail "setup did not migrate the legacy per-skill link"
  [ -f "$root/.cursor/skills/example/notes.txt" ] ||
    fail "setup modified the legacy link target"
  [ ! -e "$root/.cursor/skills/example/example" ] ||
    fail "setup created a nested link in the legacy target"

  run_setup "$root" > "$root/setup-second.log" 2>&1
  [ "$(readlink "$root/.claude/skills/example")" = '../../.agents/skills/example' ] ||
    fail "repeated setup changed the canonical link"
}

test_shared_skills_link_requires_manual_choice() {
  local root
  root="$(make_fixture shared-root-link)"
  mkdir -p "$root/.claude" "$root/.cursor/skills"
  printf '%s\n' 'keep me' > "$root/.cursor/skills/notes.txt"
  ln -s ../.cursor/skills "$root/.claude/skills"

  if run_setup "$root" > "$root/setup.log" 2>&1; then
    fail "setup replaced a shared skills-directory link"
  fi
  [ -L "$root/.claude/skills" ] ||
    fail "setup removed the shared skills-directory link"
  [ -f "$root/.cursor/skills/notes.txt" ] ||
    fail "setup modified the shared skills-directory target"
  grep -Eq 'rm ".*/\.claude/skills"' "$root/setup.log" ||
    fail "setup did not print the safe symlink-removal command"
}

test_unmanaged_directory_is_preserved
test_untrusted_manifest_does_not_grant_ownership
test_individual_legacy_link_is_migrated
test_shared_skills_link_requires_manual_choice

echo "Agent setup regression tests passed."
