import { execFileSync } from "node:child_process";

import { loadConfig, splitRepo } from "../developer-workflow/config.mjs";
import { loadTeam, discoverPods, findPodForFiles } from "./team.mjs";

export const STATE_ICONS = {
  APPROVED: "✅",
  CHANGES_REQUESTED: "❌",
  COMMENTED: "💬",
  DISMISSED: "🔄",
};

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

export function rolesForPod(team, currentUser = null) {
  const leadSet = new Set(team.leads);
  const memberLogins = team.members.filter((login) => !leadSet.has(login));
  const allTeam = [...new Set([...team.leads, ...memberLogins])];
  const currentUserRole =
    currentUser && team.leads.includes(currentUser) ? "lead" : "member";
  return { currentUser, currentUserRole, leads: team.leads, members: memberLogins, allTeam };
}

export function getReviewState(reviews) {
  const latest = new Map();
  for (const review of reviews) {
    const login = review.author?.login;
    if (!login) continue;
    if (review.state === "COMMENTED" && latest.has(login)) continue;
    latest.set(login, review.state);
  }
  return latest;
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
  return pr.reviewState.get(member) || "PENDING";
}

export function hasMemberApprovalInPod(pr, podRoles) {
  return podRoles.members.some((member) => memberState(pr, member) === "APPROVED");
}

export function hasLeadApprovalInPod(pr, podRoles) {
  return podRoles.leads.some((member) => memberState(pr, member) === "APPROVED");
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

export function latestNonMergeCommitAt(pr) {
  const nodes = pr.commits?.nodes || [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const commit = nodes[i]?.commit;
    if (!commit) continue;
    if ((commit.parents?.totalCount ?? 1) > 1) continue;
    if (commit.committedDate) return commit.committedDate;
  }
  return null;
}

export function needsMyReReview(pr, me) {
  const myLatest = getMyReviewLatestAt(pr, me);
  if (!myLatest) return false;
  const commitAt = latestNonMergeCommitAt(pr);
  if (!commitAt) return false;
  return new Date(commitAt) > new Date(myLatest);
}

export function pingTargetsForPod(pr, podRoles) {
  const targets = [];
  if (!hasMemberApprovalInPod(pr, podRoles)) {
    for (const member of podRoles.members) {
      const state = memberState(pr, member);
      if (state === "DISMISSED") targets.push({ login: member, role: "member", state });
    }
    for (const member of podRoles.members) {
      const state = memberState(pr, member);
      if (state === "PENDING") targets.push({ login: member, role: "member", state });
    }
  }
  if (!hasLeadApprovalInPod(pr, podRoles)) {
    for (const lead of podRoles.leads) {
      const state = memberState(pr, lead);
      if (state === "DISMISSED") targets.push({ login: lead, role: "lead", state });
    }
    for (const lead of podRoles.leads) {
      const state = memberState(pr, lead);
      if (state === "PENDING") targets.push({ login: lead, role: "lead", state });
    }
  }
  return targets;
}

function fetchPRPage({ owner, name }, cursor) {
  const query = `query${cursor ? "($cursor: String!)" : ""} {
    repository(owner: "${owner}", name: "${name}") {
      pullRequests(states: OPEN, first: 50${cursor ? ", after: $cursor" : ""}, orderBy: {field: CREATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number title url createdAt isDraft mergeable
          author { login ... on User { name } }
          files(first: 100) { nodes { path } }
          reviews(first: 100) {
            nodes { state submittedAt author { login } }
          }
          commits(last: 20) {
            nodes { commit { committedDate parents { totalCount } } }
          }
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

export function fetchOpenPRs(repoConfig) {
  const allPRs = [];
  let cursor = null;
  let pageNum = 0;
  while (true) {
    const page = fetchPRPage(repoConfig, cursor);
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

export function collectPRActivity({ mode = "team", pod = null, authorScope = "any" } = {}) {
  if (!["any", "pod"].includes(authorScope)) {
    throw new Error(`Invalid authorScope: ${authorScope}. Use "any" or "pod".`);
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
  // Only applied to mode === "team"; "my" already filters by currentUser, and
  // "review" intentionally surfaces cross-pod authors whose review is owed.
  const enforceAuthorScope = authorScope === "pod" && mode === "team";
  const rosterLogins = enforceAuthorScope
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
  for (const target of repoTargets) {
    try {
      const { allPRs: prs, pageNum: pages } = fetchOpenPRs(target);
      pageNum += pages;
      for (const pr of prs) {
        pr.repo = target.repo;
        pr.isPrimaryRepo = target.isPrimary;
        pr.soleOwner = target.soleOwner;
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

  for (const pr of allPRs) {
    if (pr.isDraft) continue;
    if (!pr.author?.login) continue;
    if (mode === "my" && pr.author.login !== currentUser) continue;
    const files = pr.files?.nodes || [];
    if (!isCrossPodMy && !pr.soleOwner && !touchesOwnedPaths(files, ownedPaths)) continue;
    const reviews = pr.reviews?.nodes || [];
    const reviewState = getReviewState(reviews);
    const ready = readySince(pr);
    const prRef = pr.isPrimaryRepo === false ? `${pr.repo}#${pr.number}` : `#${pr.number}`;
    const enriched = {
      ...pr,
      files,
      reviewState,
      ready,
      stale: now - new Date(ready).getTime() > staleMs,
      repo: pr.repo,
      prRef,
    };
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
    pageNum,
    isCrossPodMy,
  };
}

export function classifyTeamPRs(state) {
  const me = state.roles.currentUser;
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
  const conflictCount = needsAction.filter(
    (pr) => pr.mergeable === "CONFLICTING",
  ).length;
  return {
    needsAction,
    reReviewPRs,
    stalePRs,
    activePRs,
    skipped: state.relevantPRs.length - needsAction.length,
    conflictCount,
  };
}

export function classifyReviewPRs(state) {
  const me = state.roles.currentUser;
  const myRole = state.roles.currentUserRole;
  const candidates = state.relevantPRs.filter((pr) => {
    if (pr.author.login === me) return false;
    const myState = memberState(pr, me);
    if (myState === "APPROVED") return false;
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
    reviews: [...pr.reviewState.entries()].map(([login, state]) => ({ login, state })),
  };
}
