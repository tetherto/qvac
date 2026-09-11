const VERB_RANK = {
  updated: 1,
  investigated: 2,
  commented: 3,
  reviewed: 4,
  opened: 4,
  created: 4,
  closed: 5,
  merged: 6,
  completed: 7,
  released: 8,
  "requested changes": 9,
  approved: 10,
};

function strongestVerb(actions) {
  return actions
    .map((action) => action.verb || "updated")
    .sort((a, b) => (VERB_RANK[b] || 0) - (VERB_RANK[a] || 0))[0] || "updated";
}

export function keyForActivity(item) {
  if (item.kind === "review" || item.type === "pr-review") {
    return `review:${item.repo || ""}#${item.pr || item.url || item.title}`;
  }
  if (item.ticket) return `ticket:${item.ticket}`;
  if (item.pr) return `pr:${item.repo || ""}#${item.pr}`;
  if (item.issue) return `issue:${item.repo || ""}#${item.issue}`;
  if (item.url) return `url:${item.url}`;
  return `title:${item.title || item.summary || "unknown"}`;
}

function diaryVerbForType(type) {
  if (type === "investigation") return "investigated";
  return null;
}

export function normalizeDiaryEntries(diaries) {
  const out = [];
  for (const diary of diaries) {
    const blocks = diary.text.split(/\n(?=## \d{2}:\d{2} - )/g);
    for (const block of blocks) {
      const title = block.match(/^## \d{2}:\d{2} - (.+)$/m)?.[1];
      if (!title) continue;
      if (title === "Diary initialized") continue;
      const type = block.match(/- \*\*type\*\*: (.+)$/m)?.[1] || "other";
      out.push({
        source: "diary",
        date: diary.date,
        title,
        summary: block.split("\n\n")[1]?.trim() || title,
        type,
        verb: block.match(/- \*\*verb\*\*: (.+)$/m)?.[1] || diaryVerbForType(type),
        ticket: block.match(/- \*\*ticket\*\*: (.+)$/m)?.[1],
        pr: block.match(/- \*\*pr\*\*: #?(\d+)/m)?.[1],
        url: block.match(/- \*\*url\*\*: (.+)$/m)?.[1],
        urlLabel: block.match(/- \*\*urlLabel\*\*: (.+)$/m)?.[1],
        status: block.match(/- \*\*status\*\*: (.+)$/m)?.[1] || "done",
      });
    }
  }
  return out;
}

export function groupActivities(items) {
  const groups = new Map();
  for (const item of items) {
    const key = keyForActivity(item);
    const group = groups.get(key) || { key, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const verb = strongestVerb(group.items);
    const first = group.items[0] || {};
    return {
      key: group.key,
      refs: refsForGroup(group.items),
      verb,
      title: first.title || first.summary || group.key,
      summary: first.summary || first.title || group.key,
      status: first.status,
      items: group.items,
      section: sectionForGroup(group.items, verb),
    };
  });
}

function refsForGroup(items) {
  const refs = [];
  const seen = new Set();
  const ticketItem = items.find((item) => item.ticket);
  if (ticketItem) {
    const label = ticketLabel(ticketItem);
    refs.push(linkRef(label, ticketItem.ticketUrl));
    seen.add(`ticket:${ticketItem.ticket}`);
  }
  for (const item of items) {
    if (item.pr && !seen.has(`pr:${item.pr}`)) {
      refs.push(linkRef(`#${item.pr}`, item.url));
      seen.add(`pr:${item.pr}`);
    }
    if (item.issue && !seen.has(`issue:${item.issue}`)) {
      refs.push(linkRef(`#${item.issue}`, item.url));
      seen.add(`issue:${item.issue}`);
    }
    if (
      item.url &&
      !item.pr &&
      !item.issue &&
      item.url !== ticketItem?.ticketUrl &&
      !seen.has(`url:${item.url}`)
    ) {
      refs.push(linkRef(item.urlLabel || labelForUrl(item.url), item.url));
      seen.add(`url:${item.url}`);
    }
  }
  return refs;
}

function linkRef(label, url) {
  if (!url) return label;
  return `[${label}](${url})`;
}

function labelForUrl(url) {
  const githubMatch = String(url).match(/github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)/);
  if (githubMatch) return `#${githubMatch[1]}`;
  try {
    return new URL(url).hostname;
  } catch {
    return "link";
  }
}

function sectionForGroup(items, verb) {
  if (items.every((item) => item.type === "pr-review" || item.kind === "review")) {
    return "PR Reviews";
  }
  if (["merged", "completed", "released"].includes(verb)) {
    return "Completed today";
  }
  if (items.some((item) => item.status === "blocked")) {
    return "Notes";
  }
  return "In Progress / Investigated";
}

export function renderDailyUpdate(
  groups,
  {
    dateLabel,
    tomorrow = null,
    blockers = null,
  },
) {
  const bySection = new Map();
  for (const group of groups) {
    const arr = bySection.get(group.section) || [];
    arr.push(group);
    bySection.set(group.section, arr);
  }
  const completed = bySection.get("Completed today") || [];
  const reviews = bySection.get("PR Reviews") || [];
  const inProgress = bySection.get("In Progress / Investigated") || [];
  const doneLines = [
    ...completed.map(renderBullet),
    ...renderReviewSummary(reviews),
    ...inProgress.map(renderBullet),
  ];
  const tomorrowLines = normalizeManualLines(tomorrow, "- TODO: ask user for tomorrow's plan");
  const blockerLines = normalizeManualLines(blockers, "- None");

  const lines = [
    `:hammer: Completed today (${dateLabel})`,
    "",
    ...(doneLines.length > 0 ? doneLines : ["- No recorded activity."]),
    "",
    ":calendar: Planned for tomorrow",
    "",
    ...tomorrowLines,
    "",
    ":construction: Blockers / risks",
    "",
    ...blockerLines,
  ];
  return lines.join("\n").trimEnd();
}

function ticketLabel(item) {
  if (item.ticketTitle) {
    return `${item.ticket}: ${truncate(stripBracketNoise(stripTicketPrefix(item.ticketTitle, item.ticket)), 48)}`;
  }
  if (item.title) {
    return `${item.ticket}: ${truncate(stripBracketNoise(stripTicketPrefix(item.title, item.ticket)), 48)}`;
  }
  return item.ticket;
}

function stripBracketNoise(text) {
  return String(text || "").replace(/^(\[[^\]]+\]\s*)+/, "").trim();
}

function truncate(text, max) {
  const value = String(text || "");
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function stripTicketPrefix(text, ticket) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(new RegExp(`^${escapeRegExp(ticket)}\\s*[-:–—]?\\s*`, "i"), "");
}

function renderReviewSummary(reviews) {
  if (reviews.length === 0) return [];
  const approved = [];
  const other = [];
  for (const review of reviews) {
    const refs = reviewRef(review);
    if (!refs) continue;
    if (review.verb === "approved") approved.push(refs);
    else other.push(refs);
  }
  const lines = [];
  if (approved.length > 0) lines.push(formatOutputBullet(`Approved: ${approved.join(", ")}`));
  if (other.length > 0) {
    lines.push(formatOutputBullet(`Commented / Requested changes: ${other.join(", ")}`));
  }
  return lines;
}

function reviewRef(group) {
  const item = group.items.find((candidate) => candidate.kind === "review") || group.items[0];
  if (!item) return group.refs.join(", ");
  const parts = [];
  if (item.pr) parts.push(linkRef(`#${item.pr}`, item.url));
  if (item.ticket) {
    parts.push(linkRef(ticketLabel(item), item.ticketUrl));
  }
  return parts.length > 0 ? parts.join(" - ") : group.refs.join(", ");
}

function normalizeManualLines(value, fallback) {
  if (!value) return [formatOutputBullet(fallback.replace(/^- /, ""))];
  const lines = String(value)
    .replace(/\\n/g, "\n")
    .split(/\n+|;\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [formatOutputBullet(fallback.replace(/^- /, ""))];
  return lines.map((line) => formatOutputBullet(line.replace(/^- /, "")));
}

function renderBullet(group) {
  if (isCreatedPRForOpenTicket(group)) {
    return renderCreatedPRBullet(group);
  }

  const text = cleanupSummary(group.summary, group);
  const refs = group.refs.length > 0 ? formatRefs(group.refs) : "";
  const body = [group.verb, refs, text].filter(Boolean).join(" ");
  return formatOutputBullet(body.slice(0, 298));
}

function isCreatedPRForOpenTicket(group) {
  return ["created", "opened"].includes(group.verb) &&
    group.items.some((item) => item.ticket) &&
    group.refs.some((ref) => !isPrRef(ref)) &&
    group.refs.some(isPrRef);
}

function renderCreatedPRBullet(group) {
  const ticketRef = group.refs.find((ref) => !isPrRef(ref));
  const prRefs = group.refs.filter(isPrRef);
  const body = [ticketRef, `created ${prRefs.join(", ")}`].filter(Boolean).join(" - ");
  return formatOutputBullet(body.slice(0, 298));
}

function formatRefs(refs) {
  return refs
    .map((ref) => (isPrRef(ref) ? `PR: ${ref}` : ref))
    .join(" - ");
}

function isPrRef(ref) {
  return /^#\d+$/.test(ref) || /^\[#\d+\]\(/.test(ref);
}

function formatOutputBullet(text) {
  return `- ${text}`;
}

function cleanupSummary(summary, group) {
  let text = String(summary || group.title || "").replace(/\s+/g, " ").trim();
  const hasTicketRef = group.refs.some((ref) => !isPrRef(ref));
  const hasPrRef = group.refs.some((ref) => isPrRef(ref));
  if (hasTicketRef && hasPrRef) return "";
  for (const item of group.items) {
    if (item.ticket) {
      text = text.replace(new RegExp(`^${escapeRegExp(item.ticket)}\\s*[-:–—]?\\s*`, "i"), "");
    }
    if (item.pr && item.ticket) {
      text = "";
    }
  }
  return text || group.title || "work item";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
