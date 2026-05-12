#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { groupActivities, normalizeDiaryEntries, renderDailyUpdate } from "./activity.mjs";
import { findTaskByTicket, searchTasks } from "./asana.mjs";
import { loadConfig } from "./config.mjs";
import { readDiaryRange } from "./diary.mjs";
import { classifyMyPRs, collectPRActivity } from "../pr-skills/pr-activity.mjs";

function readArg(name) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? null : process.argv[idx + 1];
}

function todayKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function dateLabel(date = new Date()) {
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}

function ticketPattern(config) {
  try {
    return new RegExp(config.ticket?.pattern || "\\b[A-Z]+-\\d+\\b");
  } catch {
    return /\b[A-Z]+-\d+\b/;
  }
}

function extractTicket(text, config) {
  return String(text || "").match(ticketPattern(config))?.[0] || null;
}

function prDetails(repo, number) {
  try {
    const raw = gh([
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "number,title,url",
    ]);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function prStateDetails(repo, number) {
  try {
    const raw = gh([
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "number,title,url,state,mergedAt,closedAt",
    ]);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function verbForPRState(state) {
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return "created";
}

function reviewVerbFromEventState(state) {
  if (state === "approved") return "approved";
  if (state === "changes_requested") return "requested changes";
  if (state === "commented") return "commented";
  return null;
}

function reviewEventsForDay(date, config) {
  const reviews = new Map();
  try {
    const login = gh(["api", "user", "--jq", ".login"]);
    const raw = gh(["api", `/users/${login}/events?per_page=100`]);
    const events = JSON.parse(raw || "[]")
      .filter((event) =>
        event.type === "PullRequestReviewEvent" &&
          event.created_at?.startsWith(date) &&
          reviewVerbFromEventState(event.payload?.review?.state),
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const event of events) {
      const repo = event.repo?.name;
      const number = event.payload?.pull_request?.number;
      if (!repo || !number) continue;
      reviews.set(`${repo}#${number}`, {
        repo,
        number,
        verb: reviewVerbFromEventState(event.payload.review.state),
      });
    }
  } catch {
    return [];
  }
  const out = [];
  for (const review of reviews.values()) {
    const details = prDetails(review.repo, review.number);
    out.push({
      source: "github-events",
      kind: "review",
      verb: review.verb,
      ticket: details ? extractTicket(details.title, config) : null,
      pr: review.number,
      repo: review.repo,
      title: details?.title || `PR #${review.number}`,
      summary: details?.title || `PR #${review.number}`,
      url: details?.url || `https://github.com/${review.repo}/pull/${review.number}`,
    });
  }
  return out;
}

async function enrichTickets(items, config) {
  const cache = new Map();
  const tickets = [
    ...new Set(items.map((item) =>
      item.ticket || extractTicket(`${item.title} ${item.summary}`, config),
    ).filter(Boolean)),
  ];
  await Promise.all(tickets.map(async (ticket) => {
    try {
      cache.set(ticket, await findTaskByTicket(config, ticket));
    } catch {
      cache.set(ticket, null);
    }
  }));
  for (const item of items) {
    const ticket = item.ticket || extractTicket(`${item.title} ${item.summary}`, config);
    if (!ticket) continue;
    item.ticket = ticket;
    const task = cache.get(ticket);
    if (task) {
      item.ticketTitle = task.name;
      item.ticketUrl = task.permalink_url;
    }
  }
  return items;
}

async function githubActivityForDay(date, config, prState = null) {
  const out = [];
  try {
    const raw = gh([
      "search",
      "prs",
      "--author",
      "@me",
      "--updated",
      `>=${date}`,
      "--json",
      "number,title,url,repository,state,createdAt,updatedAt",
    ]);
    for (const pr of JSON.parse(raw || "[]")) {
      const repo = pr.repository?.nameWithOwner;
      const details = repo ? prStateDetails(repo, pr.number) : null;
      const state = details?.state || pr.state;
      if (state === "CLOSED") continue;
      out.push({
        source: "github",
        kind: "pr",
        verb: verbForPRState(state),
        ticket: extractTicket(details?.title || pr.title, config),
        pr: pr.number,
        repo,
        title: details?.title || pr.title,
        summary: details?.title || pr.title,
        url: details?.url || pr.url,
      });
    }
  } catch {
    // gh search availability varies by auth/env; diary still drives the update.
  }
  out.push(...reviewEventsForDay(date, config));
  return out;
}

function preferLinkedDiaryActivity(items) {
  const linkedUrls = new Set(
    items
      .filter((item) => item.source === "diary" && item.ticket && item.url)
      .map((item) => item.url),
  );
  if (linkedUrls.size === 0) return items;
  return items.filter((item) =>
    !(item.source === "github" && !item.ticket && item.url && linkedUrls.has(item.url)),
  );
}

async function asanaActivityForDay(date) {
  const out = [];
  const config = loadConfig();
  if (!config.asana?.workspace?.gid || !config.asana?.project?.gid || !config.asana?.user?.gid) {
    return out;
  }
  try {
    const tasks = await searchTasks({
      workspace: config.asana.workspace.gid,
      "assignee.any": config.asana.user.gid,
      "projects.any": config.asana.project.gid,
      completed: "true",
      completed_on: date,
      opt_fields:
        "gid,name,completed,permalink_url,custom_fields.name,custom_fields.display_value",
      limit: "50",
    });
    for (const task of tasks) {
      const ticket = (task.custom_fields || []).find(
        (field) => field.gid === config.asana?.customFields?.ticket?.gid ||
          field.name === config.ticket?.customFieldName,
      )?.display_value;
      out.push({
        source: "asana",
        kind: "task",
        verb: "completed",
        ticket,
        title: task.name,
        summary: task.name,
        url: task.permalink_url,
      });
    }
  } catch {
    // Asana is optional for daily output.
  }
  return out;
}

function collectPRState() {
  try {
    return collectPRActivity({ mode: "my" });
  } catch {
    return null;
  }
}

function prQueueActivity(state) {
  const out = [];
  if (!state) return out;
  try {
    const groups = classifyMyPRs(state);
    for (const entry of groups.readyToMerge) {
      out.push({
        source: "pr-queue",
        kind: "pr",
        verb: "updated",
        pr: entry.pr.number,
        repo: state.repo,
        title: entry.pr.title,
        summary: `ready to merge: ${entry.pr.title}`,
        url: entry.pr.url,
      });
    }
    for (const entry of [...groups.needsReReview, ...groups.awaitingReview]) {
      out.push({
        source: "pr-queue",
        kind: "pr",
        verb: "updated",
        pr: entry.pr.number,
        repo: state.repo,
        title: entry.pr.title,
        summary: `awaiting review: ${entry.pr.title}`,
        url: entry.pr.url,
      });
    }
  } catch {
    // PR queue context is useful but not required for EOD output.
  }
  return out;
}

async function main() {
  const date = readArg("--date") || todayKey();
  const tomorrow = readArg("--tomorrow");
  const blockers = readArg("--blockers");
  const skipUnlinked = process.argv.includes("--skip-unlinked");
  const config = loadConfig();
  const prState = collectPRState();
  const diaries = readDiaryRange({ from: date, to: date });
  const diaryActivities = normalizeDiaryEntries(diaries);
  const githubActivities = await githubActivityForDay(date, config, prState);
  const asanaActivities = await asanaActivityForDay(date);
  const queueActivities = prQueueActivity(prState);
  const allActivities = preferLinkedDiaryActivity(await enrichTickets([
    ...diaryActivities,
    ...githubActivities,
    ...asanaActivities,
    ...queueActivities,
  ], config));
  const unlinked = allActivities.filter(
    (item) => !item.ticket && !item.pr && !item.issue && !item.url,
  );
  if (unlinked.length > 0 && !skipUnlinked) {
    console.error("Unlinked activity needs ticket/PR mapping before finalizing:");
    for (const item of unlinked.slice(0, 10)) {
      console.error(`- ${item.title || item.summary}`);
    }
  }
  const groups = groupActivities([
    ...(skipUnlinked
      ? allActivities.filter((item) => item.ticket || item.pr || item.issue || item.url)
      : allActivities),
  ]);
  const output = renderDailyUpdate(groups, {
    dateLabel: dateLabel(new Date(`${date}T12:00:00`)),
    tomorrow,
    blockers,
  });
  console.log(output);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
