#!/usr/bin/env bash
#
# remote-update.sh — deploy the registry-server package onto a single node.
#
# Runs ON a registry node, executed as the run-as-user via `sudo su -` after the
# SA logs in over `gcloud compute ssh --tunnel-through-iap`.
#
# Modes (env MODE):
#   live      (default) checkout the pinned commit, npm install, build:spec,
#             pm2 reload, then block until the node reports indexer status
#   dry-run   reachability/preflight only — no checkout/reload, no mutation
#
# Configuration via environment variables (set on the ssh command line) so no
# secret or value is interpolated into a logged shell string:
#
#   DEPLOY_SHA              (required) commit to deploy — pin the exact ref
#   REPO_PATH              (required) absolute path to the git clone on the node
#   PKG_SUBDIR             package dir within the repo (default: packages/registry-server)
#   PM2_PROCESS            pm2 process name (default: registry)
#   METRICS_PORT          local Prometheus port to health-check (default: 9210)
#   HEALTH_TIMEOUT_SECONDS time to wait for indexer status (default: 120)
#   MODE                  live | dry-run (default: live)
#
set -euo pipefail

DEPLOY_SHA="${DEPLOY_SHA:?DEPLOY_SHA is required}"
REPO_PATH="${REPO_PATH:?REPO_PATH is required}"
PKG_SUBDIR="${PKG_SUBDIR:-packages/registry-server}"
PM2_PROCESS="${PM2_PROCESS:-registry}"
METRICS_PORT="${METRICS_PORT:-9210}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-120}"
MODE="${MODE:-live}"

log() { printf '[remote-update] %s\n' "$*"; }
fail() { printf '[remote-update] ERROR: %s\n' "$*" >&2; exit 1; }

# CI runs this non-interactively (su - <user> -c "... bash -s"), which does not
# source ~/.bashrc where nvm — and therefore node/npm/pm2 — is set up. Load nvm
# explicitly so the toolchain that owns the pm2 daemon is on PATH.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" --no-use
  nvm use default >/dev/null 2>&1 || nvm use node >/dev/null 2>&1 || true
fi
if ! command -v node >/dev/null 2>&1; then
  for _bin in "$NVM_DIR"/versions/node/*/bin; do
    [ -d "$_bin" ] && PATH="$_bin:$PATH"
  done
fi

command -v git >/dev/null || fail "git not found on node"
command -v npm >/dev/null || fail "npm not found on node"
command -v pm2 >/dev/null || fail "pm2 not found on node"
command -v curl >/dev/null || fail "curl not found on node"

[ -d "$REPO_PATH/.git" ] || fail "REPO_PATH '$REPO_PATH' is not a git checkout"
cd "$REPO_PATH"

# Fail-stop on drift: a deploy node's tracked tree must be clean, otherwise a
# forced checkout would silently clobber an out-of-band change on the box.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git --no-pager status --porcelain --untracked-files=no >&2
  fail "tracked files are dirty on the node; refusing to deploy over local changes"
fi

# Corestore safety gate (per architecture review): the live registry storage
# must be git-ignored so `git checkout --force` — which only updates tracked
# files and never deletes untracked/ignored paths — cannot touch it. We never
# run `git clean`. Abort if the storage dir is somehow tracked.
STORAGE_DIR="$PKG_SUBDIR/corestore"
if [ -e "$REPO_PATH/$STORAGE_DIR" ] && ! git check-ignore -q "$STORAGE_DIR"; then
  fail "storage dir '$STORAGE_DIR' exists but is NOT git-ignored — refusing to deploy (would risk the live corestore)"
fi

log "Fetching $DEPLOY_SHA"
git fetch --quiet origin "$DEPLOY_SHA" 2>/dev/null || git fetch --quiet origin

if [ "$MODE" = "dry-run" ]; then
  log "DRY RUN — no changes will be made on $(hostname)"
  log "Would checkout: $DEPLOY_SHA"
  git --no-pager log -1 --oneline "$DEPLOY_SHA" 2>/dev/null || log "(commit not yet fetched in dry run)"
  log "Would run: npm install && npm run build:spec (in $PKG_SUBDIR)"
  log "Would run: pm2 reload $PM2_PROCESS --update-env"
  log "Would health-check: http://127.0.0.1:${METRICS_PORT}/metrics for qvac_registry_is_indexer 1"
  exit 0
fi

log "Checking out $DEPLOY_SHA"
git checkout --quiet --force "$DEPLOY_SHA"

cd "$PKG_SUBDIR"

log "Installing dependencies (npm install)"
npm install --no-audit --no-fund

log "Regenerating spec artifacts (npm run build:spec)"
npm run build:spec

log "Reloading pm2 process '$PM2_PROCESS'"
pm2 reload "$PM2_PROCESS" --update-env

log "Waiting up to ${HEALTH_TIMEOUT_SECONDS}s for indexer status on 127.0.0.1:${METRICS_PORT}"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
until curl -fsS "http://127.0.0.1:${METRICS_PORT}/metrics" 2>/dev/null \
  | grep -qE '^qvac_registry_is_indexer 1$'; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "process status:"
    pm2 describe "$PM2_PROCESS" || true
    log "recent logs:"
    pm2 logs "$PM2_PROCESS" --lines 50 --nostream || true
    fail "node did not report 'qvac_registry_is_indexer 1' within ${HEALTH_TIMEOUT_SECONDS}s"
  fi
  sleep 5
done

log "Node healthy: qvac_registry_is_indexer 1 on $(hostname)"
