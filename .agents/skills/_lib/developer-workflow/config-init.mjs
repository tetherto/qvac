#!/usr/bin/env node

import { existsSync } from "node:fs";
import {
  CONFIG_FILE,
  DEFAULT_DIARY_DIR,
  ensureConfigDir,
  loadConfig,
  normalizeConfig,
  saveConfig,
  validateConfig,
} from "./config.mjs";

function usage() {
  console.log(`Usage:
  node config-init.mjs --empty
  node config-init.mjs --validate
`);
}

export function emptyConfig() {
  return normalizeConfig({
    github: { defaultRemote: "upstream", staleDays: 3 },
    slack: { statusChannel: null },
    diary: { dir: DEFAULT_DIARY_DIR, enabled: false },
  });
}

export async function validateLocalConfig() {
  const config = loadConfig({ requireFile: true });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  return config;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--empty", "--validate"].includes(arg))) {
    throw new Error("Unsupported argument. Only local configuration is supported.");
  }
  ensureConfigDir();

  if (args.includes("--empty")) {
    if (existsSync(CONFIG_FILE)) {
      console.log(`Config already exists: ${CONFIG_FILE}`);
      return;
    }
    saveConfig(emptyConfig());
    console.log(`Created local config: ${CONFIG_FILE}`);
    return;
  }

  if (args.includes("--validate")) {
    await validateLocalConfig();
    console.log("Config OK");
    return;
  }

  usage();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  });
}
