import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// Sibling of sdk-e2e-prepare-inference/prepare.mjs. Kept as a separate file on
// purpose: the inference resolver is release-critical and is not refactored to
// serve two dependencies. Keep the two in sync when either changes.

const TEST_SUITE_DEPENDENCY = "@qvac/test-suite";
const NPM_PACKAGE = "@qvac/test-suite";
const SOURCES = new Set(["branch", "npm", "manifest"]);

function requireSource(source) {
  const normalized = String(source || "manifest")
    .trim()
    .toLowerCase();
  if (!SOURCES.has(normalized)) {
    throw new Error(
      `Unsupported test-suite source "${source}". Expected branch, npm, or manifest.`,
    );
  }
  return normalized;
}

function readManifest(projectDirectory) {
  const manifestPath = path.resolve(projectDirectory, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const currentSpec = manifest.dependencies?.[TEST_SUITE_DEPENDENCY];
  if (typeof currentSpec !== "string" || currentSpec.length === 0) {
    throw new Error(
      `${manifestPath} must declare a ${TEST_SUITE_DEPENDENCY} dependency.`,
    );
  }
  return { manifest, manifestPath, currentSpec };
}

// A manifest spec pointing at the in-repo package (`file:../../test-suite`)
// cannot simply be installed: packages/test-suite/dist is gitignored, so a
// fresh checkout has no build output and `npx qvac-test` would not resolve.
// Such a spec is therefore built and packed exactly like the branch source.
function isLocalFileSpec(spec) {
  return spec.startsWith("file:") || spec.startsWith("link:");
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
    throw new Error(`"${normalized}" is not a published test-suite source.`);
  }
  if (typeof resolvedVersion !== "string" || resolvedVersion.length === 0) {
    throw new Error(
      `A resolved version is required for the ${normalized} test-suite source.`,
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
      `Manifest source requires a ${TEST_SUITE_DEPENDENCY} dependency.`,
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

export function applyTestSuiteSource({
  source,
  projectDirectory,
  dependencySpec = "",
  artifactDirectory = "",
  testSuiteDirectory = "",
}) {
  const normalized = requireSource(source);
  const { manifest, manifestPath, currentSpec } =
    readManifest(projectDirectory);

  if (normalized === "manifest") {
    // A registry spec installs as-is; nothing to rewrite.
    if (!isLocalFileSpec(currentSpec)) {
      return { dependencySpec: currentSpec };
    }
    // A local link points at the in-repo package, whose dist is gitignored.
    // Callers that went through the central resolve arrive here as "branch"
    // with a packed tarball. Callers that call this workflow directly and
    // never resolve (e.g. coload-smoke-mobile.yml) still land on "manifest",
    // so build the linked package in place — otherwise the link installs a
    // package with no dist, and the qvac-test binary does not exist.
    buildInPlace(testSuiteDirectory || "packages/test-suite");
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
        `Branch test-suite artifact must contain exactly one .tgz file; found ${tarballs.length}.`,
      );
    }
    appliedSpec = toLocalTarballSpec(tarballs[0]);
  }

  if (typeof appliedSpec !== "string" || appliedSpec.length === 0) {
    throw new Error(
      `Resolved dependency spec is required for the ${normalized} test-suite source.`,
    );
  }

  manifest.dependencies[TEST_SUITE_DEPENDENCY] = appliedSpec;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dependencySpec: appliedSpec };
}

function resolveRegistryVersion(requestedVersion) {
  const request = requestedVersion || "latest";
  const args = ["view", `${NPM_PACKAGE}@${request}`, "version", "--json"];
  const output = run("npm", args, { capture: true });
  return { request, version: exactVersion(output) };
}

// Build the in-repo package where it sits, so a `file:` link in the consumer
// manifest resolves to a package that actually has its compiled dist.
function buildInPlace(testSuiteDirectory) {
  const resolved = path.resolve(testSuiteDirectory);
  run("npm", ["install", "--ignore-scripts", "--no-fund", "--no-audit"], {
    cwd: resolved,
  });
  run("npm", ["run", "build"], { cwd: resolved });
}

function packBranch(testSuiteDirectory, artifactDirectory) {
  fs.mkdirSync(artifactDirectory, { recursive: true });
  run("npm", ["install", "--ignore-scripts", "--no-fund", "--no-audit"], {
    cwd: testSuiteDirectory,
  });
  run("npm", ["run", "build"], { cwd: testSuiteDirectory });
  const output = run(
    "npm",
    [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      artifactDirectory,
    ],
    { cwd: testSuiteDirectory, capture: true },
  );
  const packed = JSON.parse(output);
  if (!Array.isArray(packed) || packed.length !== 1 || !packed[0]?.filename) {
    throw new Error(
      `npm pack did not produce exactly one test-suite tarball: ${output}`,
    );
  }
  return path.resolve(artifactDirectory, packed[0].filename);
}

function resolveCommand() {
  const source = requireSource(process.env.TEST_SUITE_SOURCE);
  const projectDirectory = process.env.PROJECT_DIRECTORY || "packages/sdk/e2e";
  const { currentSpec } = readManifest(projectDirectory);
  const testSuiteDirectory = path.resolve(
    process.env.TEST_SUITE_DIRECTORY || "packages/test-suite",
  );
  const sha = process.env.CHECKOUT_SHA || "unknown";
  let result;
  let artifactPath = "";

  // `manifest` with a local file link means "use the in-repo package", which
  // still has to be built and packed — see isLocalFileSpec above.
  const manifestNeedsPack =
    source === "manifest" && isLocalFileSpec(currentSpec);

  if (source === "manifest" && !manifestNeedsPack) {
    result = resolveManifestSource(currentSpec);
  } else if (source === "branch" || manifestNeedsPack) {
    const testSuiteManifest = JSON.parse(
      fs.readFileSync(path.join(testSuiteDirectory, "package.json"), "utf8"),
    );
    artifactPath = packBranch(
      testSuiteDirectory,
      path.resolve(process.env.ARTIFACT_DIRECTORY || ".sdk-e2e/test-suite"),
    );
    const origin = manifestNeedsPack ? "manifest-link" : "branch";
    result = {
      dependencySpec: "",
      provenance: `${origin}:${sha}:${TEST_SUITE_DEPENDENCY}@${testSuiteManifest.version}`,
    };
  } else {
    const resolved = resolveRegistryVersion(
      process.env.TEST_SUITE_VERSION || "",
    );
    result = resolvePublishedSource({
      source,
      requestedVersion: resolved.request,
      resolvedVersion: resolved.version,
    });
  }

  // Downstream jobs branch on this value, so a packed manifest link must report
  // as the source that actually produced an artifact.
  const effectiveSource = manifestNeedsPack ? "branch" : source;

  writeOutput("source", effectiveSource);
  writeOutput("dependency-spec", result.dependencySpec);
  writeOutput("provenance", result.provenance);
  writeOutput("artifact-path", artifactPath);
  appendSummary([
    "### SDK E2E test-suite",
    `- Source: \`${effectiveSource}\``,
    `- Provenance: \`${result.provenance}\``,
  ]);
}

function applyCommand() {
  const source = requireSource(process.env.TEST_SUITE_SOURCE);
  const result = applyTestSuiteSource({
    source,
    projectDirectory: process.env.PROJECT_DIRECTORY || "packages/sdk/e2e",
    dependencySpec: process.env.TEST_SUITE_DEPENDENCY_SPEC || "",
    artifactDirectory: process.env.TEST_SUITE_ARTIFACT_DIRECTORY || "",
    testSuiteDirectory: process.env.TEST_SUITE_DIRECTORY || "packages/test-suite",
  });
  const provenance =
    process.env.TEST_SUITE_PROVENANCE || `${source}:${result.dependencySpec}`;

  writeOutput("dependency-spec", result.dependencySpec);
  appendSummary([
    "### SDK E2E test-suite dependency",
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
