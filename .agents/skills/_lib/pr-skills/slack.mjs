// Per-user Slack handle map for the pr-skills shared library.
//
// File: ~/.config/qvac-pr-skills/slack.json
// Schema:
//   {
//     "map": { "<github-login>": "<slack-handle>" },
//     "pendingReview": ["<github-login>", ...]
//   }
//
// `pendingReview` is a list of logins the agent still needs to confirm with
// the user. The script (the producer) appends to it whenever it auto-fills a
// new entry. The skill workflow (the consumer) presents pending entries to
// the user and clears the list once corrections have been applied.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SLACK_DIR = join(homedir(), ".config", "qvac-pr-skills");
export const SLACK_FILE = join(SLACK_DIR, "slack.json");

function emptyState() {
  return { map: {}, pendingReview: [] };
}

export function loadSlackMap() {
  if (!existsSync(SLACK_FILE)) {
    return { state: emptyState(), exists: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(SLACK_FILE, "utf-8"));
    const state = {
      map: parsed.map && typeof parsed.map === "object" ? { ...parsed.map } : {},
      pendingReview: Array.isArray(parsed.pendingReview)
        ? [...parsed.pendingReview]
        : [],
    };
    return { state, exists: true };
  } catch (e) {
    console.error(`Error reading ${SLACK_FILE}: ${e.message}`);
    return { state: emptyState(), exists: false };
  }
}

function fetchGitHubName(login) {
  try {
    const out = execFileSync(
      "gh",
      ["api", `users/${login}`, "--jq", ".name // \"\""],
      { encoding: "utf-8" },
    );
    return out.trim();
  } catch {
    return "";
  }
}

// For each login in `allLogins` not present in `state.map`, fetch the
// GitHub display name and seed the entry with `@<name>` (or `@<login>` if
// the user has no name). Newly seeded logins are appended to
// `state.pendingReview` so the agent can confirm them with the user.
export function bootstrapMissing(state, allLogins) {
  const addedLogins = [];
  const pendingSet = new Set(state.pendingReview);
  for (const login of allLogins) {
    if (Object.prototype.hasOwnProperty.call(state.map, login)) continue;
    const name = fetchGitHubName(login);
    state.map[login] = name ? `@${name}` : `@${login}`;
    if (!pendingSet.has(login)) {
      pendingSet.add(login);
      state.pendingReview.push(login);
    }
    addedLogins.push(login);
  }
  return { state, addedLogins };
}

export function saveSlackMap(state) {
  if (!existsSync(SLACK_DIR)) {
    mkdirSync(SLACK_DIR, { recursive: true });
  }
  const tmp = `${SLACK_FILE}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, SLACK_FILE);
}
