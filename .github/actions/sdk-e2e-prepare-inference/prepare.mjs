import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const INFERENCE_DEPENDENCY = "@qvac/inference";
const NPM_PACKAGE = "@qvac/inference";
const SOURCES = new Set(["branch", "npm", "manifest"]);

function requireSource(source) {
  const normalized = String(source || "manifest")
    .trim()
    .toLowerCase();
  if (!SOURCES.has(normalized)) {
    throw new Error(
      `Unsupported inference source "${source}". Expected branch, npm, or manifest.`,
    );
  }
  return normalized;
}

function readManifest(projectDirectory) {
  const manifestPath = path.resolve(projectDirectory, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const currentSpec = manifest.dependencies?.[INFERENCE_DEPENDENCY];
  if (typeof currentSpec !== "string" || currentSpec.length === 0) {
    throw new Error(
      `${manifestPath} must declare an ${INFERENCE_DEPENDENCY} dependency.`,
    );
  }
  return { manifest, manifestPath, currentSpec };
}

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function appendSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    ...options,
  });
}

function exactVersion(value) {
  const parsed = JSON.parse(value);
  if (typeof parsed === "string" && parsed.length > 0) return parsed;
  if (Array.isArray(parsed) && parsed.length > 0) return parsed.at(-1);
  throw new Error(`Registry returned no resolved version: ${value}`);
}

export function resolvePublishedSource({
  source,
  requestedVersion = "",
  resolvedVersion,
}) {
  const normalized = requireSource(source);
  if (normalized !== "npm") {
    throw new Error(`"${normalized}" is not a published inference source.`);
  }
  if (typeof resolvedVersion !== "string" || resolvedVersion.length === 0) {
    throw new Error(
      `A resolved version is required for the ${normalized} inference source.`,
    );
  }

  const request = requestedVersion || "latest";
  return {
    dependencySpec: resolvedVersion,
    provenance: `npm:${NPM_PACKAGE}@${resolvedVersion}`,
    requestedVersion: request,
  };
}

export function resolveManifestSource(dependencySpec) {
  if (typeof dependencySpec !== "string" || dependencySpec.length === 0) {
    throw new Error(
      `Manifest source requires an ${INFERENCE_DEPENDENCY} dependency.`,
    );
  }
  return {
    dependencySpec,
    provenance: `manifest:${dependencySpec}`,
  };
}

function toLocalTarballSpec(tarballPath, platform = process.platform) {
  if (platform === "win32") {
    return path.win32.resolve(tarballPath).replaceAll("\\", "/");
  }
  return pathToFileURL(path.resolve(tarballPath)).href;
}

export function applyInferenceSource({
  source,
  projectDirectory,
  dependencySpec = "",
  artifactDirectory = "",
}) {
  const normalized = requireSource(source);
  const { manifest, manifestPath, currentSpec } =
    readManifest(projectDirectory);

  if (normalized === "manifest") {
    return { dependencySpec: currentSpec };
  }

  let appliedSpec = dependencySpec;
  if (normalized === "branch") {
    const tarballs = fs
      .readdirSync(artifactDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
      .map((entry) => path.resolve(artifactDirectory, entry.name));
    if (tarballs.length !== 1) {
      throw new Error(
        `Branch inference artifact must contain exactly one .tgz file; found ${tarballs.length}.`,
      );
    }
    appliedSpec = toLocalTarballSpec(tarballs[0]);
  }

  if (typeof appliedSpec !== "string" || appliedSpec.length === 0) {
    throw new Error(
      `Resolved dependency spec is required for the ${normalized} inference source.`,
    );
  }

  manifest.dependencies[INFERENCE_DEPENDENCY] = appliedSpec;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dependencySpec: appliedSpec };
}

function resolveRegistryVersion(requestedVersion) {
  const request = requestedVersion || "latest";
  const args = ["view", `${NPM_PACKAGE}@${request}`, "version", "--json"];
  const output = run("npm", args, { capture: true });
  return { request, version: exactVersion(output) };
}

function packBranch(inferenceDirectory, artifactDirectory) {
  fs.mkdirSync(artifactDirectory, { recursive: true });
  run("bun", ["install", "--ignore-scripts"], { cwd: inferenceDirectory });
  run("bun", ["run", "build"], { cwd: inferenceDirectory });
  const output = run(
    "npm",
    [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      artifactDirectory,
    ],
    { cwd: inferenceDirectory, capture: true },
  );
  const packed = JSON.parse(output);
  if (!Array.isArray(packed) || packed.length !== 1 || !packed[0]?.filename) {
    throw new Error(
      `npm pack did not produce exactly one inference tarball: ${output}`,
    );
  }
  return path.resolve(artifactDirectory, packed[0].filename);
}

function resolveCommand() {
  const source = requireSource(process.env.INFERENCE_SOURCE);
  const projectDirectory = process.env.PROJECT_DIRECTORY || "packages/sdk";
  const { currentSpec } = readManifest(projectDirectory);
  let result;
  let artifactPath = "";

  if (source === "manifest") {
    result = resolveManifestSource(currentSpec);
  } else if (source === "branch") {
    const inferenceDirectory = path.resolve(
      process.env.INFERENCE_DIRECTORY || "packages/inference",
    );
    const inferenceManifest = JSON.parse(
      fs.readFileSync(path.join(inferenceDirectory, "package.json"), "utf8"),
    );
    artifactPath = packBranch(
      inferenceDirectory,
      path.resolve(process.env.ARTIFACT_DIRECTORY || ".sdk-e2e/inference"),
    );
    const sha = process.env.CHECKOUT_SHA || "unknown";
    result = {
      dependencySpec: "",
      provenance: `branch:${sha}:${INFERENCE_DEPENDENCY}@${inferenceManifest.version}`,
    };
  } else {
    const resolved = resolveRegistryVersion(
      process.env.INFERENCE_VERSION || "",
    );
    result = resolvePublishedSource({
      source,
      requestedVersion: resolved.request,
      resolvedVersion: resolved.version,
    });
  }

  writeOutput("source", source);
  writeOutput("dependency-spec", result.dependencySpec);
  writeOutput("provenance", result.provenance);
  writeOutput("artifact-path", artifactPath);
  appendSummary([
    "### SDK E2E inference",
    `- Source: \`${source}\``,
    `- Provenance: \`${result.provenance}\``,
  ]);
}

function applyCommand() {
  const source = requireSource(process.env.INFERENCE_SOURCE);
  const result = applyInferenceSource({
    source,
    projectDirectory: process.env.PROJECT_DIRECTORY || "packages/sdk",
    dependencySpec: process.env.INFERENCE_DEPENDENCY_SPEC || "",
    artifactDirectory: process.env.INFERENCE_ARTIFACT_DIRECTORY || "",
  });
  const provenance =
    process.env.INFERENCE_PROVENANCE || `${source}:${result.dependencySpec}`;

  writeOutput("dependency-spec", result.dependencySpec);
  appendSummary([
    "### SDK E2E inference dependency",
    `- Source: \`${source}\``,
    `- Applied: \`${result.dependencySpec}\``,
    `- Provenance: \`${provenance}\``,
  ]);
}

function main() {
  const command = process.argv[2];
  if (command === "resolve") {
    resolveCommand();
  } else if (command === "apply") {
    applyCommand();
  } else {
    throw new Error("Usage: prepare.mjs <resolve|apply>");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
