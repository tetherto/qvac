#!/usr/bin/env bash
set -euo pipefail

# sync-qvac-monorepo.sh
# Run from monorepo root.

OWNER="${OWNER:-tetherto}"
MONOREPO_ROOT="${MONOREPO_ROOT:-$(pwd)}"
WORKDIR="${WORKDIR:-$MONOREPO_ROOT/.sync-repos}"
DRY_RUN="${DRY_RUN:-0}"

# --- Hard requirements / sanity checks ---
if [[ -z "${BASH_VERSION-}" ]]; then
  echo "ERROR: This script must be run with bash. Try: bash ./sync-qvac-monorepo.sh" >&2
  exit 1
fi

need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }
need_cmd gh
need_cmd git
need_cmd rsync

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

mkdir -p "$WORKDIR"

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[DRY_RUN] $*"
  else
    "$@"
  fi
}

# --- Mapping: monorepo path -> repo name (values in parentheses in the proposal) ---
# Plain text mapping keeps compatibility with bash 3.2 (no associative arrays).
PATH_TO_REPO_DATA=$(cat <<'EOF'

packages/qvac-lib-infer-nmtcpp qvac-lib-infer-nmtcpp



EOF
)

# Extract repo name for a given destination path.
get_repo_name() {
  local dest="$1"
  while read -r path repo; do
    [[ -z "$path" ]] && continue
    if [[ "$path" == "$dest" ]]; then
      echo "$repo"
      return 0
    fi
  done <<< "$PATH_TO_REPO_DATA"
  return 1
}

# Sorted list of destination paths for deterministic iteration.
get_dest_paths() {
  printf "%s\n" "$PATH_TO_REPO_DATA" | awk 'NF {print $1}' | LC_ALL=C sort
}

get_default_branch() {
  local full="$1"
  gh api "repos/${full}" --jq .default_branch
}

sync_repo_clone() {
  local full="$1"
  local clone_path="$2"

  if [[ ! -d "$clone_path/.git" ]]; then
    echo "  - cloning $full -> $clone_path"
    run gh repo clone "$full" "$clone_path" -- --no-tags
  else
    echo "  - updating clone $clone_path"
    local def_branch
    def_branch="$(get_default_branch "$full")"
    run git -C "$clone_path" fetch origin "$def_branch" --prune
    run git -C "$clone_path" checkout -B "$def_branch" "origin/$def_branch" >/dev/null 2>&1 || true
    run git -C "$clone_path" reset --hard "origin/$def_branch"
    run git -C "$clone_path" clean -ffdqx
  fi
}

replace_target_with_clone_contents() {
  local clone_path="$1"
  local target_path="$2"

  echo "  - placing code into $target_path"
  run rm -rf "$target_path"
  run mkdir -p "$(dirname "$target_path")"
  run mkdir -p "$target_path"
  # Avoid copying VCS metadata and repo-level config like CODEOWNERS/scripts under .github
  run rsync -a --delete --exclude ".git" --exclude ".github" "$clone_path/" "$target_path/"
}

echo "Monorepo root: $MONOREPO_ROOT"
echo "Clone workdir: $WORKDIR"
echo "Owner/org:     $OWNER"
echo "Dry run:       $DRY_RUN"
echo

for dest_rel in $(get_dest_paths); do
  repo_name="$(get_repo_name "$dest_rel")"
  if [[ -z "$repo_name" ]]; then
    echo "ERROR: No repo mapped for destination path: '$dest_rel'" >&2
    exit 1
  fi

  full_repo="${OWNER}/${repo_name}"
  clone_path="${WORKDIR}/${repo_name}"
  target_path="${MONOREPO_ROOT}/${dest_rel}"

  echo "==> ${dest_rel}  <=  ${full_repo}"

  sync_repo_clone "$full_repo" "$clone_path"
  replace_target_with_clone_contents "$clone_path" "$target_path"

  echo "  ✓ done"
  echo
done

echo "All mapped repos synced into the monorepo layout."

