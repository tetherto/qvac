/**
 * Bare Runtime Bootstrap
 * Usage:
 *   bare ./scripts/bare-bootstrap.js dist/examples/your-example.js [args...]
 *
 * Or with the npm script:
 *   bun run bare:example dist/examples/your-example.js [args...]
 */

import Module from "bare-module";
import path from "bare-path";
import fs from "bare-fs";
import os from "bare-os";
import env from "bare-env";
import io from "bare-stdio";
import Signal from "bare-signals";
import { pathToFileURL } from "bare-url";

const targetScript = Bare.argv[2];

if (!targetScript) {
  console.error(
    "Usage: bare ./scripts/bare-bootstrap.js <script.js> [args...]",
  );
  Bare.exit(1);
}

// Give the Node-style example scripts a `process` global. argv is shifted so
// they see their own args (not the bootstrap path); SIGINT/SIGTERM route
// through bare-signals and other events (e.g. "exit") through the Bare global.
const signals = new Signal.Emitter();
signals.unref();

globalThis.process = {
  argv: [Bare.argv[0], ...Bare.argv.slice(2)],
  env,
  platform: os.platform(),
  stdin: io.in,
  stdout: io.out,
  stderr: io.err,
  cwd: () => os.cwd(),
  exit: (code) => Bare.exit(code),
  on(event, listener) {
    if (event === "SIGINT" || event === "SIGTERM") signals.on(event, listener);
    else Bare.on(event, listener);
    return this;
  },
};

// Load import maps from bare-imports.json
const bareImportsPath = path.join(os.cwd(), "bare-imports.json");
const bareImports = JSON.parse(fs.readFileSync(bareImportsPath, "utf-8"));

// This harness only runs the bundled examples, which stay registration-free
// so one file works on Node, Expo, and Bare. Bare runs in-process with no
// spawned worker, so nothing auto-registers — load the default worker to
// register the full built-in set. This is deliberately the @qvac/sdk "full
// defaults" path, not a usage reference; explicit/selective assembly is
// @qvac/bare-sdk's model. initializeWorkerCore is idempotent, so the example's
// getRPC() is fine.
const workerEntry = path.resolve(os.cwd(), "dist/server/worker.js");
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

const absolutePath = path.resolve(os.cwd(), targetScript);
const scriptUrl = pathToFileURL(absolutePath);

try {
  Module.load(scriptUrl, null, {
    imports: bareImports,
    conditions: ["bare", "import"],
  });
} catch (err) {
  console.error("Failed to load script:", err);
  Bare.exit(1);
}
