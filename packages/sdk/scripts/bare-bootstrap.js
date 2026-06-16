/**
 * Bare Runtime Bootstrap
 * Usage:
 *   bare ./scripts/bare-bootstrap.js dist/examples/your-example.js [args...]
 *
 * Or with the npm script:
 *   bun run bare:example dist/examples/your-example.js [args...]
 */

import Module from "bare-module";
import process from "bare-process";
import path from "bare-path";
import fs from "bare-fs";
import { pathToFileURL } from "bare-url";

const targetScript = process.argv[2];

if (!targetScript) {
  console.error(
    "Usage: bare ./scripts/bare-bootstrap.js <script.js> [args...]",
  );
  process.exit(1);
}

// Proxy argv to shift out bootstrap.js so target scripts see correct args
globalThis.process = new Proxy(process, {
  get(target, prop) {
    if (prop === "argv") {
      return [target.argv[0], ...target.argv.slice(2)];
    }
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  },
});

// Polyfill stdout.write for Bare
if (!process.stdout.write) {
  process.stdout.write = (data) => {
    const output = String(data).replace(/\n$/, "");
    if (output) console.log(output);
    return true;
  };
}

// Load import maps from bare-imports.json
const bareImportsPath = path.join(process.cwd(), "bare-imports.json");
const bareImports = JSON.parse(fs.readFileSync(bareImportsPath, "utf-8"));

// Bare runs in-process with no spawned worker, so nothing auto-registers
// plugins like Node/Expo do. Load the worker entry to register the built-in
// set; initializeWorkerCore is idempotent, so the example's getRPC() is fine.
const workerEntry = path.resolve(process.cwd(), "dist/server/worker.js");
if (fs.existsSync(workerEntry)) {
  Module.load(pathToFileURL(workerEntry), null, {
    imports: bareImports,
    conditions: ["bare", "import"],
  });
} else {
  console.warn(
    `[bare-bootstrap] default worker entry not found at ${workerEntry}; ` +
      "examples that make SDK calls will fail to register plugins. " +
      "Run `bun run build` first.",
  );
}

const absolutePath = path.resolve(process.cwd(), targetScript);
const scriptUrl = pathToFileURL(absolutePath);

try {
  Module.load(scriptUrl, null, {
    imports: bareImports,
    conditions: ["bare", "import"],
  });
} catch (err) {
  console.error("Failed to load script:", err);
  process.exit(1);
}
