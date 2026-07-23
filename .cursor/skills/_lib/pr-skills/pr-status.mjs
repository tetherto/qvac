#!/usr/bin/env node
//
// PR status / review-queue / my-PRs dashboard.

import {
  AUTHOR_TIER_ORDER,
  STATE_ICONS,
  classifyMyPRs,
  classifyReviewPRs,
  classifyTeamPRs,
  collectPRActivity,
  formatAge,
  groupTeamPRsByTier,
  memberState,
  toJsonablePR,
} from "./pr-activity.mjs";
import { loadSlackMap, bootstrapMissing, saveSlackMap } from "./slack.mjs";

function readArg(name) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

const mode = (() => {
  const val = readArg("--mode") ?? "team";
  if (!["team", "review", "my"].includes(val)) {
    console.error(`Unknown mode: ${val}. Use --mode team|review|my`);
    process.exit(1);
  }
  return val;
})();

const pod = (() => {
  const val = readArg("--pod");
  if (mode === "my") return val ?? null;
  if (!val) {
    console.error(`--pod <name> is required for --mode ${mode}`);
    process.exit(1);
  }
  return val;
})();

const authorScope = (() => {
  const val = readArg("--authors") ?? "any";
  if (!["any", "pod", "union"].includes(val)) {
    console.error(`Unknown --authors value: ${val}. Use any|pod|union.`);
    process.exit(1);
  }
  if ((val === "pod" || val === "union") && mode !== "team") {
    console.error(`--authors ${val} is only honored in --mode team (got ${mode}); ignoring.`);
    return "any";
  }
  return val;
})();

const authorTiers = (() => {
  if (!process.argv.includes("--tiers")) return false;
  if (mode !== "team") {
    console.error(`--tiers is only honored in --mode team (got ${mode}); ignoring.`);
    return false;
  }
  return true;
})();

const jsonOutput = process.argv.includes("--json");
const state = collectPRActivity({ mode, pod, authorScope, authorTiers });

let slackState = { map: {}, pendingReview: [] };
if (mode === "my") {
  const { state: loaded } = loadSlackMap();
  const allLogins = [
    ...new Set(state.pods.flatMap((team) => [...team.leads, ...team.members])),
  ];
  const { state: bootstrapped, addedLogins } = bootstrapMissing(loaded, allLogins);
  slackState = bootstrapped;
  if (addedLogins.length > 0) saveSlackMap(slackState);
  if (slackState.pendingReview.length > 0) {
    console.error(`SLACK_VALIDATION_REQUIRED ${slackState.pendingReview.length}`);
  }
}

function slackHandle(login) {
  return slackState.map[login] || `@${login}`;
}

function formatTarget(target) {
  const tags = [];
  if (target.role === "lead") tags.push("lead");
  if (target.state === "DISMISSED") tags.push("re-request");
  return tags.length
    ? `${slackHandle(target.login)} (${tags.join(", ")})`
    : slackHandle(target.login);
}

function missingApprovals(pr, podRoles) {
  const missing = [];
  // Approval gates use formal review state only (not conversation comments).
  if (!podRoles.members.some((member) => pr.reviewState.get(member) === "APPROVED")) {
    missing.push("team member approval");
  }
  if (!podRoles.leads.some((lead) => pr.reviewState.get(lead) === "APPROVED")) {
    missing.push("team lead approval");
  }
  return missing;
}

function reviewLines(pr, podRoles) {
  const acted = [];
  for (const member of podRoles.allTeam) {
    const status = memberState(pr, member);
    if (status === "PENDING" || status === "AUTHOR") continue;
    acted.push(`${STATE_ICONS[status] || "?"} ${member}`);
  }
  const outsideState = pr.displayReviewState || pr.reviewState;
  const outside = [...outsideState.entries()]
    .filter(([login, status]) => !podRoles.allTeam.includes(login) && status !== "COMMENTED")
    .map(([login, status]) => `${STATE_ICONS[status] || "?"} ${login}`);
  return { acted, outside };
}

// Plain-text renderer used by --mode review / my.
function renderPRLine(pr, podRoles = state.roles, extras = [], { showNeeds = true } = {}) {
  const extraList = Array.isArray(extras) ? extras : extras ? [extras] : [];
  const lines = [
    `${pr.prRef ?? `#${pr.number}`} ${pr.title}`,
    pr.url,
    `by ${pr.author.name || pr.author.login} · ${formatAge(pr.ready)} old`,
  ];
  if (pr.mergeable === "CONFLICTING") lines.push("⚠️ MERGE CONFLICTS!");
  for (const extra of extraList) if (extra) lines.push(extra);

  if (showNeeds) {
    const missing = missingApprovals(pr, podRoles);
    if (missing.length) lines.push(`Needs: ${missing.join(", ")}`);
  }

  const { acted, outside } = reviewLines(pr, podRoles);
  if (acted.length) lines.push(`Reviews: ${acted.join(" · ")}`);
  if (outside.length) lines.push(`Other: ${outside.join(" · ")}`);
  if (pr.ciRed) lines.push(pr.ciRed);

  return lines.map((line) => `  ${line}`).join("\n");
}

// Chat/Slack-friendly markdown renderer used by --mode team.
function renderMarkdownPR(pr, podRoles = state.roles, { showNeeds = true } = {}) {
  const ref = pr.prRef ?? `#${pr.number}`;
  const lines = [
    `- [**${ref}**](${pr.url}) — ${pr.title}`,
    `  - by ${pr.author.name || pr.author.login} · ${formatAge(pr.ready)} old`,
  ];
  if (pr.mergeable === "CONFLICTING") lines.push("  - ⚠️ Merge conflicts");
  if (showNeeds) {
    const missing = missingApprovals(pr, podRoles);
    if (missing.length) lines.push(`  - Needs: ${missing.join(", ")}`);
  }
  const { acted, outside } = reviewLines(pr, podRoles);
  if (acted.length) lines.push(`  - Reviews: ${acted.join(" · ")}`);
  if (outside.length) lines.push(`  - Other: ${outside.join(" · ")}`);
  if (pr.ciRed) lines.push(`  - ${pr.ciRed}`);
  return lines.join("\n");
}

function printSection(title, items, render) {
  if (items.length === 0) return;
  console.log(title);
  console.log("─".repeat(60));
  for (const item of items) {
    console.log("");
    console.log(render(item));
  }
  console.log("");
}

function printMarkdownSection(heading, items, render) {
  if (items.length === 0) return;
  console.log(heading);
  console.log("");
  for (let i = 0; i < items.length; i++) {
    if (i > 0) console.log("");
    console.log(render(items[i]));
  }
  console.log("");
}

function jsonPRs(prs) {
  return prs.map(toJsonablePR);
}

// Per-repo render cap for the Excluded section. With sole-owner extraRepos,
// every non-roster (incl. bot) PR is excluded, so a busy extra repo could
// otherwise bury the rest. The cap is display-only — --json always carries
// the complete list.
const EXCLUDED_RENDER_CAP_PER_REPO = 10;

function printExcludedSection(excludedPRs, primaryRepo) {
  console.log("⏭️ **Excluded** (author outside roster)");
  console.log("");
  const byRepo = new Map();
  for (const pr of excludedPRs) {
    const key = pr.repo ?? primaryRepo;
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key).push(pr);
  }
  let printed = 0;
  for (const [repo, prs] of byRepo) {
    for (const pr of prs.slice(0, EXCLUDED_RENDER_CAP_PER_REPO)) {
      if (printed > 0) console.log("");
      const author = pr.author.name || pr.author.login;
      const ref = pr.prRef ?? `#${pr.number}`;
      console.log(`- [**${ref}**](${pr.url}) — ${pr.title}`);
      console.log(`  - by ${author} (@${pr.author.login}) · ${formatAge(pr.ready)} old`);
      printed++;
    }
    const hidden = prs.length - EXCLUDED_RENDER_CAP_PER_REPO;
    if (hidden > 0) {
      console.log("");
      console.log(`- … +${hidden} more in ${repo} — use \`--json\` for the full list`);
    }
  }
  console.log("");
}

function tierHeading(tierKey) {
  const teamName = state.pods?.[0]?.name || "Pod";
  const coreLabel = teamName.replace(/\s*Pod\s*$/i, "").trim() || teamName;
  if (tierKey === "core") return `## 👥 ${coreLabel} Core`;
  if (tierKey === "platform") return "## 🧩 Platform/Middleware";
  return "## 🌍 External Contribution";
}

function tierAttentionCount(tierGroups) {
  return (
    tierGroups.reReviewPRs.length +
    tierGroups.stalePRs.length +
    tierGroups.activePRs.length
  );
}

function printTierBuckets(tierGroups) {
  printMarkdownSection(
    "🔁 **Needs Your Re-Review** (commits since your last review or comment)",
    tierGroups.reReviewPRs,
    (pr) => renderMarkdownPR(pr),
  );
  printMarkdownSection(
    `🔴 **Stale** (>${state.staleDays}d)`,
    tierGroups.stalePRs,
    (pr) => renderMarkdownPR(pr),
  );
  printMarkdownSection(
    "🟡 **Needs Review**",
    tierGroups.activePRs,
    (pr) => renderMarkdownPR(pr),
  );
  printMarkdownSection(
    "🟢 **Fully Approved — Ready to Merge**",
    tierGroups.approvedPRs,
    (pr) => renderMarkdownPR(pr, state.roles, { showNeeds: false }),
  );
}

function modeTeam() {
  const groups = classifyTeamPRs(state);
  const excludedPRs = state.excludedPRs ?? [];
  const useTiers = Boolean(state.authorTiers);
  const byTier = useTiers ? groupTeamPRsByTier(groups) : null;

  if (jsonOutput) {
    const payload = {
      mode,
      repo: state.repo,
      repos: state.repos,
      currentUser: state.currentUser,
      staleDays: state.staleDays,
      authorScope: state.authorScope,
      authorTiers: useTiers,
      summary: {
        needsAction: groups.needsAction.length,
        fullyApproved: groups.approvedPRs.length,
        reReview: groups.reReviewPRs.length,
        stale: groups.stalePRs.length,
        conflicts: groups.conflictCount,
        excluded: excludedPRs.length,
      },
      groups: {
        reReview: jsonPRs(groups.reReviewPRs),
        stale: jsonPRs(groups.stalePRs),
        needsReview: jsonPRs(groups.activePRs),
        fullyApproved: jsonPRs(groups.approvedPRs),
        excluded: jsonPRs(excludedPRs),
      },
    };
    if (useTiers) {
      payload.summary.core = tierAttentionCount(byTier.core);
      payload.summary.platform = tierAttentionCount(byTier.platform);
      payload.summary.external = tierAttentionCount(byTier.external);
      payload.tiers = {};
      for (const key of AUTHOR_TIER_ORDER) {
        payload.tiers[key] = {
          reReview: jsonPRs(byTier[key].reReviewPRs),
          stale: jsonPRs(byTier[key].stalePRs),
          needsReview: jsonPRs(byTier[key].activePRs),
          fullyApproved: jsonPRs(byTier[key].approvedPRs),
        };
      }
    }
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const extraRepos = (state.repos ?? []).filter((r) => r !== state.repo);
  if (extraRepos.length > 0) {
    console.log(
      `Repos: ${state.repo} (primary) + ${extraRepos.length} extra: ${extraRepos.join(", ")}`,
    );
    console.log("");
  }

  if (groups.needsAction.length === 0 && groups.approvedPRs.length === 0) {
    console.log("All clear — no open pod PRs need attention.");
    return;
  }

  const conflictNote = groups.conflictCount > 0
    ? ` · ${groups.conflictCount} ⚠️ merge conflicts`
    : "";

  if (useTiers) {
    const nCore = tierAttentionCount(byTier.core);
    const nPlat = tierAttentionCount(byTier.platform);
    const nExt = tierAttentionCount(byTier.external);
    const teamName = state.pods?.[0]?.name || "Pod";
    const coreLabel = (teamName.replace(/\s*Pod\s*$/i, "").trim() || teamName).toLowerCase();
    console.log(
      `**${nCore} ${coreLabel} core need attention** · ${nPlat} platform · ${nExt} external · ${groups.approvedPRs.length} fully approved · ${groups.reReviewPRs.length} need your re-review · ${groups.stalePRs.length} stale${conflictNote}`,
    );
    console.log("");

    const tierBlocks = [];
    for (const key of AUTHOR_TIER_ORDER) {
      const t = byTier[key];
      const total =
        t.reReviewPRs.length + t.stalePRs.length + t.activePRs.length + t.approvedPRs.length;
      if (!total) continue;
      tierBlocks.push({ key, groups: t });
    }

    for (let i = 0; i < tierBlocks.length; i++) {
      if (i > 0) {
        console.log("---");
        console.log("");
      }
      console.log(tierHeading(tierBlocks[i].key));
      console.log("");
      printTierBuckets(tierBlocks[i].groups);
    }
  } else {
    console.log(
      `**${groups.needsAction.length} PRs need attention** · ${groups.approvedPRs.length} fully approved · ${groups.reReviewPRs.length} need your re-review · ${groups.stalePRs.length} stale${conflictNote}`,
    );
    console.log("");
    printTierBuckets(groups);
  }

  if (state.authorScope === "pod" && excludedPRs.length > 0) {
    printExcludedSection(excludedPRs, state.repo);
  }
  if (groups.needsAction.length === 0) {
    console.log("All clear — every remaining PR has team + lead approval.");
  }
}

function modeReview() {
  const groups = classifyReviewPRs(state);
  if (jsonOutput) {
    console.log(JSON.stringify({
      mode,
      repo: state.repo,
      currentUser: state.currentUser,
      currentUserRole: state.roles.currentUserRole,
      groups: {
        dismissed: jsonPRs(groups.dismissed),
        needed: jsonPRs(groups.needed),
      },
    }, null, 2));
    return;
  }
  console.log(
    `PRs to review for ${state.currentUser} (${state.roles.currentUserRole}) · ${groups.dismissed.length} re-review · ${groups.needed.length} new\n`,
  );
  printSection("🔄 RE-REVIEW (your previous review was dismissed)", groups.dismissed, (pr) =>
    renderPRLine(pr, state.roles, "⚠ Your review was dismissed — new commits since your last review"),
  );
  printSection("📋 NEEDS YOUR REVIEW", groups.needed, renderPRLine);
  if (groups.dismissed.length === 0 && groups.needed.length === 0) {
    console.log("No PRs need your review right now.");
  }
}

function modeMy() {
  const groups = classifyMyPRs(state);
  if (jsonOutput) {
    console.log(JSON.stringify({
      mode,
      repo: state.repo,
      currentUser: state.currentUser,
      summary: {
        ready: groups.readyToMerge.length,
        reReview: groups.needsReReview.length,
        awaiting: groups.awaitingReview.length,
        noPod: groups.noPod.length,
      },
      groups: {
        readyToMerge: groups.readyToMerge.map((entry) => toJsonablePR(entry.pr)),
        needsReReview: groups.needsReReview.map((entry) => ({
          ...toJsonablePR(entry.pr),
          targets: entry.targets,
        })),
        awaitingReview: groups.awaitingReview.map((entry) => ({
          ...toJsonablePR(entry.pr),
          targets: entry.targets,
        })),
        noPod: groups.noPod.map((entry) => toJsonablePR(entry.pr)),
      },
    }, null, 2));
    return;
  }

  console.log(
    `My PRs (${state.currentUser}) · ${groups.readyToMerge.length} ready · ${groups.needsReReview.length} re-review · ${groups.awaitingReview.length} awaiting${groups.noPod.length ? ` · ${groups.noPod.length} no pod` : ""}\n`,
  );

  const homeNote = (entry) =>
    entry.podSource === "home" ? `(via your home team: ${entry.pod.pod})` : null;

  printSection("✅ READY TO MERGE", groups.readyToMerge, (entry) =>
    renderPRLine(entry.pr, entry.podRoles, [homeNote(entry)]),
  );

  printSection("🔄 NEEDS RE-REVIEW", groups.needsReReview, (entry) => {
    const pingLine = entry.targets.length
      ? `Ping: ${entry.targets.map(formatTarget).join(", ")}`
      : null;
    return renderPRLine(entry.pr, entry.podRoles, [homeNote(entry), pingLine]);
  });
  if (groups.needsReReview.length > 0) {
    console.log("Slack messages (copy-paste ready):");
    console.log("─".repeat(60));
    for (const { pr, targets } of groups.needsReReview) {
      console.log(
        `Re-review needed: PR #${pr.number} "${pr.title}" — ${targets.map((target) => slackHandle(target.login)).join(" ")} ${pr.url}`,
      );
    }
    console.log("");
  }

  printSection("⏳ AWAITING REVIEW", groups.awaitingReview, (entry) => {
    const pingLine = entry.targets.length
      ? `Ping: ${entry.targets.map(formatTarget).join(", ")}`
      : null;
    return renderPRLine(entry.pr, entry.podRoles, [homeNote(entry), pingLine]);
  });
  if (groups.awaitingReview.length > 0) {
    console.log("Slack messages (copy-paste ready):");
    console.log("─".repeat(60));
    for (const { pr, targets } of groups.awaitingReview) {
      console.log(
        `Review needed: PR #${pr.number} "${pr.title}" — ${targets.map((target) => slackHandle(target.login)).join(" ")} ${pr.url}`,
      );
    }
    console.log("");
  }

  printSection("❓ NO POD / NO HOME TEAM", groups.noPod, ({ pr }) =>
    renderPRLine(pr, { leads: [], members: [], allTeam: [] }, [
      "No .github/teams/<pod>.json owns the touched files and you are not in any pod's team.",
    ]),
  );

  if (groups.myPRs.length === 0) {
    console.log(state.isCrossPodMy
      ? `You have no open PRs in ${state.repo}.`
      : `You have no open PRs touching ${state.pods[0].pod} pod paths.`);
  }
}

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
