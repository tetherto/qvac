#!/usr/bin/env node
//
// Cross-pod PR status / review-queue / my-PRs dashboard for tetherto/qvac.
//
// Usage:
//   node .../pr-status.mjs --pod <pod> --mode team
//   node .../pr-status.mjs --pod <pod> --mode review
//   node .../pr-status.mjs --pod <pod> --mode my
//
// `<pod>` selects the team metadata file at .github/teams/<pod>.json
// (see team.mjs). Slack handles for `--mode my` are loaded from
// ~/.config/qvac-pr-skills/slack.json (see slack.mjs).

import { execFileSync } from "node:child_process";

import { loadTeam } from "./team.mjs";
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

const pod = (function () {
  const val = readArg("--pod");
  if (!val) {
    console.error("--pod <name> is required (e.g. --pod sdk)");
    process.exit(1);
  }
  return val;
})();

const mode = (function () {
  const val = readArg("--mode") ?? "team";
  if (!["team", "review", "my"].includes(val)) {
    console.error(`Unknown mode: ${val}. Use --mode team|review|my`);
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

console.error(`Loading ${pod} team roster...`);
const team = loadTeam(pod);
const OWNED_PATHS = team.ownedPaths;

function detectRoles() {
  const currentUser = gh(["api", "user", "--jq", ".login"]);
  const leadSet = new Set(team.leads);
  // Members minus anyone who is also a lead, in case of overlap
  const memberLogins = team.members.filter((l) => !leadSet.has(l));
  const allTeam = [...new Set([...team.leads, ...memberLogins])];
  const currentUserRole = leadSet.has(currentUser) ? "lead" : "member";
  return {
    currentUser,
    currentUserRole,
    leads: team.leads,
    members: memberLogins,
    allTeam,
  };
}

const roles = detectRoles();

// --- Slack handle map (only consulted in --mode my) ---

let slackState = { map: {}, pendingReview: [] };

if (mode === "my") {
  const { state } = loadSlackMap();
  const allLogins = roles.allTeam;
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

// --- Filter to PRs touching owned paths ---

const relevantPRs = [];

for (const pr of allPRs) {
  if (pr.isDraft) continue;
  // Skip PRs whose author has been deleted (ghost user) -- the script's
  // self-author and ping logic both require pr.author.login.
  if (!pr.author?.login) continue;
  const files = pr.files?.nodes || [];
  if (!touchesOwnedPaths(files)) continue;

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

function modeMy() {
  const me = roles.currentUser;
  const myPRs = relevantPRs.filter((pr) => pr.author.login === me);

  const readyToMerge = [];
  const needsReReview = [];
  const awaitingReview = [];

  for (const pr of myPRs) {
    if (isFullyApproved(pr)) {
      readyToMerge.push(pr);
      continue;
    }

    // Check if any team reviewer's approval was dismissed
    const dismissedReviewers = roles.allTeam.filter(
      (m) => memberState(pr, m) === "DISMISSED"
    );
    if (dismissedReviewers.length > 0) {
      needsReReview.push({ pr, dismissedReviewers });
      continue;
    }

    awaitingReview.push(pr);
  }

  console.log(
    `My PRs (${me}) · ${readyToMerge.length} ready · ${needsReReview.length} re-review · ${awaitingReview.length} awaiting\n`
  );

  printSection(
    "✅ READY TO MERGE",
    readyToMerge,
    { showNeeds: false }
  );

  if (needsReReview.length > 0) {
    console.log("🔄 NEEDS RE-REVIEW");
    console.log("─".repeat(60));
    for (const { pr, dismissedReviewers } of needsReReview) {
      console.log("");
      const whoToPing = dismissedReviewers
        .map((m) => {
          const role = roles.leads.includes(m) ? " (lead)" : "";
          return `${slackHandle(m)}${role}`;
        })
        .join(", ");
      console.log(renderPRLine(pr, { extra: `Re-request: ${whoToPing}` }));
    }
    console.log("");

    // Slack messages
    console.log("Slack messages (copy-paste ready):");
    console.log("─".repeat(60));
    for (const { pr, dismissedReviewers } of needsReReview) {
      const tags = dismissedReviewers.map(slackHandle).join(" ");
      console.log(
        `Re-review needed: PR #${pr.number} "${pr.title}" — ${tags} ${pr.url}`
      );
    }
    console.log("");
  }

  if (awaitingReview.length > 0) {
    // Figure out who to ping for each PR
    console.log("⏳ AWAITING REVIEW");
    console.log("─".repeat(60));
    for (const pr of awaitingReview) {
      console.log("");
      const missingPeople = [];
      if (!hasMemberApproval(pr)) {
        const pendingMembers = roles.members.filter(
          (m) => memberState(pr, m) === "PENDING"
        );
        missingPeople.push(...pendingMembers.map(slackHandle));
      }
      if (!hasLeadApproval(pr)) {
        const pendingLeads = roles.leads.filter(
          (m) => memberState(pr, m) === "PENDING"
        );
        missingPeople.push(
          ...pendingLeads.map((m) => `${slackHandle(m)} (lead)`)
        );
      }
      const pingLine = missingPeople.length
        ? `Ping: ${missingPeople.join(", ")}`
        : null;
      console.log(renderPRLine(pr, { extra: pingLine }));
    }
    console.log("");

    // Slack messages
    console.log("Slack messages (copy-paste ready):");
    console.log("─".repeat(60));
    for (const pr of awaitingReview) {
      const missing = [];
      if (!hasMemberApproval(pr)) {
        const pendingMembers = roles.members.filter(
          (m) => memberState(pr, m) === "PENDING"
        );
        missing.push(...pendingMembers.map(slackHandle));
      }
      if (!hasLeadApproval(pr)) {
        const pendingLeads = roles.leads.filter(
          (m) => memberState(pr, m) === "PENDING"
        );
        missing.push(...pendingLeads.map(slackHandle));
      }
      console.log(
        `Review needed: PR #${pr.number} "${pr.title}" — ${missing.join(" ")} ${pr.url}`
      );
    }
    console.log("");
  }

  if (myPRs.length === 0) {
    console.log(`You have no open PRs touching ${pod} pod paths.`);
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
