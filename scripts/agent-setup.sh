#!/usr/bin/env bash
#
# Configure repository-wide agent tooling for hosts that need an adapter.
#
# Usage: scripts/agent-setup.sh [claude]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

copy_plain() {
  local src="$1"
  local dst="$2"

  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "  copied: $dst"
}

repository_skill_link_is_managed() {
  local target="$1"
  local source_root="$2"
  local skill_name="$3"
  local link_target

  [ -L "$target" ] || return 1
  link_target="$(readlink "$target")"
  case "$link_target" in
    "../../.agents/skills/$skill_name"|\
    "$source_root/$skill_name"|\
    "../../.cursor/skills/$skill_name"|\
    "$REPO_ROOT/.cursor/skills/$skill_name")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

repository_skill_copy_is_managed() {
  local target="$1"
  local skill_name="$2"
  local marker="$target/.qvac-repository-skill"

  [ -f "$marker" ] && [ "$(cat "$marker")" = "$skill_name" ]
}

print_skill_collision() {
  local target="$1"

  echo "Error: refusing to replace an unmanaged Claude skill entry:" >&2
  echo "  $target" >&2
  echo "Move or remove that entry after preserving anything you need, then rerun:" >&2
  echo "  bash scripts/agent-setup.sh claude" >&2
}

preflight_claude_skill_root() {
  local target_root="$1"

  if [ -L "$target_root" ]; then
    echo "Error: $target_root is a symlink to $(readlink "$target_root")." >&2
    echo "Setup will not replace a shared skills directory because it may contain personal skills." >&2
    echo "To remove only the symlink (not its target) and create the new compatibility view, run:" >&2
    echo "  rm \"$target_root\"" >&2
    echo "  bash scripts/agent-setup.sh claude" >&2
    return 1
  fi

  if [ -e "$target_root" ] && [ ! -d "$target_root" ]; then
    print_skill_collision "$target_root"
    return 1
  fi
}

preflight_repository_skills_for_claude() {
  local source_root="$1"
  local target_root="$2"
  local manifest="$3"
  local platform="$4"
  local skill_name
  local target

  preflight_claude_skill_root "$target_root" || return 1

  for skill_dir in "$source_root"/*/; do
    [ -f "$skill_dir/SKILL.md" ] || continue
    skill_name="$(basename "$skill_dir")"
    [ "$skill_name" = "setup" ] && continue
    target="$target_root/$skill_name"

    [ ! -e "$target" ] && [ ! -L "$target" ] && continue
    case "$platform" in
      CYGWIN*|MINGW*|MSYS*)
        repository_skill_copy_is_managed "$target" "$skill_name" && continue
        ;;
      *)
        repository_skill_link_is_managed "$target" "$source_root" "$skill_name" && continue
        ;;
    esac

    print_skill_collision "$target"
    return 1
  done

  [ -f "$manifest" ] || return 0
  while IFS= read -r skill_name; do
    case "$skill_name" in
      ""|*[!a-z0-9-]*) continue ;;
    esac
    [ "$skill_name" = "setup" ] && continue
    [ -f "$source_root/$skill_name/SKILL.md" ] && continue
    target="$target_root/$skill_name"
    [ ! -e "$target" ] && [ ! -L "$target" ] && continue

    case "$platform" in
      CYGWIN*|MINGW*|MSYS*)
        repository_skill_copy_is_managed "$target" "$skill_name" && continue
        ;;
      *)
        repository_skill_link_is_managed "$target" "$source_root" "$skill_name" && continue
        ;;
    esac

    print_skill_collision "$target"
    return 1
  done < "$manifest"
}

remove_managed_repository_skill() {
  local target="$1"
  local skill_name="$2"
  local platform="$3"

  [ ! -e "$target" ] && [ ! -L "$target" ] && return 0
  case "$platform" in
    CYGWIN*|MINGW*|MSYS*)
      repository_skill_copy_is_managed "$target" "$skill_name"
      rm -rf "$target"
      ;;
    *)
      [ -L "$target" ]
      rm "$target"
      ;;
  esac
}

sync_repository_skills_for_claude() {
  local source_root="$1"
  local target_root="$2"
  local manifest="$3"
  local platform
  local skill_name
  local rel
  local target
  local manifest_tmp

  platform="$(uname -s)"
  preflight_repository_skills_for_claude \
    "$source_root" \
    "$target_root" \
    "$manifest" \
    "$platform"
  mkdir -p "$target_root"

  if [ -f "$manifest" ]; then
    while IFS= read -r skill_name; do
      case "$skill_name" in
        ""|*[!a-z0-9-]*) continue ;;
      esac
      [ "$skill_name" = "setup" ] && continue
      remove_managed_repository_skill \
        "$target_root/$skill_name" \
        "$skill_name" \
        "$platform"
    done < "$manifest"
  fi

  manifest_tmp="$manifest.tmp.$$"
  : > "$manifest_tmp"

  for skill_dir in "$source_root"/*/; do
    [ -f "$skill_dir/SKILL.md" ] || continue
    skill_name="$(basename "$skill_dir")"
    [ "$skill_name" = "setup" ] && continue
    target="$target_root/$skill_name"
    remove_managed_repository_skill "$target" "$skill_name" "$platform"

    case "$platform" in
      CYGWIN*|MINGW*|MSYS*)
        copy_plain "$skill_dir/SKILL.md" "$target/SKILL.md"
        find "$skill_dir" -type f ! -name "SKILL.md" | while read -r f; do
          rel="${f#$skill_dir}"
          copy_plain "$f" "$target/$rel"
        done
        printf '%s\n' "$skill_name" > "$target/.qvac-repository-skill"
        ;;
      *)
        ln -s "../../.agents/skills/$skill_name" "$target"
        echo "  linked: $target"
        ;;
    esac
    printf '%s\n' "$skill_name" >> "$manifest_tmp"
  done

  mv "$manifest_tmp" "$manifest"
}

target="${1:-claude}"

case "$target" in
  claude)
    echo "=== Repository Agent Setup ==="
    echo "Setting up Claude Code repository skills (.claude/skills/)..."
    sync_repository_skills_for_claude \
      "$REPO_ROOT/.agents/skills" \
      "$REPO_ROOT/.claude/skills" \
      "$REPO_ROOT/.claude/skills/.qvac-repository-skills"
    echo "Claude Code repository skill setup complete."
    ;;
  *)
    echo "Usage: scripts/agent-setup.sh [claude]" >&2
    exit 1
    ;;
esac
