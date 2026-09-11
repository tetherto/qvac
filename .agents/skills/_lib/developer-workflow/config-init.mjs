#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import {
  CONFIG_FILE,
  DEFAULT_DIARY_DIR,
  ensureConfigDir,
  loadConfig,
  loadRawConfig,
  normalizeConfig,
  saveConfig,
  validateConfig,
} from "./config.mjs";
import { getMe, validateAsanaConfig } from "./asana.mjs";

const ALLOWED_IMPORT_TOP_LEVEL = new Set([
  "github",
  "ticket",
  "asana",
  "slack",
  "watchedDependencies",
]);
const ALLOWED_ASANA_IMPORT_KEYS = new Set([
  "workspace",
  "project",
  "customFields",
  "statusOptions",
  "sections",
]);

function readArg(name) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? null : process.argv[idx + 1];
}

function usage() {
  console.log(`Usage:
  node config-init.mjs --empty
  node config-init.mjs --import-asana-config <path>
  node config-init.mjs --discover-asana
  node config-init.mjs --validate
`);
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function mergeObject(base, patch) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === "object" &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergeObject(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function emptyConfig() {
  return normalizeConfig({
    github: { defaultRemote: "upstream", staleDays: 3 },
    asana: {
      tokenEnv: "ASANA_ACCESS_TOKEN",
      tokenShellFallback: true,
    },
    slack: { statusChannel: null },
    diary: { dir: DEFAULT_DIARY_DIR, enabled: false },
    watchedDependencies: [],
  });
}

export function assertAllowedAsanaImport(imported) {
  for (const key of Object.keys(imported)) {
    if (!ALLOWED_IMPORT_TOP_LEVEL.has(key)) {
      throw new Error(`Import contains unsupported top-level key: ${key}`);
    }
  }
  if (imported.asana) {
    for (const key of Object.keys(imported.asana)) {
      if (!ALLOWED_ASANA_IMPORT_KEYS.has(key)) {
        throw new Error(`Import must not contain asana.${key}`);
      }
    }
  }
  if (imported.slack?.statusChannel) {
    throw new Error("Import must not contain a non-null slack.statusChannel");
  }
  const serialized = JSON.stringify(imported);
  if (/(\"(?:ASANA_ACCESS_TOKEN|tokenEnv|tokenShellFallback|email|user)\"\s*:)|(\.env\b)/.test(serialized)) {
    throw new Error("Import appears to contain token, .env, email, or asana.user data");
  }
}

export function importAsanaConfig(path, { existing = loadRawConfig(CONFIG_FILE) } = {}) {
  const imported = JSON.parse(readFileSync(path, "utf-8"));
  assertAllowedAsanaImport(imported);
  const next = normalizeConfig(mergeObject(existing, imported));
  saveConfig(next);
  return next;
}

export async function discoverAsanaUser(config = loadConfig()) {
  const me = await getMe();
  const next = normalizeConfig({
    ...config,
    asana: {
      ...(config.asana || {}),
      user: {
        gid: me.gid,
        name: me.name,
        ...(me.email ? { email: me.email } : {}),
      },
    },
  });
  saveConfig(next);
  return next.asana.user;
}

export async function validateLocalConfig({ requireAsana = false } = {}) {
  const config = loadConfig({ requireFile: true });
  const errors = validateConfig(config, { requireAsana });
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  const tokenEnv = config.asana?.tokenEnv || "ASANA_ACCESS_TOKEN";
  if (requireAsana || (config.asana?.workspace?.gid && process.env[tokenEnv])) {
    await validateAsanaConfig(config);
  }
  return config;
}

async function main() {
  ensureConfigDir();

  if (process.argv.includes("--empty")) {
    if (existsSync(CONFIG_FILE)) {
      console.log(`Config already exists: ${CONFIG_FILE}`);
      return;
    }
    saveConfig(emptyConfig());
    console.log(`Created local config: ${CONFIG_FILE}`);
    return;
  }

  const importPath = readArg("--import-asana-config");
  if (importPath) {
    const next = importAsanaConfig(importPath);
    try {
      const user = await discoverAsanaUser(next);
      console.log(`Discovered Asana user: ${user.name || user.gid}`);
    } catch (e) {
      console.error(`Asana user discovery skipped/failed: ${e.message}`);
    }
    console.log(`Imported shared Asana config into ${CONFIG_FILE}`);
    return;
  }

  if (process.argv.includes("--discover-asana")) {
    const user = await discoverAsanaUser();
    console.log(JSON.stringify({ user }, null, 2));
    return;
  }

  if (process.argv.includes("--validate")) {
    await validateLocalConfig({ requireAsana: process.argv.includes("--asana") });
    console.log("Config OK");
    return;
  }

  // Allow `node config-init.mjs /path/to/asanaconfig.json` as a shorthand.
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  if (positional) {
    const next = importAsanaConfig(positional);
    try {
      const user = await discoverAsanaUser(next);
      console.log(`Discovered Asana user: ${user.name || user.gid}`);
    } catch (e) {
      console.error(`Asana user discovery skipped/failed: ${e.message}`);
    }
    console.log(`Imported shared Asana config into ${CONFIG_FILE}`);
    return;
  }

  usage();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fail(e.message || e));
}
