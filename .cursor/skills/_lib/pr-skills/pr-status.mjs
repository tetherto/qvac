#!/usr/bin/env node
//
// PR status / review-queue / my-PRs dashboard for tetherto/qvac.
//
// Usage:
//   node .../pr-status.mjs --pod <pod> --mode team       # pod-scoped dashboard
//   node .../pr-status.mjs --pod <pod> --mode review     # pod-scoped review queue
//   node .../pr-status.mjs --mode my                     # cross-pod my PRs
//
// `team` and `review` modes are pod-scoped: they require `--pod <name>` and
// load `.github/teams/<pod>.json`. `my` mode is cross-pod: it discovers
// every pod under `.github/teams/`, finds which pod owns each of the
// caller's PRs by file paths, and uses that pod's team for the per-PR
// ping/approval logic.
//
// Slack handles for `--mode my` are loaded from
// ~/.config/qvac-pr-skills/slack.json (see slack.mjs).

import { execFileSync } from "node:child_process";

import { loadTeam, discoverPods, findPodForFiles } from "./team.mjs";
import { loadSlackMap, bootstrapMissing, saveSlackMap } from "./slack.mjs";

// --- Constants ---

const REPO_OWNER = "tetherto";
const REPO_NAME = "qvac";
const REPO = `${REPO_OWNER}/${REPO_NAME}`;
const STALE_DAYS = 3;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;
const NOW = Date.now();

const STATE_ICONS = {
  APPROVED: "✅",
  CHANGES_REQUESTED: "❌",
  COMMENTED: "💬",
  DISMISSED: "🔄",
};

// --- CLI arg parsing ---

function readArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

const mode = (function () {
  const val = readArg("--mode") ?? "team";
  if (!["team", "review", "my"].includes(val)) {
    console.error(`Unknown mode: ${val}. Use --mode team|review|my`);
    process.exit(1);
  }
  return val;
})();

const pod = (function () {
  const val = readArg("--pod");
  if (mode === "my") return val ?? null; // optional in cross-pod mode
  if (!val) {
    console.error(`--pod <name> is required for --mode ${mode}`);
    process.exit(1);
  }
  return val;
})();

// --- Shell helpers ---

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function ghGraphQL(query, jq, vars = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    args.push("-F", `${k}=${v}`);
  }
  if (jq) args.push("--jq", jq);
  const raw = gh(args);
  return raw ? JSON.parse(raw) : null;
}

// --- Team / role detection ---

// Compute the leads/members/allTeam shape for a single pod, with overlap
// resolution (a person who is both lead and member counts as lead only).
function rolesForPod(team) {
  const leadSet = new Set(team.leads);
  const memberLogins = team.members.filter((l) => !leadSet.has(l));
  const allTeam = [...new Set([...team.leads, ...memberLogins])];
  return { leads: team.leads, members: memberLogins, allTeam };
}

const currentUser = gh(["api", "user", "--jq", ".login"]);

// `pods` is the set of pods this run cares about. Pod-scoped modes have
// exactly one entry; cross-pod `my` mode has every pod.
const pods =
  mode === "my"
    ? (pod ? [loadTeam(pod)] : discoverPods())
    : [loadTeam(pod)];

if (pods.length === 0) {
  console.error("No pods discovered under .github/teams/.");
  process.exit(1);
}

const OWNED_PATHS = [...new Set(pods.flatMap((p) => p.ownedPaths))];

if (pods.length === 1) {
  console.error(`Loading ${pods[0].pod} team roster...`);
} else {
  console.error(
    `Loading ${pods.length} pod rosters: ${pods.map((p) => p.pod).join(", ")}`,
  );
}

// Pod-scoped modes use a single global `roles` (the only pod). Cross-pod
// `my` mode resolves roles per-PR; `roles` stays defined for the single-
// pod case so existing helpers (hasMemberApproval, etc.) keep working.
const globalPodRoles = pods.length === 1 ? rolesForPod(pods[0]) : null;
const currentUserRole =
  globalPodRoles && globalPodRoles.leads.includes(currentUser)
    ? "lead"
    : "member";
const roles = globalPodRoles
  ? { currentUser, currentUserRole, ...globalPodRoles }
  : { currentUser, currentUserRole, leads: [], members: [], allTeam: [] };

// --- Slack handle map (only consulted in --mode my) ---

let slackState = { map: {}, pendingReview: [] };

if (mode === "my") {
  const { state } = loadSlackMap();
  // Union of every discovered pod's leads + members. In cross-pod `my`
  // a single user's PRs may need pings to anyone in any pod.
  const allLogins = [
    ...new Set(pods.flatMap((p) => [...p.leads, ...p.members])),
  ];
  const { state: bootstrapped, addedLogins } = bootstrapMissing(state, allLogins);
  slackState = bootstrapped;
  if (addedLogins.length > 0) {
    saveSlackMap(slackState);
  }
  if (slackState.pendingReview.length > 0) {
    // Marker consumed by the skill workflow to drive the validation flow.
    // No PII or examples in the marker line by design.
    console.error(`SLACK_VALIDATION_REQUIRED ${slackState.pendingReview.length}`);
  }
}

function slackHandle(login) {
  return slackState.map[login] || `@${login}`;
}

// --- Data helpers ---

function touchesOwnedPaths(files) {
  return files.some((f) => OWNED_PATHS.some((p) => f.path.startsWith(p)));
}

function getReviewState(reviews) {
  const latest = new Map();
  for (const r of reviews) {
    const login = r.author?.login;
    if (!login) continue;
    if (r.state === "COMMENTED" && latest.has(login)) continue;
    latest.set(login, r.state);
  }
  return latest;
}

function readySince(pr) {
  const event = pr.timelineItems?.nodes?.[0];
  return event?.createdAt || pr.createdAt;
}

function formatAge(ts) {
  const diffMs = NOW - new Date(ts).getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor(
    (diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
  );
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h`;
}

function isStale(ts) {
  return NOW - new Date(ts).getTime() > STALE_MS;
}

function memberState(pr, member) {
  if (member === pr.author.login) return "AUTHOR";
  return pr.reviewState.get(member) || "PENDING";
}

function hasMemberApproval(pr) {
  return roles.members.some((m) => memberState(pr, m) === "APPROVED");
}

function hasLeadApproval(pr) {
  return roles.leads.some((m) => memberState(pr, m) === "APPROVED");
}

function isFullyApproved(pr) {
  return hasMemberApproval(pr) && hasLeadApproval(pr);
}

// Latest submittedAt across non-pending reviews by `me`. Returns null if I
// have not reviewed this PR.
function getMyReviewLatestAt(pr, me) {
  const reviews = pr.reviews?.nodes || [];
  let latest = null;
  for (const r of reviews) {
    if (r.author?.login !== me) continue;
    if (!r.submittedAt) continue;
    if (!latest || r.submittedAt > latest) latest = r.submittedAt;
  }
  return latest;
}

// Latest non-merge commit's committedDate. Merge commits (parents > 1) are
// skipped so that base-branch syncs don't count as "the author pushed
// updates". Returns null if no qualifying commit is found.
function latestNonMergeCommitAt(pr) {
  const nodes = pr.commits?.nodes || [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const c = nodes[i]?.commit;
    if (!c) continue;
    if ((c.parents?.totalCount ?? 1) > 1) continue;
    if (c.committedDate) return c.committedDate;
  }
  return null;
}

// True iff I've reviewed this PR and the author has pushed a non-merge
// commit since my latest review.
function needsMyReReview(pr, me) {
  const myLatest = getMyReviewLatestAt(pr, me);
  if (!myLatest) return false;
  const commitAt = latestNonMergeCommitAt(pr);
  if (!commitAt) return false;
  return new Date(commitAt) > new Date(myLatest);
}

// --- Fetch all open PRs ---

console.error(`Fetching open PRs from ${REPO}...`);

function fetchPRPage(cursor) {
  const query = `query${cursor ? "($cursor: String!)" : ""} {
    repository(owner: "${REPO_OWNER}", name: "${REPO_NAME}") {
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
    cursor ? { cursor } : {}
  );
}

const allPRs = [];
let cursor = null;
let pageNum = 0;

while (true) {
  const page = fetchPRPage(cursor);
  if (!page) break;
  allPRs.push(...page.nodes);
  pageNum++;
  if (!page.pageInfo.hasNextPage) break;
  cursor = page.pageInfo.endCursor;
}

console.error(`Fetched ${allPRs.length} open PRs in ${pageNum} request(s)\n`);

// --- Filter to relevant PRs ---
//
// `team` and `review` modes are pod-scoped: only PRs touching the pod's
// ownedPaths are relevant.
//
// Cross-pod `my` mode (pods.length > 1, OR --pod omitted) shows EVERY
// open PR by the current user, regardless of whether the PR touches any
// pod's ownedPaths. Otherwise PRs that the user opens against
// repo-tooling paths (.cursor/skills/, .github/, docs/, …) silently
// disappear, which defeats the point of "my PRs".
//
// Pod-scoped my mode (--mode my --pod <name>, single pod selected
// explicitly) keeps the path filter so it matches the historical
// `/<pod>-pr-my` semantic.

const isCrossPodMy = mode === "my" && pod === null;
const relevantPRs = [];

for (const pr of allPRs) {
  if (pr.isDraft) continue;
  // Skip PRs whose author has been deleted (ghost user) -- the script's
  // self-author and ping logic both require pr.author.login.
  if (!pr.author?.login) continue;

  // In `my` mode, narrow to the caller's PRs as early as possible.
  if (mode === "my" && pr.author.login !== currentUser) continue;

  const files = pr.files?.nodes || [];

  // Skip the path filter only in cross-pod my mode.
  if (!isCrossPodMy && !touchesOwnedPaths(files)) continue;

  const reviews = pr.reviews?.nodes || [];
  const reviewState = getReviewState(reviews);
  const ready = readySince(pr);

  relevantPRs.push({
    ...pr,
    files,
    reviewState,
    ready,
    stale: isStale(ready),
  });
}

relevantPRs.sort(
  (a, b) => new Date(a.ready).getTime() - new Date(b.ready).getTime()
);

// --- Rendering helpers ---

function renderPRLine(pr, { showNeeds = true, extra = null } = {}) {
  const age = formatAge(pr.ready);
  const author = pr.author.name || pr.author.login;

  const lines = [];
  lines.push(`#${pr.number} ${pr.title}`);
  lines.push(pr.url);
  lines.push(`by ${author} · ${age} old`);
  if (pr.mergeable === "CONFLICTING") lines.push("⚠️ MERGE CONFLICTS!");

  if (extra) lines.push(extra);

  if (showNeeds) {
    const missing = [];
    if (!hasMemberApproval(pr)) missing.push("team member approval");
    if (!hasLeadApproval(pr)) missing.push("team lead approval");
    if (missing.length) lines.push(`Needs: ${missing.join(", ")}`);
  }

  const acted = [];
  for (const m of roles.allTeam) {
    const s = memberState(pr, m);
    if (s === "PENDING" || s === "AUTHOR") continue;
    const icon = STATE_ICONS[s] || "?";
    const role = roles.leads.includes(m) ? "(lead)" : "";
    acted.push(`${icon} ${m} ${role}`.trim());
  }
  if (acted.length) lines.push(`Reviews: ${acted.join(" · ")}`);

  const outside = [...pr.reviewState.entries()]
    .filter(
      ([login, state]) =>
        !roles.allTeam.includes(login) && state !== "COMMENTED"
    )
    .map(([login, state]) => `${STATE_ICONS[state] || "?"} ${login}`);
  if (outside.length) lines.push(`Other: ${outside.join(" · ")}`);

  return lines.map((l) => `  ${l}`).join("\n");
}

function printSection(title, prs, renderOpts) {
  if (prs.length === 0) return;
  console.log(title);
  console.log("─".repeat(60));
  for (const pr of prs) {
    console.log("");
    console.log(
      typeof renderOpts === "function"
        ? renderOpts(pr)
        : renderPRLine(pr, renderOpts)
    );
  }
  console.log("");
}

// ============================================================
// MODE: team
// ============================================================

function modeTeam() {
  const me = roles.currentUser;
  const needsAction = relevantPRs.filter((pr) => !isFullyApproved(pr));
  needsAction.sort(
    (a, b) => new Date(a.ready).getTime() - new Date(b.ready).getTime()
  );

  // PRs awaiting my re-review take priority over the generic stale / needs-
  // review buckets so they don't get lost.
  const reReviewPRs = needsAction.filter((pr) => needsMyReReview(pr, me));
  const reReviewSet = new Set(reReviewPRs.map((pr) => pr.number));

  const stalePRs = needsAction.filter(
    (pr) => pr.stale && !reReviewSet.has(pr.number)
  );
  const activePRs = needsAction.filter(
    (pr) => !pr.stale && !reReviewSet.has(pr.number)
  );
  const skipped = relevantPRs.length - needsAction.length;

  const conflictCount = needsAction.filter(
    (pr) => pr.mergeable === "CONFLICTING"
  ).length;
  const conflictNote = conflictCount > 0 ? ` · ${conflictCount} ⚠️ merge conflicts` : "";
  console.log(
    `${needsAction.length} PRs need attention · ${skipped} fully approved (hidden) · ${reReviewPRs.length} need your re-review · ${stalePRs.length} stale${conflictNote}\n`
  );

  printSection(
    "🔁 NEEDS YOUR RE-REVIEW (commits since your last review)",
    reReviewPRs
  );
  printSection(`🔴 STALE (>${STALE_DAYS}d)`, stalePRs);
  printSection("🟡 NEEDS REVIEW", activePRs);

  if (needsAction.length === 0) {
    console.log("All clear — every PR has team + lead approval.");
  }
}

// ============================================================
// MODE: review (PRs for me to review)
// ============================================================

function modeReview() {
  const me = roles.currentUser;
  const myRole = roles.currentUserRole;

  const candidates = relevantPRs.filter((pr) => {
    if (pr.author.login === me) return false;
    const myState = memberState(pr, me);
    if (myState === "APPROVED") return false;
    return true;
  });

  // Split: PRs where my review was dismissed vs new reviews needed
  const dismissed = [];
  const needed = [];

  for (const pr of candidates) {
    const myState = memberState(pr, me);
    if (myState === "DISMISSED") {
      dismissed.push(pr);
      continue;
    }

    if (myRole === "lead") {
      if (!hasLeadApproval(pr)) needed.push(pr);
    } else {
      if (!hasMemberApproval(pr)) needed.push(pr);
    }
  }

  dismissed.sort(
    (a, b) => new Date(a.ready).getTime() - new Date(b.ready).getTime()
  );
  needed.sort(
    (a, b) => new Date(a.ready).getTime() - new Date(b.ready).getTime()
  );

  console.log(
    `PRs to review for ${me} (${myRole}) · ${dismissed.length} re-review · ${needed.length} new\n`
  );

  printSection("🔄 RE-REVIEW (your previous review was dismissed)", dismissed, {
    extra: "⚠ Your review was dismissed — new commits since your last review",
  });
  printSection("📋 NEEDS YOUR REVIEW", needed);

  if (dismissed.length === 0 && needed.length === 0) {
    console.log("No PRs need your review right now.");
  }
}

// ============================================================
// MODE: my (my unmerged PRs)
// ============================================================

// Cross-pod-aware approval/state helpers used only by modeMy. They mirror
// hasMemberApproval / hasLeadApproval / isFullyApproved but read from the
// PR's owning pod's roles instead of the global single-pod `roles`.
function hasMemberApprovalInPod(pr, podRoles) {
  return podRoles.members.some((m) => memberState(pr, m) === "APPROVED");
}
function hasLeadApprovalInPod(pr, podRoles) {
  return podRoles.leads.some((m) => memberState(pr, m) === "APPROVED");
}
function isFullyApprovedInPod(pr, podRoles) {
  return (
    hasMemberApprovalInPod(pr, podRoles) && hasLeadApprovalInPod(pr, podRoles)
  );
}

// Compute every team person whose action is required to clear a missing
// approval gate on `pr`. A person needs to act if:
//   - the gate they cover (member or lead) is currently unsatisfied, AND
//   - their review state is DISMISSED (re-request) or PENDING (first request).
//
// Returns an ordered array of { login, role, state }. Order: members
// first, leads second; within each, dismissed before pending.
function pingTargetsForPod(pr, podRoles) {
  const targets = [];
  if (!hasMemberApprovalInPod(pr, podRoles)) {
    for (const m of podRoles.members) {
      const s = memberState(pr, m);
      if (s === "DISMISSED") targets.push({ login: m, role: "member", state: s });
    }
    for (const m of podRoles.members) {
      const s = memberState(pr, m);
      if (s === "PENDING") targets.push({ login: m, role: "member", state: s });
    }
  }
  if (!hasLeadApprovalInPod(pr, podRoles)) {
    for (const m of podRoles.leads) {
      const s = memberState(pr, m);
      if (s === "DISMISSED") targets.push({ login: m, role: "lead", state: s });
    }
    for (const m of podRoles.leads) {
      const s = memberState(pr, m);
      if (s === "PENDING") targets.push({ login: m, role: "lead", state: s });
    }
  }
  return targets;
}

// Format a ping target for the chat ping line, e.g. "@Dima (lead, re-request)".
function formatTarget(t) {
  const tags = [];
  if (t.role === "lead") tags.push("lead");
  if (t.state === "DISMISSED") tags.push("re-request");
  return tags.length
    ? `${slackHandle(t.login)} (${tags.join(", ")})`
    : slackHandle(t.login);
}

// Render a PR line scoped to a specific pod's team — overrides the
// "Reviews:" / "Other:" partition so cross-pod runs show the OWNING pod's
// team-vs-outside split rather than the global single-pod roles.
//
// `extras` may be a string, an array of strings, or null. Each non-null
// string is rendered as its own indented line below the by-line.
function renderPRLineForPod(pr, podRoles, extras) {
  const lines = [];
  lines.push(`#${pr.number} ${pr.title}`);
  lines.push(pr.url);
  const author = pr.author.name || pr.author.login;
  lines.push(`by ${author} · ${formatAge(pr.ready)} old`);
  if (pr.mergeable === "CONFLICTING") lines.push("⚠️ MERGE CONFLICTS!");

  const extraList = Array.isArray(extras) ? extras : extras ? [extras] : [];
  for (const e of extraList) {
    if (e) lines.push(e);
  }

  const missing = [];
  if (!hasMemberApprovalInPod(pr, podRoles)) missing.push("team member approval");
  if (!hasLeadApprovalInPod(pr, podRoles)) missing.push("team lead approval");
  if (missing.length) lines.push(`Needs: ${missing.join(", ")}`);

  const acted = [];
  for (const m of podRoles.allTeam) {
    const s = memberState(pr, m);
    if (s === "PENDING" || s === "AUTHOR") continue;
    const icon = STATE_ICONS[s] || "?";
    const role = podRoles.leads.includes(m) ? "(lead)" : "";
    acted.push(`${icon} ${m} ${role}`.trim());
  }
  if (acted.length) lines.push(`Reviews: ${acted.join(" · ")}`);

  const outside = [...pr.reviewState.entries()]
    .filter(
      ([login, state]) =>
        !podRoles.allTeam.includes(login) && state !== "COMMENTED",
    )
    .map(([login, state]) => `${STATE_ICONS[state] || "?"} ${login}`);
  if (outside.length) lines.push(`Other: ${outside.join(" · ")}`);

  return lines.map((l) => `  ${l}`).join("\n");
}

function modeMy() {
  const me = roles.currentUser;
  const myPRs = relevantPRs.filter((pr) => pr.author.login === me);

  // The user's "home" pods — pods that list them as a lead or member.
  // Used as the fallback team for pings when a PR doesn't path-match any
  // pod (e.g. a PR that only touches .cursor/skills/, .github/, or docs/).
  // First-match wins for users in multiple pods; this matches the
  // existing first-match rule for path-resolved PRs.
  const homePods = pods.filter(
    (p) => p.leads.includes(me) || p.members.includes(me),
  );
  const homePod = homePods[0] ?? null;

  const podRolesCache = new Map(); // pod -> rolesForPod
  function rolesForPodCached(pod) {
    if (!pod) return null;
    let cached = podRolesCache.get(pod);
    if (!cached) {
      cached = rolesForPod(pod);
      podRolesCache.set(pod, cached);
    }
    return cached;
  }

  const enriched = myPRs.map((pr) => {
    const pathPod = findPodForFiles(pr.files, pods);
    const resolvedPod = pathPod ?? homePod;
    const source = pathPod ? "path" : pathPod === null && homePod ? "home" : null;
    return {
      pr,
      pod: resolvedPod,
      podRoles: rolesForPodCached(resolvedPod),
      podSource: source, // "path" | "home" | null
    };
  });

  const readyToMerge = [];
  const needsReReview = [];
  const awaitingReview = [];
  const noPod = [];

  for (const entry of enriched) {
    if (!entry.podRoles) {
      noPod.push(entry);
      continue;
    }
    if (isFullyApprovedInPod(entry.pr, entry.podRoles)) {
      readyToMerge.push(entry);
      continue;
    }
    // Full ping target list for missing approval gates. Includes dismissed
    // (re-request) AND pending (never-reviewed) team members and leads, so
    // a PR whose lead never reviewed still surfaces a ping for them.
    const targets = pingTargetsForPod(entry.pr, entry.podRoles);
    const hasDismissed = targets.some((t) => t.state === "DISMISSED");
    const enrichedEntry = { ...entry, targets };
    if (hasDismissed) {
      needsReReview.push(enrichedEntry);
    } else {
      awaitingReview.push(enrichedEntry);
    }
  }

  console.log(
    `My PRs (${me}) · ${readyToMerge.length} ready · ${needsReReview.length} re-review · ${awaitingReview.length} awaiting${noPod.length ? ` · ${noPod.length} no pod` : ""}\n`,
  );

  // Annotation injected when ping logic falls back to the user's home
  // pod because the PR's touched files don't path-match any pod.
  function homeNote(entry) {
    return entry.podSource === "home"
      ? `(via your home team: ${entry.pod.pod})`
      : null;
  }

  if (readyToMerge.length > 0) {
    console.log("✅ READY TO MERGE");
    console.log("─".repeat(60));
    for (const entry of readyToMerge) {
      console.log("");
      console.log(renderPRLineForPod(entry.pr, entry.podRoles, [homeNote(entry)]));
    }
    console.log("");
  }

  if (needsReReview.length > 0) {
    console.log("🔄 NEEDS RE-REVIEW");
    console.log("─".repeat(60));
    for (const entry of needsReReview) {
      const { pr, podRoles, targets } = entry;
      console.log("");
      const pingLine = targets.length
        ? `Ping: ${targets.map(formatTarget).join(", ")}`
        : null;
      console.log(
        renderPRLineForPod(pr, podRoles, [homeNote(entry), pingLine]),
      );
    }
    console.log("");

    console.log("Slack messages (copy-paste ready):");
    console.log("─".repeat(60));
    for (const { pr, targets } of needsReReview) {
      const handles = targets.map((t) => slackHandle(t.login)).join(" ");
      console.log(
        `Re-review needed: PR #${pr.number} "${pr.title}" — ${handles} ${pr.url}`,
      );
    }
    console.log("");
  }

  if (awaitingReview.length > 0) {
    console.log("⏳ AWAITING REVIEW");
    console.log("─".repeat(60));
    for (const entry of awaitingReview) {
      const { pr, podRoles, targets } = entry;
      console.log("");
      const pingLine = targets.length
        ? `Ping: ${targets.map(formatTarget).join(", ")}`
        : null;
      console.log(
        renderPRLineForPod(pr, podRoles, [homeNote(entry), pingLine]),
      );
    }
    console.log("");

    console.log("Slack messages (copy-paste ready):");
    console.log("─".repeat(60));
    for (const { pr, targets } of awaitingReview) {
      const handles = targets.map((t) => slackHandle(t.login)).join(" ");
      console.log(
        `Review needed: PR #${pr.number} "${pr.title}" — ${handles} ${pr.url}`,
      );
    }
    console.log("");
  }

  if (noPod.length > 0) {
    // True no-pod (no path match AND user has no home team). Show
    // metadata + raw review status so the PR is still actionable via
    // the GitHub UI; ping logic isn't possible without a team.
    console.log("❓ NO POD / NO HOME TEAM");
    console.log("─".repeat(60));
    for (const { pr } of noPod) {
      console.log("");
      console.log(`  #${pr.number} ${pr.title}`);
      console.log(`  ${pr.url}`);
      const author = pr.author.name || pr.author.login;
      console.log(`  by ${author} · ${formatAge(pr.ready)} old`);
      if (pr.mergeable === "CONFLICTING") console.log("  ⚠️ MERGE CONFLICTS!");
      const reviewers = [...pr.reviewState.entries()]
        .filter(([, state]) => state !== "COMMENTED")
        .map(([login, state]) => `${STATE_ICONS[state] || "?"} ${login}`);
      if (reviewers.length) console.log(`  Reviews: ${reviewers.join(" · ")}`);
      console.log(
        `  No .github/teams/<pod>.json owns the touched files and you are not in any pod's team.`,
      );
    }
    console.log("");
  }

  if (myPRs.length === 0) {
    if (isCrossPodMy) {
      console.log("You have no open PRs in tetherto/qvac.");
    } else {
      console.log(`You have no open PRs touching ${pods[0].pod} pod paths.`);
    }
  }
}

// --- Run ---

switch (mode) {
  case "team":
    modeTeam();
    break;
  case "review":
    modeReview();
    break;
  case "my":
    modeMy();
    break;
}
