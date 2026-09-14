import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  ensureConfigDir,
  hasDiaryEnabledMarker,
  isDiaryEnabled,
  loadConfig,
} from "./config.mjs";

function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function time24(date = new Date()) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

function dayHeader(date = new Date()) {
  return `# Dev Diary - ${date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  })}\n\n`;
}

function diaryPath(config, date = new Date()) {
  return join(config.diary.dir, `${localDate(date)}.md`);
}

function indexPath(config) {
  return join(config.diary.dir, ".index.json");
}

function loadIndex(config) {
  const path = indexPath(config);
  if (!existsSync(path)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

function saveIndex(config, index) {
  const path = indexPath(config);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`);
  renameSync(tmp, path);
}

function entryKey(entry) {
  return [
    entry.date || localDate(),
    entry.type || "other",
    entry.ticket || "",
    entry.pr || "",
    entry.title || "",
    entry.status || "",
  ].join("|");
}

function previousDiaryPath(config, date = new Date()) {
  if (!existsSync(config.diary.dir)) return null;
  const today = localDate(date);
  const files = readdirSync(config.diary.dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && f < `${today}.md`)
    .sort();
  const last = files.at(-1);
  return last ? join(config.diary.dir, last) : null;
}

function carryoverBlock(config, date = new Date()) {
  const previous = previousDiaryPath(config, date);
  if (!previous) return "";
  const text = readFileSync(previous, "utf-8");
  const matches = [...text.matchAll(/## [^\n]+\n\n([\s\S]*?)(?=\n## |\n?$)/g)];
  const items = [];
  for (const match of matches) {
    const block = match[0];
    if (!/- \*\*status\*\*: (wip|blocked)/.test(block)) continue;
    const title = block.match(/^## \d{2}:\d{2} - (.+)$/m)?.[1];
    if (!title) continue;
    const ticket = block.match(/- \*\*ticket\*\*: (.+)$/m)?.[1];
    const pr = block.match(/- \*\*pr\*\*: (.+)$/m)?.[1];
    items.push({ title, ticket, pr, since: basename(previous, ".md") });
  }
  if (items.length === 0) return "";
  const lines = ["## Carried Over", ""];
  for (const item of items) {
    lines.push(`- [ ] ${item.title}`);
    if (item.ticket) lines.push(`  - **ticket**: ${item.ticket}`);
    if (item.pr) lines.push(`  - **pr**: ${item.pr}`);
    lines.push(`  - **since**: ${item.since}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function ensureDiaryFile(config = loadConfig(), date = new Date()) {
  mkdirSync(config.diary.dir, { recursive: true });
  const path = diaryPath(config, date);
  if (!existsSync(path)) {
    writeFileSync(path, dayHeader(date) + carryoverBlock(config, date));
  }
  return path;
}

export function appendDiaryEntry(entry, { force = false } = {}) {
  ensureConfigDir();
  const config = loadConfig();
  if (!force && !isDiaryEnabled(config) && !hasDiaryEnabledMarker()) {
    return { appended: false, reason: "diary disabled" };
  }
  const now = entry.date ? new Date(entry.date) : new Date();
  const date = localDate(now);
  const normalized = {
    type: "other",
    status: "done",
    ...entry,
    date,
  };
  const index = loadIndex(config);
  const key = entryKey(normalized);
  if (index.entries?.[key]) {
    return { appended: false, reason: "duplicate", key };
  }
  const path = ensureDiaryFile(config, now);
  const lines = [
    `## ${time24(now)} - ${normalized.title || "Work activity"}`,
    "",
    normalized.summary || "Work activity logged.",
    "",
    `- **type**: ${normalized.type}`,
  ];
  if (normalized.verb) lines.push(`- **verb**: ${normalized.verb}`);
  if (normalized.ticket) lines.push(`- **ticket**: ${normalized.ticket}`);
  if (normalized.pr) lines.push(`- **pr**: ${normalized.pr}`);
  if (normalized.url) lines.push(`- **url**: ${normalized.url}`);
  if (normalized.urlLabel) lines.push(`- **urlLabel**: ${normalized.urlLabel}`);
  lines.push(`- **status**: ${normalized.status}`);
  if (normalized.blocker) lines.push(`- **blocker**: ${normalized.blocker}`);
  lines.push("");
  writeFileSync(path, `${readFileSync(path, "utf-8").trimEnd()}\n\n${lines.join("\n")}`);
  index.entries = { ...(index.entries || {}), [key]: { path, loggedAt: new Date().toISOString() } };
  saveIndex(config, index);
  return { appended: true, path, key };
}

export function readDiaryRange({ from, to } = {}) {
  const config = loadConfig();
  if (!existsSync(config.diary.dir)) return [];
  const fromKey = from || "0000-00-00";
  const toKey = to || "9999-99-99";
  return readdirSync(config.diary.dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((file) => ({ date: basename(file, ".md"), path: join(config.diary.dir, file) }))
    .filter((file) => file.date >= fromKey && file.date <= toKey)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((file) => ({ ...file, text: readFileSync(file.path, "utf-8") }));
}

export function diaryStatus() {
  const config = loadConfig();
  return {
    enabled: isDiaryEnabled(config),
    enabledMarker: hasDiaryEnabledMarker(),
    dir: config.diary.dir,
    exists: existsSync(config.diary.dir),
  };
}
