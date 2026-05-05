#!/usr/bin/env node
//
// CLI entry for the default-on worktree mode of /pr-review.
//
// Usage:
//   node worktree-prepare.mjs <PR-URL>
//
// On success prints (stdout):
//   WORKTREE_PATH=<absolute path>
//   HEAD_SHA=<sha>
//   PATCH_PATH=<absolute path to /tmp/pr-<num>.patch, computed via 3-dot diff>
//   BASE_REF=<remote>/<baseRefName>
//
// On failure (any reason) prints (stderr) and exits 0:
//   WORKTREE_FALLBACK=<one-line reason>
//
// The exit-0-on-failure contract is intentional: the agent must never have
// its review aborted by a worktree problem. The skill workflow falls back to
// API-only mode when WORKTREE_FALLBACK is observed.

import {
  parsePRUrl,
  lockPR,
  resolvePR,
  fetchPRRefs,
  ensureWorktreeSynced,
  computePatch,
  cleanupCache,
} from "./worktree.mjs";

function fallback(reason) {
  // Single line on stderr, no PII, no command output.
  const oneLine = String(reason || "unknown").replace(/\s+/g, " ").trim();
  process.stderr.write(`WORKTREE_FALLBACK=${oneLine}\n`);
  process.exit(0);
}

const url = process.argv[2];
if (!url) {
  fallback("usage: worktree-prepare.mjs <PR-URL>");
}

let parsed;
try {
  parsed = parsePRUrl(url);
} catch (e) {
  fallback(`url-parse: ${e.message}`);
}

let release = null;
try {
  release = lockPR(parsed.num);
  const { remote, baseRefName } = resolvePR(parsed);
  const sha = fetchPRRefs({ remote, baseRefName, num: parsed.num });
  const { path } = ensureWorktreeSynced({ num: parsed.num, sha });
  const patchPath = computePatch({
    worktreePath: path,
    num: parsed.num,
    remote,
    baseRefName,
  });
  cleanupCache();
  process.stdout.write(`WORKTREE_PATH=${path}\n`);
  process.stdout.write(`HEAD_SHA=${sha}\n`);
  process.stdout.write(`PATCH_PATH=${patchPath}\n`);
  process.stdout.write(`BASE_REF=${remote}/${baseRefName}\n`);
  process.exit(0);
} catch (e) {
  fallback(`${e.message || e}`);
} finally {
  if (release) {
    try {
      release();
    } catch {
      // ignore
    }
  }
}
