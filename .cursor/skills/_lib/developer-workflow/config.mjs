import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CONFIG_DIR = join(homedir(), ".config", "qvac-pr-skills");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const DIARY_ENABLED_FILE = join(CONFIG_DIR, "diary.enabled");
export const DEFAULT_TOKEN_ENV = "ASANA_ACCESS_TOKEN";
export const DEFAULT_DIARY_DIR = join(CONFIG_DIR, "diary");
export const DEFAULT_STALE_DAYS = 3;

export function expandHome(path) {
  if (!path || typeof path !== "string") return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadRawConfig(path = CONFIG_FILE) {
  if (!existsSync(path)) {
    return {};
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function saveConfig(config, path = CONFIG_FILE) {
  ensureConfigDir();
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, path);
}

function repoFromRemote() {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "upstream"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match =
      remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/) ||
      remote.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function normalizeConfig(raw = {}) {
  const config = {
    ...raw,
    github: { ...(raw.github || {}) },
    ticket: { ...(raw.ticket || {}) },
    asana: { ...(raw.asana || {}) },
    slack: { ...(raw.slack || {}) },
    diary: { ...(raw.diary || {}) },
    watchedDependencies: Array.isArray(raw.watchedDependencies)
      ? raw.watchedDependencies
      : [],
  };

  if (!config.github.defaultRemote) config.github.defaultRemote = "upstream";
  if (!config.github.staleDays) config.github.staleDays = DEFAULT_STALE_DAYS;
  if (!config.github.repo) config.github.repo = repoFromRemote();

  if (!config.asana.tokenEnv) config.asana.tokenEnv = DEFAULT_TOKEN_ENV;
  if (!Object.prototype.hasOwnProperty.call(config.asana, "tokenShellFallback")) {
    config.asana.tokenShellFallback = true;
  }
  if (!config.slack || typeof config.slack !== "object") config.slack = {};
  if (!Object.prototype.hasOwnProperty.call(config.slack, "statusChannel")) {
    config.slack.statusChannel = null;
  }
  if (!config.diary.dir) config.diary.dir = DEFAULT_DIARY_DIR;
  config.diary.dir = resolve(expandHome(config.diary.dir));

  return config;
}

export function loadConfig({ requireFile = false } = {}) {
  if (requireFile && !existsSync(CONFIG_FILE)) {
    throw new Error(`Local config not found: ${CONFIG_FILE}`);
  }
  return normalizeConfig(loadRawConfig(CONFIG_FILE));
}

export function splitRepo(repo) {
  if (!repo || typeof repo !== "string" || !repo.includes("/")) {
    throw new Error("GitHub repo is not configured as owner/name");
  }
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) {
    throw new Error("GitHub repo is not configured as owner/name");
  }
  return { owner, name, repo: `${owner}/${name}` };
}

function requireGid(value, label, errors) {
  if (!value?.gid) errors.push(`${label}.gid is required`);
}

export function validateConfig(config, { requireAsana = false } = {}) {
  const errors = [];
  if (!config.github?.repo) errors.push("github.repo is required");
  if (config.github?.repo && !/^[^/]+\/[^/]+$/.test(config.github.repo)) {
    errors.push("github.repo must be owner/name");
  }
  if (!config.diary?.dir) errors.push("diary.dir is required");

  if (requireAsana) {
    requireGid(config.asana?.workspace, "asana.workspace", errors);
    requireGid(config.asana?.project, "asana.project", errors);
    requireGid(config.asana?.sections?.inProgress, "asana.sections.inProgress", errors);
    requireGid(config.asana?.sections?.inReview, "asana.sections.inReview", errors);
    requireGid(config.asana?.sections?.blocked, "asana.sections.blocked", errors);
    requireGid(config.asana?.sections?.completed, "asana.sections.completed", errors);
    if (!config.asana?.customFields?.ticket?.gid && !config.ticket?.pattern) {
      errors.push("asana.customFields.ticket.gid or ticket.pattern is required");
    }
  }

  return errors;
}

export function hasDiaryEnabledMarker() {
  return existsSync(DIARY_ENABLED_FILE);
}

export function isDiaryEnabled(config = loadConfig()) {
  return Boolean(config.diary?.enabled || hasDiaryEnabledMarker());
}

export function setDiaryEnabled(enabled, config = loadConfig()) {
  ensureConfigDir();
  if (enabled) {
    writeFileSync(DIARY_ENABLED_FILE, `${new Date().toISOString()}\n`);
  } else if (existsSync(DIARY_ENABLED_FILE)) {
    try {
      unlinkSync(DIARY_ENABLED_FILE);
    } catch {
      // best effort; config flag still controls behavior
    }
  }
  config.diary = { ...(config.diary || {}), enabled };
  saveConfig(config);
}

export function configPath(...parts) {
  return join(CONFIG_DIR, ...parts);
}

export function ensureParent(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
