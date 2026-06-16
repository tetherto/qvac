import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bufferSize = 50 * 1024 * 1024;
const p2pPackages = [
  "corestore",
  "hyperswarm",
  "hyperdrive",
  "hyperdb",
  "hyperblobs",
  "hyperdht",
];
const installArgs = [
  "install",
  "--no-fund",
  "--no-audit",
  "--ignore-scripts",
  "--loglevel=info",
];

function run(command, args, cwd = sdkRoot, quiet = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: bufferSize,
    stdio: "pipe",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (!quiet) process.stdout.write(output);
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(
        `${command} was not found on PATH. Install it before running this check.`,
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}\n${output}`);
  }

  return output;
}

function packSdk() {
  run("bun", ["pm", "pack", "--destination", "dist/"]);
  const tarball = readdirSync(path.join(sdkRoot, "dist"))
    .filter((name) => /^qvac-sdk-.*\.tgz$/.test(name))
    .map((name) => path.join(sdkRoot, "dist", name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

  if (!tarball) throw new Error("No SDK tarball found after pack");
  return tarball;
}

function makeConsumer(label, tarball, extraInstallArgs = []) {
  const dir = mkdtempSync(path.join(tmpdir(), `qvac-sdk-${label}-`));
  run("npm", ["init", "-y"], dir, true);
  run("npm", ["pkg", "set", "type=module"], dir, true);
  const installLog = run("npm", installArgs.concat(extraInstallArgs, tarball), dir);
  writeFileSync(path.join(dir, "install.log"), installLog);

  if (/ERESOLVE|npm warn peer/.test(installLog)) {
    throw new Error(`[${label}] SDK consumer install surfaced peer warnings`);
  }
  console.log(`::notice::[${label}] 0 peer warnings`);

  return dir;
}

function checkDependencyTree(dir, label) {
  for (const packageName of p2pPackages) {
    const tree = run("npm", ["ls", packageName, "--all"], dir, true);
    const copies = tree
      .split("\n")
      .filter((line) => line.includes(`${packageName}@`))
      .filter((line) => !line.includes("deduped")).length;

    if (copies !== 1) {
      throw new Error(
        `[${label}] ${packageName} resolved to ${copies} copies (expected 1)\n${tree}`,
      );
    }
    console.log(`  ok  [${label}] ${packageName} = 1 copy`);
  }
  console.log(
    `::notice::[${label}] Single-copy invariant holds for shared P2P packages`,
  );
}

function checkImport(dir, label) {
  const source = [
    "import('@qvac/sdk')",
    "  .then((m) => {",
    "    const count = Object.keys(m).length;",
    "    if (count < 50) throw new Error(`too few exports: ${count}`);",
    "    console.log('import ok:', count, 'exports');",
    "  })",
    "  .catch((error) => {",
    "    console.error(error instanceof Error ? error.message : String(error));",
    "    process.exit(1);",
    "  });",
  ].join("\n");

  run(
    "node",
    ["-e", source],
    dir,
  );
  console.log(`  ok  [${label}] import('@qvac/sdk')`);
}

function writeRuntimeSmoke(dir) {
  const file = path.join(dir, "qvac-packaged-runtime-smoke.mjs");
  writeFileSync(
    file,
    `import { close, loadModel } from "@qvac/sdk";

try {
  await loadModel({
    modelSrc: "qvac-packaged-runtime-smoke-missing.gguf",
    modelType: "llamacpp-completion",
  });
  throw new Error("Expected missing-model loadModel smoke to fail");
} catch (error) {
  const details = error instanceof Error
    ? \`\${error.name}: \${error.message}\`
    : String(error);

  if (
    details.includes("WORKER_PLUGINS_NOT_REGISTERED") ||
    details.includes("No plugins registered")
  ) {
    throw error;
  }

  if (
    !details.includes("MODEL_NOT_FOUND") &&
    !details.includes("ModelNotFoundError") &&
    !details.includes("Available models")
  ) {
    throw new Error(\`Expected missing-model failure after worker init, got \${details}\`);
  }
} finally {
  await close();
}
`,
  );
  return file;
}

function checkRuntimeSmoke(dir, label) {
  const smokeFile = writeRuntimeSmoke(dir);
  run("node", [smokeFile], dir, true);
  console.log(`  ok  [${label}] node packaged runtime smoke`);
  run("bare", [smokeFile], dir, true);
  console.log(`  ok  [${label}] bare packaged runtime smoke`);
}

function checkConsumer(dir, label) {
  checkDependencyTree(dir, label);
  checkImport(dir, label);
}

try {
  const tarball = packSdk();

  const defaultConsumer = makeConsumer("default", tarball);
  checkConsumer(defaultConsumer, "default");
  checkConsumer(
    makeConsumer("lean", tarball, ["--omit=optional"]),
    "lean (--omit=optional)",
  );
  checkRuntimeSmoke(defaultConsumer, "default");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
