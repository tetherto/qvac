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
  return execFileSync("gh", args, {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
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
    let page;
    try {
      page = fetchPRPage(repoConfig, cursor);
    } catch (err) {
      // Best-effort across many repos: 404/permission errors should skip this
      // repo with a warning rather than abort the whole dashboard. The repo
      // string is included so the user can spot what was missed.
      console.error(
        `Warning: failed to fetch PRs from ${repoConfig.repo}: ${err.message?.split("\n")[0] || err}`,
      );
      break;
    }
    if (!page) break;
    allPRs.push(...page.nodes);
    pageNum++;
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return { allPRs, pageNum };
}

// Cache the per-org repo listing across calls so a single dashboard run only
// hits `gh repo list` once per org, even when several pods declare extraRepos
// in the same org.
const orgRepoCache = new Map();

function listOrgRepos(owner) {
  if (orgRepoCache.has(owner)) return orgRepoCache.get(owner);
  let names = [];
  try {
    const raw = gh([
      "repo",
      "list",
      owner,
      "--limit",
      "500",
      "--json",
      "name,isArchived",
    ]);
    const parsed = raw ? JSON.parse(raw) : [];
    names = parsed.filter((r) => !r.isArchived).map((r) => r.name);
  } catch (err) {
    console.error(
      `Warning: failed to enumerate ${owner} repos for extraRepos glob match: ${err.message?.split("\n")[0] || err}`,
    );
  }
  orgRepoCache.set(owner, names);
  return names;
}

function globToRegex(glob) {
  // Conservative: only `*` is treated as a wildcard. Everything else is
  // escaped, including `?` and `[`. Anchored.
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

// Resolve extraRepos entries to a deduped list of "owner/name" strings.
// - `{repo: "owner/name"}` entries are passed through unchanged.
// - `{match: "owner/name-glob"}` entries enumerate `gh repo list <owner>` and
//   filter by the glob. Archived repos are excluded.
// Primary repo is filtered out so it is never counted twice.
export function resolveExtraRepos(extraRepos, primaryRepo = null) {
  const seen = new Set();
  const out = [];
  for (const entry of extraRepos || []) {
    if (entry.repo) {
      if (entry.repo === primaryRepo) continue;
      if (seen.has(entry.repo)) continue;
      seen.add(entry.repo);
      out.push(entry.repo);
      continue;
    }
    if (entry.match) {
      const [owner, namePattern] = entry.match.split("/", 2);
      const regex = globToRegex(namePattern);
      for (const name of listOrgRepos(owner)) {
        const full = `${owner}/${name}`;
        if (!regex.test(name)) continue;
        if (full === primaryRepo) continue;
        if (seen.has(full)) continue;
        seen.add(full);
        out.push(full);
      }
    }
  }
  return out;
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
  const primaryRepo = repoConfig.repo;
  const staleDays = config.github.staleDays || 3;
  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const currentUser = gh(["api", "user", "--jq", ".login"]);
  const pods = loadPods(mode, pod);
  if (pods.length === 0) throw new Error("No pods discovered under .github/teams/.");
  const ownedPaths = [...new Set(pods.flatMap((p) => p.ownedPaths))];
  // Extra repos broaden the dashboard beyond the configured monorepo. They are
  // only honored in --mode team today (the only mode wired through a
  // multi-repo workflow); --mode my and --mode review keep their single-repo
  // behavior so existing skills don't change semantics.
  const useExtraRepos = mode === "team";
  const extraRepoSpecs = useExtraRepos
    ? [...new Set(pods.flatMap((p) => p.extraRepos || []).map(JSON.stringify))].map(
        (s) => JSON.parse(s),
      )
    : [];
  const extraRepos = useExtraRepos ? resolveExtraRepos(extraRepoSpecs, primaryRepo) : [];
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

  // Fetch primary repo + each extra repo. For extra repos we tag each PR with
  // its source so downstream code knows to skip the ownedPaths filter and to
  // render the repo prefix in the dashboard.
  const fetchResults = [];
  {
    const { allPRs: primaryAll, pageNum: primaryPages } = fetchOpenPRs(repoConfig);
    fetchResults.push({
      repo: primaryRepo,
      isExtra: false,
      allPRs: primaryAll,
      pageNum: primaryPages,
    });
  }
  for (const fullRepo of extraRepos) {
    const cfg = splitRepo(fullRepo);
    const { allPRs: extraAll, pageNum: extraPages } = fetchOpenPRs(cfg);
    fetchResults.push({
      repo: fullRepo,
      isExtra: true,
      allPRs: extraAll,
      pageNum: extraPages,
    });
  }
  const allPRs = fetchResults.flatMap((r) =>
    r.allPRs.map((pr) => ({ ...pr, sourceRepo: r.repo, sourceIsExtra: r.isExtra })),
  );
  const pageNum = fetchResults.reduce((sum, r) => sum + r.pageNum, 0);
  const isCrossPodMy = mode === "my" && pod === null;
  const relevantPRs = [];
  const excludedPRs = [];

  for (const pr of allPRs) {
    if (pr.isDraft) continue;
    if (!pr.author?.login) continue;
    if (mode === "my" && pr.author.login !== currentUser) continue;
    const files = pr.files?.nodes || [];
    // ownedPaths only constrain the primary monorepo. Extra repos are owned
    // in full by the pod, so every PR there is in-scope regardless of paths.
    const requiresOwnedPaths = !isCrossPodMy && !pr.sourceIsExtra;
    if (requiresOwnedPaths && !touchesOwnedPaths(files, ownedPaths)) continue;
    const reviews = pr.reviews?.nodes || [];
    const reviewState = getReviewState(reviews);
    const ready = readySince(pr);
    const enriched = {
      ...pr,
      files,
      reviewState,
      ready,
      stale: now - new Date(ready).getTime() > staleMs,
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
    repo: primaryRepo,
    primaryRepo,
    extraRepos,
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
  const reReviewSet = new Set(reReviewPRs.map((pr) => pr.number));
  const stalePRs = needsAction.filter(
    (pr) => pr.stale && !reReviewSet.has(pr.number),
  );
  const activePRs = needsAction.filter(
    (pr) => !pr.stale && !reReviewSet.has(pr.number),
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
    title: pr.title,
    url: pr.url,
    repo: pr.sourceRepo || null,
    isExtraRepo: Boolean(pr.sourceIsExtra),
    author: pr.author,
    ready: pr.ready,
    stale: pr.stale,
    mergeable: pr.mergeable,
    files: pr.files,
    reviews: [...pr.reviewState.entries()].map(([login, state]) => ({ login, state })),
  };
}
