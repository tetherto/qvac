#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_DIARY_DIR,
  ensureConfigDir,
  loadConfig,
  saveConfig,
  setDiaryEnabled,
  validateConfig,
} from "./config.mjs";
import {
  discoverAsanaUser,
  emptyConfig,
  importAsanaConfig,
  validateLocalConfig,
} from "./config-init.mjs";
import { appendDiaryEntry, diaryStatus, ensureDiaryFile } from "./diary.mjs";

const TEMPLATE = new URL("./templates/dev-diary.local-rule.mdc", import.meta.url);

function asanaTokenInstructions() {
  return `Asana token setup:

1. Open Asana developer console:
   https://app.asana.com/0/my-apps

2. Create a Personal Access Token.
   Description suggestion: Cursor local qvac-pr-skills

3. Permission model: Asana Personal Access Tokens do not require choosing
   scopes in this setup. The token acts as your Asana user and can access
   whatever that user can access. For diary/status enrichment, the user must be
   able to read the workspace/project/tasks. For sync actions, the user must
   also be allowed to comment, move, and complete tasks in that project.

4. No special OAuth app or MCP server is needed. This local workflow uses the
   token as your user against the Asana REST API.

5. Store it in your default shell startup file or export it in the current
   shell. Cursor agents may not inherit the app environment, so the helper
   falls back to asking your default shell for this variable:

   export ASANA_ACCESS_TOKEN='<token>'

6. Verify it:
   curl https://app.asana.com/api/1.0/users/me \\
     -H "Authorization: Bearer $ASANA_ACCESS_TOKEN"

Docs: https://developers.asana.com/docs/personal-access-token`;
}

function usage() {
  console.log(`Usage:
  node diary-cli.mjs --init [--basic|--asana] [asanaconfig.json]
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

function positionalArgs() {
  return process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
}

function dateArgAfter(flag) {
  const idx = process.argv.indexOf(flag);
  const value = idx === -1 ? null : process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function initDiary() {
  ensureConfigDir();
  let config = existsSync(CONFIG_FILE) ? loadConfig() : emptyConfig();
  if (!existsSync(CONFIG_FILE)) saveConfig(config);

  const asanaConfig = positionalArgs()[0] || null;
  if (asanaConfig) {
    config = importAsanaConfig(asanaConfig, { existing: config });
  }

  const wantsAsana = Boolean(asanaConfig || process.argv.includes("--asana"));
  if (wantsAsana) {
    console.log(asanaTokenInstructions());
    console.log("");
    try {
      await discoverAsanaUser(config);
      await validateLocalConfig({ requireAsana: true });
    } catch (e) {
      const message = e.message || String(e);
      const suffix = /token missing/i.test(message)
        ? "\n\nCreate/export the Asana token above, then rerun this command."
        : "\n\nFix the Asana config/access issue above, then rerun this command.";
      throw new Error(`${message}${suffix}`);
    }
    config = loadConfig();
  } else {
    const errors = validateConfig(config, { requireAsana: false });
    if (errors.length > 0) throw new Error(errors.join("\n"));
  }

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
    await validateLocalConfig({ requireAsana: false });
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
