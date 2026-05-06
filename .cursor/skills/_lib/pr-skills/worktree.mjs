// Worktree helpers for the /pr-review skill (sync mode).
//
// One worktree per PR num at ~/.cache/qvac-pr-review/pr-<num>, kept in sync
// with refs/pr/<num>/head via fetch + reset --hard. Concurrency safety via
// per-PR file locks. LRU cleanup capped at 3 worktrees.
//
// All `git worktree`, `git fetch refs/pull/<n>/head:...`, `git -C
// <worktree> reset --hard`, and `git -C <worktree> clean -fdx` calls in this
// module are intentionally scoped to the cache directory and to fork-PR-head
// refs. The agent itself never runs reset / switch / checkout / stash etc. —
// see pr-review/SKILL.md "Safety rules".

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CACHE_ROOT = join(homedir(), ".cache", "qvac-pr-review");

// --- URL parsing ---

const PR_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export function parsePRUrl(url) {
  const m = String(url || "").match(PR_URL_RE);
  if (!m) {
    throw new Error(`Not a recognizable GitHub PR URL: ${url}`);
  }
  return { owner: m[1], repo: m[2], num: Number(m[3]) };
}

// --- Shell helpers ---

function git(args, opts = {}) {
  // Silence git's stderr (progress, "From github.com:..."). Our stderr is
  // reserved for the WORKTREE_FALLBACK marker and must stay clean.
  return execFileSync("git", args, {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    ...opts,
  }).trim();
}

function tryGit(args, opts = {}) {
  try {
    return { ok: true, out: git(args, opts) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// --- Repo / remote resolution ---

function repoRoot() {
  return git(["rev-parse", "--show-toplevel"]);
}

// Find the local remote whose URL points at <owner>/<repo>. Prefer
// `upstream`, fall back to `origin`, then any other matching remote.
function resolveRemote(owner, repo) {
  const lines = git(["remote", "-v"]).split("\n").filter(Boolean);
  const candidates = new Map();
  const matchSlug = `${owner}/${repo}`.toLowerCase();
  for (const line of lines) {
    // format: "<name>\t<url> (fetch|push)"
    const [name, rest] = line.split(/\s+/, 2);
    if (!name || !rest) continue;
    const url = rest.toLowerCase();
    if (
      url.includes(`/${matchSlug}.git`) ||
      url.includes(`/${matchSlug} `) ||
      url.endsWith(`/${matchSlug}`) ||
      url.endsWith(`:${matchSlug}.git`) ||
      url.endsWith(`:${matchSlug}`)
    ) {
      candidates.set(name, true);
    }
  }
  if (candidates.has("upstream")) return "upstream";
  if (candidates.has("origin")) return "origin";
  const first = candidates.keys().next().value;
  if (first) return first;
  throw new Error(
    `No git remote points at ${owner}/${repo}; ` +
      `add one (e.g. \`git remote add upstream https://github.com/${owner}/${repo}.git\`)`,
  );
}

// --- Sleep + lock ---

function sleepMs(ms) {
  // Synchronous sleep without setTimeout via SharedArrayBuffer.
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_TIMEOUT_MS = 30 * 1000;
const LOCK_RETRY_MS = 100;

// Acquire a per-PR lock. Returns a release function. Throws on timeout.
//
// Implementation: O_CREAT | O_EXCL on the lock file (Node's "wx" flag) is
// atomic across processes on POSIX filesystems. Stale-lock detection
// (older than LOCK_STALE_MS AND owning PID is dead) breaks deadlocks if a
// previous run died without cleanup.
export function lockPR(num) {
  if (!existsSync(CACHE_ROOT)) {
    mkdirSync(CACHE_ROOT, { recursive: true });
  }
  const lockPath = join(CACHE_ROOT, `pr-${num}.lock`);
  const start = Date.now();
  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(lockPath);
        } catch {
          // best-effort
        }
      };
      // Make sure a crash still releases the lock.
      const onExit = () => release();
      process.once("exit", onExit);
      process.once("SIGINT", () => {
        release();
        process.exit(130);
      });
      process.once("SIGTERM", () => {
        release();
        process.exit(143);
      });
      return release;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Lock exists. Maybe it's stale.
      try {
        const st = statSync(lockPath);
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs > LOCK_STALE_MS) {
          let pidAlive = false;
          try {
            const pid = Number.parseInt(
              readFileSync(lockPath, "utf-8").trim(),
              10,
            );
            if (Number.isFinite(pid)) {
              try {
                process.kill(pid, 0);
                pidAlive = true;
              } catch {
                pidAlive = false;
              }
            }
          } catch {
            // unreadable -- treat as stale
          }
          if (!pidAlive) {
            try {
              unlinkSync(lockPath);
            } catch {
              // race: another process broke it first
            }
            continue;
          }
        }
      } catch {
        // Lock vanished between EEXIST and stat -- retry immediately.
        continue;
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(
          `Could not acquire lock ${lockPath} within ${LOCK_TIMEOUT_MS}ms ` +
            `(another /pr-review may be running on this PR)`,
        );
      }
      sleepMs(LOCK_RETRY_MS);
    }
  }
}

// --- Fetch + worktree management ---

const PR_REF = (num) => `refs/pr/${num}/head`;
const PULL_REFSPEC = (num) => `pull/${num}/head:refs/pr/${num}/head`;

// Resolve the PR's base ref name via `gh pr view`. Throws if the metadata
// cannot be obtained — defaulting to "main" would compute the wrong patch
// for PRs that target release-* or feature/tmp branches (the worktree
// would be diffed against the wrong base, producing a patch that does
// not match what GitHub shows on the PR). The caller (worktree-prepare)
// turns the throw into a WORKTREE_FALLBACK so the skill drops back to
// the API path (`gh pr diff`) which always uses the correct base.
function resolveBaseRefName({ owner, repo, num }) {
  let out;
  try {
    out = execFileSync(
      "gh",
      [
        "pr",
        "view",
        String(num),
        "--repo",
        `${owner}/${repo}`,
        "--json",
        "baseRefName",
        "--jq",
        ".baseRefName",
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch (e) {
    throw new Error(
      `gh pr view failed while resolving base ref for ${owner}/${repo}#${num}: ${e.message || e}`,
    );
  }
  if (!out) {
    throw new Error(
      `gh pr view returned empty baseRefName for ${owner}/${repo}#${num}`,
    );
  }
  return out;
}

// Resolve remote + base for a PR. Returned values are pure metadata; no
// network calls beyond the gh PR-metadata lookup happen here.
export function resolvePR({ owner, repo, num }) {
  const remote = resolveRemote(owner, repo);
  const baseRefName = resolveBaseRefName({ owner, repo, num });
  return { remote, baseRefName };
}

// Fetch BOTH the PR head ref and the base branch in a single `git fetch`,
// updating refs/pr/<num>/head and refs/remotes/<remote>/<baseRefName>.
// Returns the head SHA.
//
// `git fetch` writes progress to stderr; we silence it via 2>/dev/null
// equivalent so the script's stderr stays clean for our own markers.
export function fetchPRRefs({ remote, baseRefName, num }) {
  execFileSync(
    "git",
    [
      "fetch",
      remote,
      PULL_REFSPEC(num),
      `${baseRefName}:refs/remotes/${remote}/${baseRefName}`,
    ],
    {
      encoding: "utf-8",
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  return git(["rev-parse", PR_REF(num)]);
}

// Backward-compatible single-fetch helper (kept for any callers that don't
// need the base ref). New code should use resolvePR + fetchPRRefs.
export function fetchPRHead({ owner, repo, num }) {
  const remote = resolveRemote(owner, repo);
  execFileSync("git", ["fetch", remote, PULL_REFSPEC(num)], {
    encoding: "utf-8",
    stdio: ["ignore", "ignore", "ignore"],
  });
  return git(["rev-parse", PR_REF(num)]);
}

function isRegisteredWorktree(absPath) {
  const out = tryGit(["worktree", "list", "--porcelain"]);
  if (!out.ok) return false;
  for (const block of out.out.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("worktree "));
    if (line && line.slice("worktree ".length).trim() === absPath) return true;
  }
  return false;
}

function isWorktreeClean(absPath) {
  const out = tryGit(["-C", absPath, "status", "--porcelain"]);
  return out.ok && out.out.length === 0;
}

function removeWorktree(absPath) {
  // Try the clean removal first; fall back to force; clean up a stub on disk.
  tryGit(["worktree", "remove", "--force", absPath]);
  if (existsSync(absPath)) {
    try {
      rmSync(absPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tryGit(["worktree", "prune"]);
}

function touchPath(p) {
  const now = new Date();
  try {
    utimesSync(p, now, now);
  } catch {
    // ignore
  }
}

// Ensure ~/.cache/qvac-pr-review/pr-<num> exists and is at <sha>.
//
// Caller MUST hold lockPR(num) for the duration of this call to avoid
// `reset --hard` racing another invocation.
export function ensureWorktreeSynced({ num, sha }) {
  if (!existsSync(CACHE_ROOT)) {
    mkdirSync(CACHE_ROOT, { recursive: true });
  }
  const path = join(CACHE_ROOT, `pr-${num}`);

  // Inside main repo for git worktree commands.
  const root = repoRoot();
  const wtAdd = (target) =>
    git(["-C", root, "worktree", "add", "--detach", target, PR_REF(num)]);

  if (!existsSync(path)) {
    wtAdd(path);
    touchPath(path);
    return { path, sha };
  }

  // Path exists. Ensure it's a registered worktree we can trust.
  if (!isRegisteredWorktree(path)) {
    removeWorktree(path);
    wtAdd(path);
    touchPath(path);
    return { path, sha };
  }

  const headNow = git(["-C", path, "rev-parse", "HEAD"]);
  if (headNow !== sha) {
    git(["-C", path, "reset", "--hard", PR_REF(num)]);
    // Drop build/test artifacts from the old PR head so the next /pr-test
    // setup starts from a clean artifact state for the new commit.
    git(["-C", path, "clean", "-fdx"]);
  } else if (!isWorktreeClean(path)) {
    // Preserve untracked artifacts (node_modules, dist, native build dirs)
    // while discarding tracked-file edits before exposing the PR head again.
    git(["-C", path, "reset", "--hard", "HEAD"]);
  }
  touchPath(path);
  return { path, sha };
}

// --- Patch computation ---

// Compute the PR diff locally using a 3-dot diff against the base ref:
//
//   git -C <worktree> diff <remote>/<baseRefName>...HEAD
//
// 3-dot semantics matter: it diffs from merge-base(HEAD, base) to HEAD,
// which is exactly what the GitHub PR view shows. 2-dot would include
// every commit base has gained since the PR forked as `-` deletions,
// which is nonsense for a code review.
//
// Writes the patch to /tmp/pr-<num>.patch and returns the path.
//
// Hardcoded /tmp/ rather than os.tmpdir() because the SKILL workflow
// references /tmp/pr-<num>.patch directly and macOS's tmpdir is
// $TMPDIR (/var/folders/...), not /tmp.
export function computePatch({ worktreePath, num, remote, baseRefName }) {
  const patchPath = `/tmp/pr-${num}.patch`;
  const out = execFileSync(
    "git",
    ["-C", worktreePath, "diff", `${remote}/${baseRefName}...HEAD`],
    {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  writeFileSync(patchPath, out);
  return patchPath;
}

// --- LRU cleanup ---

const LRU_KEEP = 3;

export function cleanupCache({ keep = LRU_KEEP } = {}) {
  if (!existsSync(CACHE_ROOT)) return;
  const entries = readdirSync(CACHE_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^pr-\d+$/.test(e.name))
    .map((e) => {
      const p = join(CACHE_ROOT, e.name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(p).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      return { name: e.name, path: p, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const toEvict = entries.slice(keep);
  for (const e of toEvict) {
    removeWorktree(e.path);
    // also evict the matching lock file if any
    const lockPath = join(CACHE_ROOT, `${e.name}.lock`);
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
  // Final prune for any half-registered worktrees from unrelated paths.
  tryGit(["worktree", "prune"]);
}
