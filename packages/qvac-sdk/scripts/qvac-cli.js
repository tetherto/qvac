#!/usr/bin/env node
/**
 * QVAC CLI - Entry point for npx qvac commands
 *
 * Usage:
 *   npx qvac bundle sdk [options]
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);

function printHelp() {
  console.log(`
QVAC CLI

Usage:
  npx qvac <command> [options]

Commands:
  bundle sdk    Bundle the SDK worker with selected plugins

Run 'npx qvac <command> --help' for more info on a specific command.
`);
}

async function main() {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  const command = args[0];
  const subCommand = args[1];
  const restArgs = args.slice(2);

  if (command === "bundle" && subCommand === "sdk") {
    // Run the bundle-sdk script
    const bundleSdkPath = path.join(__dirname, "bundle-sdk.js");
    const proc = spawn(process.execPath, [bundleSdkPath, ...restArgs], {
      stdio: "inherit",
      cwd: process.cwd(),
    });

    proc.on("close", (code) => {
      process.exit(code || 0);
    });

    proc.on("error", (err) => {
      console.error("Failed to run bundle-sdk:", err.message);
      process.exit(1);
    });
  } else {
    console.error(`Unknown command: ${command} ${subCommand || ""}`);
    printHelp();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
