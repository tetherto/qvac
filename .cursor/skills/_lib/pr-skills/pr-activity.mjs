import { execFileSync } from "node:child_process";

import { loadConfig, splitRepo } from "../developer-workflow/config.mjs";
import { loadTeam, discoverPods, findPodForFiles } from "./team.mjs";

export const STATE_ICONS = {
  APPROVED: "✅",
  CHANGES_REQUESTED: "❌",
  COMMENTED: "💬",
  DISMISSED: "🔄",
};

const PR_PAGE_SIZE = 30;
const APPROVAL_GATE_RE = /^(check-approvals|tier-based approval check)/i;
const FAILING_STATES = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR"]);

function gh(args) {
  // stderr is piped (not inherited) so it does not leak to the user's terminal
  // on success, but is captured on the thrown error so callers can surface a
  // meaningful reason (e.g. "Could not resolve to a Repository").
  return execFileSync("gh", args, {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function ghErrorReason(error) {
  const stderr = error?.stderr ? error.stderr.toString().trim() : "";
  const firstLine = (stderr || error?.message || "unknown error")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine || "unknown error";
}

function ghGraphQL(query, jq, vars = {}) {
  const args = ["api", "graphql", "--raw-field", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    args.push("-F", `${k}=${v}`);
  }
  if (jq) args.push("--jq", jq);
  const raw = gh(args);
  return raw ? JSON.parse(raw) : null;
}

function isBot(login) {
  return !login || login.endsWith("[bot]");
}

export function rolesForPod(team, currentUser = null) {
  const leadSet = new Set(team.leads);
  const memberLogins = team.members.filter((login) => !leadSet.has(login));
  const allTeam = [...new Set([...team.leads, ...memberLogins])];
  const currentUserRole =
    currentUser && team.leads.includes(currentUser) ? "lead" : "member";
  return { currentUser, currentUserRole, leads: team.leads, members: memberLogins, allTeam };
}

// Formal-review-only state used for approval gates. Most recent non-COMMENTED
// review wins per login. Conversation comments never satisfy approval.
export function getReviewState(reviews) {
  const latest = new Map();
  for (const review of reviews || []) {
    const login = review.author?.login;
    if (!login || isBot(login)) continue;
    if (review.state === "COMMENTED") continue;
    if (!review.submittedAt) continue;
    const prev = latest.get(login);
    if (!prev || review.submittedAt >= prev.submittedAt) {
      latest.set(login, { state: review.state, submittedAt: review.submittedAt });
    }
  }
  const out = new Map();
  for (const [login, entry] of latest) out.set(login, entry.state);
  return out;
}

// Open discussion events for 💬 display / comment-side engagement.
// Resolved review threads are ignored — GitHub keeps the stale
// PullRequestReview(state=COMMENTED) even after "Resolve conversation".
export function openDiscussionEvents(reviewThreads, issueComments) {
  const events = [];
  for (const thread of reviewThreads || []) {
    if (thread.isResolved) continue;
    for (const comment of thread.comments?.nodes || []) {
      const login = comment.author?.login;
      if (!login || isBot(login) || !comment.createdAt) continue;
      events.push({ login, ts: comment.createdAt });
    }
  }
  for (const comment of issueComments || []) {
    const login = comment.author?.login;
    if (!login || isBot(login) || !comment.createdAt) continue;
    events.push({ login, ts: comment.createdAt });
  }
  return events;
}

// Display state: decisive formal reviews + open discussions only.
// Formal COMMENTED reviews are skipped (they linger after threads resolve);
// 💬 comes from unresolved reviewThreads and top-level issue comments.
export function getDisplayReviewState(reviews, comments, authorLogin, reviewThreads = []) {
  const eventsByLogin = new Map();

  function add(login, ts, state) {
    if (!login || login === authorLogin || isBot(login) || !ts) return;
    if (!eventsByLogin.has(login)) eventsByLogin.set(login, []);
    eventsByLogin.get(login).push({ ts, state });
  }

  for (const review of reviews || []) {
    if (review.state === "COMMENTED") continue;
    add(review.author?.login, review.submittedAt, review.state);
  }
  for (const { login, ts } of openDiscussionEvents(reviewThreads, comments)) {
    add(login, ts, "COMMENTED");
  }

  const out = new Map();
  for (const [login, events] of eventsByLogin) {
    events.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const decisive = events.filter((e) =>
      ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(e.state),
    );
    if (decisive.length) {
      out.set(login, decisive[decisive.length - 1].state);
    } else {
      out.set(login, "COMMENTED");
    }
  }
  return out;
}

export function readySince(pr) {
  const event = pr.timelineItems?.nodes?.[0];
  return event?.createdAt || pr.createdAt;
}

export function formatAge(ts, now = Date.now()) {
  const diffMs = now - new Date(ts).getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor(
    (diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
  );
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h`;
}

export function memberState(pr, member) {
  if (member === pr.author.login) return "AUTHOR";
  // Prefer display state when present (includes conversation comments).
  const state = pr.displayReviewState?.get(member) ?? pr.reviewState?.get(member);
  return state || "PENDING";
}

export function hasMemberApprovalInPod(pr, podRoles) {
  return podRoles.members.some((member) => {
    if (member === pr.author.login) return false;
    return pr.reviewState.get(member) === "APPROVED";
  });
}

export function hasLeadApprovalInPod(pr, podRoles) {
  return podRoles.leads.some((member) => {
    if (member === pr.author.login) return false;
    return pr.reviewState.get(member) === "APPROVED";
  });
}

export function isFullyApprovedInPod(pr, podRoles) {
  return hasMemberApprovalInPod(pr, podRoles) && hasLeadApprovalInPod(pr, podRoles);
}

export function getMyReviewLatestAt(pr, me) {
  const reviews = pr.reviews?.nodes || [];
  let latest = null;
  for (const review of reviews) {
    if (review.author?.login !== me) continue;
    if (!review.submittedAt) continue;
    if (!latest || review.submittedAt > latest) latest = review.submittedAt;
  }
  return latest;
}

export function getMyLatestEngagementAt(pr, me) {
  let latest = getMyReviewLatestAt(pr, me);
  // Comment-side engagement: open discussions only (resolved threads ignored).
  for (const { login, ts } of openDiscussionEvents(
    pr.reviewThreads?.nodes,
    pr.comments?.nodes,
  )) {
    if (login !== me) continue;
    if (!latest || ts > latest) latest = ts;
  }
  return latest;
}

export function latestNonMergeCommit(pr) {
  const nodes = pr.commits?.nodes || [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const commit = nodes[i]?.commit;
    if (!commit) continue;
    if ((commit.parents?.totalCount ?? 1) > 1) continue;
    return commit;
  }
  return null;
}

export function latestNonMergeCommitAt(pr) {
  return latestNonMergeCommit(pr)?.committedDate || null;
}

export function needsMyReReview(pr, me) {
  if (!me || me === pr.author?.login) return false;
  const myLatest = getMyLatestEngagementAt(pr, me);
  if (!myLatest) return false;
  const commitAt = latestNonMergeCommitAt(pr);
  if (!commitAt) return false;
  return new Date(commitAt) > new Date(myLatest);
}

export function pingTargetsForPod(pr, podRoles) {
  // Formal review state only — conversation comments must not suppress approval pings.
  function formalState(login) {
    if (login === pr.author.login) return "AUTHOR";
    return pr.reviewState.get(login) || "PENDING";
  }
  const targets = [];
  if (!hasMemberApprovalInPod(pr, podRoles)) {
    for (const member of podRoles.members) {
      const state = formalState(member);
      if (state === "DISMISSED") targets.push({ login: member, role: "member", state });
    }
    for (const member of podRoles.members) {
      const state = formalState(member);
      if (state === "PENDING") targets.push({ login: member, role: "member", state });
    }
  }
  if (!hasLeadApprovalInPod(pr, podRoles)) {
    for (const lead of podRoles.leads) {
      const state = formalState(lead);
      if (state === "DISMISSED") targets.push({ login: lead, role: "lead", state });
    }
    for (const lead of podRoles.leads) {
      const state = formalState(lead);
      if (state === "PENDING") targets.push({ login: lead, role: "lead", state });
    }
  }
  return targets;
}

function normalizeContexts(rollup) {
  const nodes = rollup?.contexts?.nodes || [];
  return nodes.map((ctx) => {
    if (ctx.__typename === "StatusContext" || (ctx.context != null && ctx.name == null)) {
      return {
        name: ctx.context,
        state: String(ctx.state || "").toUpperCase(),
      };
    }
    return {
      name: ctx.name,
      state: String(ctx.conclusion || ctx.status || "").toUpperCase(),
    };
  });
}

export function failingCheckNames(contexts) {
  const names = new Set();
  for (const ctx of contexts || []) {
    if (!ctx.name || APPROVAL_GATE_RE.test(ctx.name)) continue;
    if (FAILING_STATES.has(ctx.state)) names.add(ctx.name);
  }
  return [...names];
}

export function formatCiRed(failingNames) {
  if (!failingNames?.length) return null;
  const e2eRe = /^(?:run-tests \/ )?(android|desktop|ios)-tests \//;
  const platforms = new Set();
  const other = [];
  for (const name of failingNames) {
    const m = name.match(e2eRe);
    if (m) platforms.add(m[1]);
    else other.push(name);
  }
  const labels = [];
  if (platforms.size) {
    labels.push(`e2e tests (${[...platforms].sort().join(", ")})`);
  }
  const shown = other.slice(0, 3);
  labels.push(...shown);
  if (other.length > 3) labels.push(`(+${other.length - 3} more)`);
  if (!labels.length) return null;
  return `⚠ CI red — ${labels.join(", ")}`;
}

function fetchRollupForOid({ owner, name }, oid) {
  const query = `query($oid: GitObjectID!) {
    repository(owner: "${owner}", name: "${name}") {
      object(oid: $oid) {
        ... on Commit {
          statusCheckRollup {
            state
            contexts(first: 100) {
              nodes {
                __typename
                ... on CheckRun { name conclusion status }
                ... on StatusContext { context state }
              }
            }
          }
        }
      }
    }
  }`;
  const data = ghGraphQL(query, ".data.repository.object.statusCheckRollup", { oid });
  return data;
}

function resolveCheckContexts(pr, repoConfig) {
  const latest = pr.latestCommit?.nodes?.[0]?.commit;
  if (!latest) return [];
  if ((latest.parents?.totalCount ?? 1) <= 1) {
    return normalizeContexts(latest.statusCheckRollup);
  }
  const nonMerge = latestNonMergeCommit(pr);
  if (!nonMerge?.oid) return [];
  try {
    return normalizeContexts(fetchRollupForOid(repoConfig, nonMerge.oid));
  } catch {
    return [];
  }
}

export function assignAuthorTier(pr, allTeamSet) {
  const login = pr.author?.login;
  if (login && allTeamSet.has(login)) return "core";
  const labels = (pr.labels?.nodes || []).map((l) => l.name);
  // organization is only present when the GraphQL query requested it on User.
  // Missing field → label fallback then platform (legacy-safe).
  if (!Object.prototype.hasOwnProperty.call(pr.author || {}, "organization")) {
    return labels.includes("community-contribution") ? "external" : "platform";
  }
  if (pr.author.organization == null) return "external";
  return "platform";
}

function fetchPRPage(
  { owner, name },
  cursor,
  { includeAuthorTiers = false, includeCiChecks = false } = {},
) {
  const authorFields = includeAuthorTiers
    ? `author { login ... on User { name organization(login: "${owner}") { login } } }`
    : `author { login ... on User { name } }`;
  const labelFields = includeAuthorTiers
    ? `labels(first: 20) { nodes { name } }`
    : "";
  // CI check contexts are heavy (and flaky at scale for pods with many
  // extraRepos). Only request them when the caller needs CI-red signals.
  const latestCommitFields = includeCiChecks
    ? `latestCommit: commits(last: 1) {
            nodes {
              commit {
                oid
                parents { totalCount }
                statusCheckRollup {
                  state
                  contexts(first: 100) {
                    nodes {
                      __typename
                      ... on CheckRun { name conclusion status }
                      ... on StatusContext { context state }
                    }
                  }
                }
              }
            }
          }`
    : "";
  const query = `query${cursor ? "($cursor: String!)" : ""} {
    repository(owner: "${owner}", name: "${name}") {
      pullRequests(states: OPEN, first: ${PR_PAGE_SIZE}${cursor ? ", after: $cursor" : ""}, orderBy: {field: CREATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number title url createdAt isDraft mergeable
          ${authorFields}
          ${labelFields}
          files(first: 100) { nodes { path } }
          reviews(first: 100) {
            nodes { state submittedAt author { login } }
          }
          comments(first: 100) {
            nodes { createdAt author { login } }
          }
          reviewThreads(first: 100) {
            nodes {
              isResolved
              comments(first: 50) {
                nodes { createdAt author { login } }
              }
            }
          }
          commits(last: 20) {
            nodes {
              commit {
                oid
                committedDate
                parents { totalCount }
              }
            }
          }
          ${latestCommitFields}
          timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT], last: 1) {
            nodes { ... on ReadyForReviewEvent { createdAt } }
          }
        }
      }
    }
  }`;
  return ghGraphQL(
    query,
    ".data.repository.pullRequests",
    cursor ? { cursor } : {},
  );
}

export function fetchOpenPRs(
  repoConfig,
  { includeAuthorTiers = false, includeCiChecks = false } = {},
) {
  const allPRs = [];
  let cursor = null;
  let pageNum = 0;
  while (true) {
    const page = fetchPRPage(repoConfig, cursor, { includeAuthorTiers, includeCiChecks });
    if (!page) break;
    allPRs.push(...page.nodes);
    pageNum++;
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return { allPRs, pageNum };
}

const ORG_REPO_LIST_LIMIT = 1000;

function listOrgRepos(owner) {
  const raw = gh([
    "repo",
    "list",
    owner,
    "--no-archived",
    "--limit",
    String(ORG_REPO_LIST_LIMIT),
    "--json",
    "name",
  ]);
  const parsed = raw ? JSON.parse(raw) : [];
  const names = parsed.map((entry) => entry.name);
  // gh caps the response at --limit with no cursor we can follow here, so a
  // full page means the org has at least that many repos and a glob may have
  // silently missed some. Surface it instead of resolving an incomplete set.
  return { names, truncated: names.length >= ORG_REPO_LIST_LIMIT };
}

// Resolve an `extraRepos` spec list into concrete `owner/name` strings.
// Plain `owner/name` entries pass through unchanged. Entries whose name
// segment contains `*` are treated as globs and resolved against the org's
// non-archived repos via `gh repo list` (each org listed at most once).
// Returns { repos, warnings } — warnings are emitted for malformed entries
// or orgs that cannot be listed, so the caller can surface them on stderr.
export function resolveExtraRepos(specs) {
  const resolved = new Set();
  const warnings = [];
  const orgCache = new Map();
  for (const spec of specs) {
    // Require exactly two non-empty segments. Splitting with a limit of 2 would
    // silently truncate "owner/group/name" to "owner/group"; reject it instead.
    const parts = typeof spec === "string" ? spec.split("/") : [];
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      warnings.push(`Ignoring extraRepos entry "${spec}" (must be owner/name).`);
      continue;
    }
    const [owner, name] = parts;
    if (!name.includes("*")) {
      resolved.add(`${owner}/${name}`);
      continue;
    }
    if (!orgCache.has(owner)) {
      try {
        const { names, truncated } = listOrgRepos(owner);
        orgCache.set(owner, names);
        if (truncated) {
          warnings.push(
            `Repo list for "${owner}" hit the ${ORG_REPO_LIST_LIMIT}-repo cap; some glob matches may be missing.`,
          );
        }
      } catch (e) {
        warnings.push(`Could not list repos for "${owner}": ${ghErrorReason(e)}`);
        orgCache.set(owner, []);
      }
    }
    const pattern = name
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    const re = new RegExp(`^${pattern}$`);
    for (const repoName of orgCache.get(owner)) {
      if (re.test(repoName)) resolved.add(`${owner}/${repoName}`);
    }
  }
  return { repos: [...resolved], warnings };
}

function loadPods(mode, pod) {
  return mode === "my"
    ? (pod ? [loadTeam(pod)] : discoverPods())
    : [loadTeam(pod)];
}

function touchesOwnedPaths(files, ownedPaths) {
  return files.some((file) => ownedPaths.some((path) => file.path.startsWith(path)));
}

export function collectPRActivity({
  mode = "team",
  pod = null,
  authorScope = "any",
  authorTiers = false,
} = {}) {
  if (!["any", "pod", "union"].includes(authorScope)) {
    throw new Error(`Invalid authorScope: ${authorScope}. Use "any", "pod", or "union".`);
  }
  const config = loadConfig();
  const repoConfig = splitRepo(config.github.repo);
  const staleDays = config.github.staleDays || 3;
  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const currentUser = gh(["api", "user", "--jq", ".login"]);
  const pods = loadPods(mode, pod);
  if (pods.length === 0) throw new Error("No pods discovered under .github/teams/.");
  const ownedPaths = [...new Set(pods.flatMap((p) => p.ownedPaths))];
  const globalPodRoles =
    pods.length === 1 ? rolesForPod(pods[0], currentUser) : null;
  const roles = globalPodRoles || {
    currentUser,
    currentUserRole: "member",
    leads: [],
    members: [],
    allTeam: [],
  };
  // authorScope === "pod" filters relevantPRs to pod-roster authors only.
  // PRs that touch pod paths but were authored outside the roster are surfaced
  // separately as excludedPRs so the skill can still display them for context.
  // authorScope === "union" includes path hits OR roster-authored PRs.
  // Only applied to mode === "team"; "my" already filters by currentUser, and
  // "review" intentionally surfaces cross-pod authors whose review is owed.
  const teamModeScope = mode === "team";
  const enforceAuthorScope = authorScope === "pod" && teamModeScope;
  const useAuthorUnion = authorScope === "union" && teamModeScope;
  const rosterLogins = (enforceAuthorScope || useAuthorUnion)
    ? new Set(pods.flatMap((p) => [...p.leads, ...p.members]))
    : null;

  // extraRepos are honored only in team mode. There the pod is treated as the
  // sole owner of each extra repo, so every open PR is in scope regardless of
  // touched paths. review/my modes stay on the primary repo only.
  const extraRepoSpecs =
    mode === "team"
      ? [...new Set(pods.flatMap((p) => p.extraRepos || []))]
      : [];
  const { repos: extraRepoList, warnings: repoWarnings } = resolveExtraRepos(extraRepoSpecs);
  for (const warning of repoWarnings) console.error(warning);

  const repoTargets = [{ ...repoConfig, soleOwner: false, isPrimary: true }];
  for (const full of extraRepoList) {
    if (full === repoConfig.repo) continue;
    const { owner, name, repo } = splitRepo(full);
    repoTargets.push({ owner, name, repo, soleOwner: true, isPrimary: false });
  }

  const allPRs = [];
  const scannedRepos = [];
  let pageNum = 0;
  const includeAuthorTiers = Boolean(authorTiers) && mode === "team";
  // CI-red is a team-dashboard signal only — skip the heavy check-rollup
  // payload for --mode my / review (and keep devops multi-repo scans lighter).
  const includeCiChecks = mode === "team";
  for (const target of repoTargets) {
    try {
      const { allPRs: prs, pageNum: pages } = fetchOpenPRs(target, {
        includeAuthorTiers,
        includeCiChecks,
      });
      pageNum += pages;
      for (const pr of prs) {
        pr.repo = target.repo;
        pr.isPrimaryRepo = target.isPrimary;
        pr.soleOwner = target.soleOwner;
        pr._repoConfig = { owner: target.owner, name: target.name };
      }
      allPRs.push(...prs);
      scannedRepos.push(target.repo);
    } catch (e) {
      console.error(`Skipping ${target.repo}: ${ghErrorReason(e)}`);
    }
  }

  const isCrossPodMy = mode === "my" && pod === null;
  const relevantPRs = [];
  const excludedPRs = [];
  const allTeamSet = new Set(roles.allTeam);

  for (const pr of allPRs) {
    if (pr.isDraft) continue;
    if (!pr.author?.login) continue;
    if (mode === "my" && pr.author.login !== currentUser) continue;
    const files = pr.files?.nodes || [];
    const pathHit = pr.soleOwner || touchesOwnedPaths(files, ownedPaths);
    const authorOnRoster = rosterLogins ? rosterLogins.has(pr.author.login) : false;

    if (!isCrossPodMy) {
      if (useAuthorUnion) {
        if (!pathHit && !authorOnRoster) continue;
      } else if (!pathHit) {
        continue;
      }
    }

    const reviews = pr.reviews?.nodes || [];
    const comments = pr.comments?.nodes || [];
    const reviewThreads = pr.reviewThreads?.nodes || [];
    const reviewState = getReviewState(reviews);
    const displayReviewState = getDisplayReviewState(
      reviews,
      comments,
      pr.author.login,
      reviewThreads,
    );
    const ready = readySince(pr);
    const prRef = pr.isPrimaryRepo === false ? `${pr.repo}#${pr.number}` : `#${pr.number}`;
    const checkContexts = includeCiChecks
      ? resolveCheckContexts(pr, pr._repoConfig || repoConfig)
      : [];
    const failingChecks = failingCheckNames(checkContexts);
    const ciRed = formatCiRed(failingChecks);
    const enriched = {
      ...pr,
      files,
      comments: { nodes: comments },
      reviewThreads: { nodes: reviewThreads },
      reviewState,
      displayReviewState,
      ready,
      stale: now - new Date(ready).getTime() > staleMs,
      repo: pr.repo,
      prRef,
      failingChecks,
      ciRed,
    };
    if (includeAuthorTiers) {
      enriched.authorTier = assignAuthorTier(enriched, allTeamSet);
    }
    if (enforceAuthorScope && !rosterLogins.has(pr.author.login)) {
      excludedPRs.push(enriched);
      continue;
    }
    relevantPRs.push(enriched);
  }
  relevantPRs.sort((a, b) => new Date(a.ready).getTime() - new Date(b.ready).getTime());
  excludedPRs.sort((a, b) => new Date(a.ready).getTime() - new Date(b.ready).getTime());

  return {
    config,
    repo: repoConfig.repo,
    repos: scannedRepos,
    staleDays,
    currentUser,
    pods,
    roles,
    allPRs,
    relevantPRs,
    excludedPRs,
    authorScope,
    authorTiers: includeAuthorTiers,
    pageNum,
    isCrossPodMy,
  };
}

export function classifyTeamPRs(state) {
  const me = state.roles.currentUser;
  const approvedPRs = state.relevantPRs.filter((pr) =>
    isFullyApprovedInPod(pr, state.roles),
  );
  const needsAction = state.relevantPRs.filter(
    (pr) => !isFullyApprovedInPod(pr, state.roles),
  );
  const reReviewPRs = needsAction.filter((pr) => needsMyReReview(pr, me));
  // Key on the repo-qualified prRef, not the bare number: PR numbers are not
  // unique once the dashboard spans multiple repos (extraRepos), so a bare
  // number would let a re-review PR mask a same-numbered stale/active PR in a
  // different repo and silently drop it from every section.
  const reReviewSet = new Set(reReviewPRs.map((pr) => pr.prRef ?? `#${pr.number}`));
  const stalePRs = needsAction.filter(
    (pr) => pr.stale && !reReviewSet.has(pr.prRef ?? `#${pr.number}`),
  );
  const activePRs = needsAction.filter(
    (pr) => !pr.stale && !reReviewSet.has(pr.prRef ?? `#${pr.number}`),
  );
  const conflictCount = state.relevantPRs.filter(
    (pr) => pr.mergeable === "CONFLICTING",
  ).length;
  return {
    needsAction,
    reReviewPRs,
    stalePRs,
    activePRs,
    approvedPRs,
    skipped: approvedPRs.length,
    conflictCount,
  };
}

export const AUTHOR_TIER_ORDER = ["core", "platform", "external"];

export function groupTeamPRsByTier(groups) {
  function empty() {
    return { reReviewPRs: [], stalePRs: [], activePRs: [], approvedPRs: [] };
  }
  const tiers = {
    core: empty(),
    platform: empty(),
    external: empty(),
  };
  function place(pr, key) {
    const tier = AUTHOR_TIER_ORDER.includes(pr.authorTier) ? pr.authorTier : "platform";
    tiers[tier][key].push(pr);
  }
  for (const pr of groups.reReviewPRs) place(pr, "reReviewPRs");
  for (const pr of groups.stalePRs) place(pr, "stalePRs");
  for (const pr of groups.activePRs) place(pr, "activePRs");
  for (const pr of groups.approvedPRs) place(pr, "approvedPRs");
  return tiers;
}

export function classifyReviewPRs(state) {
  const me = state.roles.currentUser;
  const myRole = state.roles.currentUserRole;
  const candidates = state.relevantPRs.filter((pr) => {
    if (pr.author.login === me) return false;
    // Approval-gate view: only formal APPROVED dismisses the queue.
    if (pr.reviewState.get(me) === "APPROVED") return false;
    return true;
  });
  const dismissed = [];
  const needed = [];
  for (const pr of candidates) {
    const myState = memberState(pr, me);
    if (myState === "DISMISSED") {
      dismissed.push(pr);
      continue;
    }
    if (myRole === "lead") {
      if (!hasLeadApprovalInPod(pr, state.roles)) needed.push(pr);
    } else if (!hasMemberApprovalInPod(pr, state.roles)) {
      needed.push(pr);
    }
  }
  return { dismissed, needed };
}

export function classifyMyPRs(state) {
  const me = state.roles.currentUser;
  const myPRs = state.relevantPRs.filter((pr) => pr.author.login === me);
  const homePods = state.pods.filter(
    (team) => team.leads.includes(me) || team.members.includes(me),
  );
  const homePod = homePods[0] ?? null;
  const roleCache = new Map();
  const rolesFor = (team) => {
    if (!team) return null;
    if (!roleCache.has(team.pod)) roleCache.set(team.pod, rolesForPod(team, me));
    return roleCache.get(team.pod);
  };
  const groups = {
    readyToMerge: [],
    needsReReview: [],
    awaitingReview: [],
    noPod: [],
  };
  for (const pr of myPRs) {
    const pathPod = findPodForFiles(pr.files, state.pods);
    const resolvedPod = pathPod ?? homePod;
    const podRoles = rolesFor(resolvedPod);
    const podSource = pathPod ? "path" : pathPod === null && homePod ? "home" : null;
    const entry = { pr, pod: resolvedPod, podRoles, podSource };
    if (!podRoles) {
      groups.noPod.push(entry);
      continue;
    }
    if (isFullyApprovedInPod(pr, podRoles)) {
      groups.readyToMerge.push(entry);
      continue;
    }
    const targets = pingTargetsForPod(pr, podRoles);
    const enriched = { ...entry, targets };
    if (targets.some((target) => target.state === "DISMISSED")) {
      groups.needsReReview.push(enriched);
    } else {
      groups.awaitingReview.push(enriched);
    }
  }
  return { myPRs, ...groups };
}

export function toJsonablePR(pr) {
  return {
    number: pr.number,
    repo: pr.repo,
    prRef: pr.prRef,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    ready: pr.ready,
    stale: pr.stale,
    mergeable: pr.mergeable,
    files: pr.files,
    authorTier: pr.authorTier || null,
    reviews: [...(pr.displayReviewState || pr.reviewState).entries()].map(
      ([login, state]) => ({ login, state }),
    ),
    failingChecks: pr.failingChecks || [],
    ciRed: pr.ciRed || null,
  };
}
