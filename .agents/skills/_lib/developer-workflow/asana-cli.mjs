#!/usr/bin/env node

import {
  addTaskComment,
  completeTask,
  findTaskByTicket,
  getTask,
  moveTaskToSection,
  setTaskStatus,
  validateAsanaConfig,
} from "./asana.mjs";
import { loadConfig } from "./config.mjs";

function usage() {
  console.log(`Usage:
  node asana-cli.mjs status
  node asana-cli.mjs find <ticket>
  node asana-cli.mjs task <task-gid>
  node asana-cli.mjs move <ticket-or-task-gid> <inProgress|inReview|blocked|completed|backlog|todo|bugs|closed>
  node asana-cli.mjs comment <ticket-or-task-gid> <comment text>
  node asana-cli.mjs complete <ticket-or-task-gid>

Common flows:
  Start work:  node asana-cli.mjs move QVAC-12345 inProgress
  PR opened:   node asana-cli.mjs move QVAC-12345 inReview
               node asana-cli.mjs comment QVAC-12345 "PR opened: <url>"
  Blocked:     node asana-cli.mjs move QVAC-12345 blocked
  Done:        node asana-cli.mjs complete QVAC-12345

Mutating commands should be shown to the user and confirmed before running.
`);
}

async function resolveTask(config, value) {
  if (!value) throw new Error("Missing ticket or task gid");
  if (/^\d+$/.test(value)) return getTask(value);
  const task = await findTaskByTicket(config, value);
  if (!task) throw new Error(`No Asana task found for ${value}`);
  return task;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const config = loadConfig({ requireFile: true });

  switch (command) {
    case "status": {
      const result = await validateAsanaConfig(config);
      printJson(result);
      return;
    }
    case "find": {
      const task = await findTaskByTicket(config, args[0]);
      printJson(task || { found: false, ticket: args[0] });
      return;
    }
    case "task": {
      printJson(await getTask(args[0]));
      return;
    }
    case "move": {
      const task = await resolveTask(config, args[0]);
      let result;
      let mode;
      if (config.asana?.statusOptions?.[args[1]]) {
        result = await setTaskStatus(task.gid, args[1], config);
        mode = "statusField";
      } else {
        const section = config.asana?.sections?.[args[1]];
        if (!section?.gid) throw new Error(`Unknown configured section/status: ${args[1]}`);
        result = await moveTaskToSection(task.gid, section.gid);
        mode = "section";
      }
      printJson({ moved: true, task: task.gid, target: args[1], mode, result });
      return;
    }
    case "comment": {
      const task = await resolveTask(config, args[0]);
      const text = args.slice(1).join(" ");
      if (!text) throw new Error("Missing comment text");
      const result = await addTaskComment(task.gid, text);
      printJson({ commented: true, task: task.gid, result });
      return;
    }
    case "complete": {
      const task = await resolveTask(config, args[0]);
      const completed = await completeTask(task.gid, true);
      const statusOption = config.asana?.statusOptions?.completed;
      let statusResult = null;
      if (statusOption?.gid) {
        statusResult = await setTaskStatus(task.gid, "completed", config);
      }
      const section = statusResult ? null : config.asana?.sections?.completed;
      let moved = null;
      if (section?.gid) moved = await moveTaskToSection(task.gid, section.gid);
      printJson({
        completed: true,
        task: task.gid,
        completedResult: completed,
        statusResult,
        movedResult: moved,
      });
      return;
    }
    default:
      usage();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
