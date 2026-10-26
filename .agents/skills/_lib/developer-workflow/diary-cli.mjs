#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_FILE,
  DEFAULT_DIARY_DIR,
  ensureConfigDir,
  loadConfig,
  saveConfig,
  setDiaryEnabled,
  validateConfig,
} from "./config.mjs";
import { emptyConfig, validateLocalConfig } from "./config-init.mjs";
import { appendDiaryEntry, diaryStatus, ensureDiaryFile } from "./diary.mjs";

const TEMPLATE = new URL("./templates/dev-diary.local-rule.mdc", import.meta.url);

function usage() {
  console.log(`Usage:
  node diary-cli.mjs --init [--basic]
  node diary-cli.mjs --status
  node diary-cli.mjs --path [YYYY-MM-DD]
  node diary-cli.mjs --read [YYYY-MM-DD]
  node diary-cli.mjs --on
  node diary-cli.mjs --off
  node diary-cli.mjs --append '<json-entry>'
`);
}

function localRuleDir() {
  return join(process.env.HOME, ".cursor", "rules");
}

function installLocalRule() {
  const dir = localRuleDir();
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "dev-diary-local.mdc");
  const template = readFileSync(TEMPLATE, "utf-8");
  if (!existsSync(target)) {
    writeFileSync(target, template);
    return { installed: true, path: target };
  }
  return { installed: false, path: target };
}

function dateArgAfter(flag) {
  const idx = process.argv.indexOf(flag);
  const value = idx === -1 ? null : process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function initDiary() {
  ensureConfigDir();
  const config = existsSync(CONFIG_FILE) ? loadConfig() : emptyConfig();
  const errors = validateConfig(config);
  if (errors.length > 0) throw new Error(errors.join("\n"));

  config.diary = { ...(config.diary || {}), dir: config.diary?.dir || DEFAULT_DIARY_DIR };
  mkdirSync(config.diary.dir, { recursive: true });
  saveConfig(config);
  const rule = installLocalRule();
  ensureDiaryFile(config);
  setDiaryEnabled(true, config);
  console.log(`Diary enabled: ${config.diary.dir}`);
  console.log(`${rule.installed ? "Installed" : "Verified"} local rule: ${rule.path}`);
}

async function main() {
  const args = process.argv.slice(2);
  const allowedFlags = new Set([
    "--init", "--basic", "--status", "--path", "--read", "--on", "--off", "--append",
  ]);
  if (args.some((arg) => arg.startsWith("--") && !allowedFlags.has(arg))) {
    throw new Error("Unsupported argument. Only local diary operations are supported.");
  }
  if (args.includes("--init") && args.some((arg) => !["--init", "--basic"].includes(arg))) {
    throw new Error("Diary initialization accepts only --init and --basic.");
  }
  if (process.argv.includes("--status")) {
    console.log(JSON.stringify(diaryStatus(), null, 2));
    return;
  }
  if (process.argv.includes("--path")) {
    const { loadConfig } = await import("./config.mjs");
    const { join } = await import("node:path");
    const date = dateArgAfter("--path") || new Date().toISOString().slice(0, 10);
    console.log(join(loadConfig().diary.dir, `${date}.md`));
    return;
  }
  if (process.argv.includes("--read")) {
    const { readDiaryRange } = await import("./diary.mjs");
    const date = dateArgAfter("--read") || new Date().toISOString().slice(0, 10);
    const entries = readDiaryRange({ from: date, to: date });
    if (entries[0]) console.log(entries[0].text);
    else console.log(`No diary file for ${date}`);
    return;
  }
  if (process.argv.includes("--off")) {
    setDiaryEnabled(false);
    console.log("Diary disabled");
    return;
  }
  if (process.argv.includes("--on")) {
    await validateLocalConfig();
    setDiaryEnabled(true);
    console.log("Diary enabled");
    return;
  }
  const appendJson = process.argv.includes("--append")
    ? process.argv[process.argv.indexOf("--append") + 1]
    : null;
  if (appendJson) {
    console.log(JSON.stringify(appendDiaryEntry(JSON.parse(appendJson)), null, 2));
    return;
  }
  if (process.argv.includes("--init")) {
    await initDiary();
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
