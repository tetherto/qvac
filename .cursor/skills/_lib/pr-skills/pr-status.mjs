#!/usr/bin/env node
//
// PR status / review-queue / my-PRs dashboard.

import {
  STATE_ICONS,
  classifyMyPRs,
  classifyReviewPRs,
  classifyTeamPRs,
  collectPRActivity,
  formatAge,
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

const jsonOutput = process.argv.includes("--json");
const state = collectPRActivity({ mode, pod });

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

function renderPRLine(pr, podRoles = state.roles, extras = []) {
  const extraList = Array.isArray(extras) ? extras : extras ? [extras] : [];
  const lines = [
    `#${pr.number} ${pr.title}`,
    pr.url,
    `by ${pr.author.name || pr.author.login} · ${formatAge(pr.ready)} old`,
  ];
  if (pr.mergeable === "CONFLICTING") lines.push("⚠️ MERGE CONFLICTS!");
  for (const extra of extraList) if (extra) lines.push(extra);

  const missing = [];
  if (!podRoles.members.some((member) => memberState(pr, member) === "APPROVED")) {
    missing.push("team member approval");
  }
  if (!podRoles.leads.some((lead) => memberState(pr, lead) === "APPROVED")) {
    missing.push("team lead approval");
  }
  if (missing.length) lines.push(`Needs: ${missing.join(", ")}`);

  const acted = [];
  for (const member of podRoles.allTeam) {
    const status = memberState(pr, member);
    if (status === "PENDING" || status === "AUTHOR") continue;
    const role = podRoles.leads.includes(member) ? "(lead)" : "";
    acted.push(`${STATE_ICONS[status] || "?"} ${member} ${role}`.trim());
  }
  if (acted.length) lines.push(`Reviews: ${acted.join(" · ")}`);

  const outside = [...pr.reviewState.entries()]
    .filter(([login, status]) => !podRoles.allTeam.includes(login) && status !== "COMMENTED")
    .map(([login, status]) => `${STATE_ICONS[status] || "?"} ${login}`);
  if (outside.length) lines.push(`Other: ${outside.join(" · ")}`);

  return lines.map((line) => `  ${line}`).join("\n");
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

function jsonPRs(prs) {
  return prs.map(toJsonablePR);
}

function modeTeam() {
  const groups = classifyTeamPRs(state);
  if (jsonOutput) {
    console.log(JSON.stringify({
      mode,
      repo: state.repo,
      currentUser: state.currentUser,
      staleDays: state.staleDays,
      summary: {
        needsAction: groups.needsAction.length,
        fullyApprovedHidden: groups.skipped,
        reReview: groups.reReviewPRs.length,
        stale: groups.stalePRs.length,
        conflicts: groups.conflictCount,
      },
      groups: {
        reReview: jsonPRs(groups.reReviewPRs),
        stale: jsonPRs(groups.stalePRs),
        needsReview: jsonPRs(groups.activePRs),
      },
    }, null, 2));
    return;
  }
  const conflictNote = groups.conflictCount > 0
    ? ` · ${groups.conflictCount} ⚠️ merge conflicts`
    : "";
  console.log(
    `${groups.needsAction.length} PRs need attention · ${groups.skipped} fully approved (hidden) · ${groups.reReviewPRs.length} need your re-review · ${groups.stalePRs.length} stale${conflictNote}\n`,
  );
  printSection("🔁 NEEDS YOUR RE-REVIEW (commits since your last review)", groups.reReviewPRs, renderPRLine);
  printSection(`🔴 STALE (>${state.staleDays}d)`, groups.stalePRs, renderPRLine);
  printSection("🟡 NEEDS REVIEW", groups.activePRs, renderPRLine);
  if (groups.needsAction.length === 0) {
    console.log("All clear — every PR has team + lead approval.");
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
