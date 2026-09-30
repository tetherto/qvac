import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// on-pr-nx starts the C++ test lane only behind the run-cpp-addon-tests label.
// A package can instead declare `cppTestsBaseline: true` on its on-pr target,
// and on-pr-nx then runs its lane on every PR that affects it. Three ends have
// to agree for that to hold, and nothing at runtime says which one drifted:
// the matrix filter has to emit the list, cpp-tests has to read it, and the
// package has to declare a test:cpp lane for cpp-tests-nx to build a row from.
// Any one of them missing reproduces the failure this suite exists for: a PR
// lands new C++ tests and the on-pr run reports cpp-tests as skipped, which
// merge-guard accepts as a pass (QVAC-25289).
//
// Parsed with regexes and run through bash rather than a YAML library, like
// the other suites in this directory: bare node, no dependencies.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ORCHESTRATOR = ".github/workflows/on-pr-nx.yml";

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

// The raw text of one top-level job, up to the next job heading.
function jobBlock(source, name) {
  const start = source.search(new RegExp(`^ {2}${name}:\\s*$`, "m"));
  assert.notEqual(start, -1, `${ORCHESTRATOR} defines job '${name}'`);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/^ {2}[a-z][a-z0-9-]*:\s*$/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

// The `run: |` body of the step with the given id, dedented.
function stepRunBlock(source, stepId) {
  const at = source.search(new RegExp(`^ {6}- id: ${stepId}\\s*$`, "m"));
  assert.notEqual(at, -1, `${ORCHESTRATOR} has a step with id '${stepId}'`);
  const rest = source.slice(at);
  const run = rest.match(/^( +)run:\s*\|\s*$/m);
  assert.ok(run, `step '${stepId}' has a run: | block`);
  const indent = run[1].length + 2;
  const lines = [];
  for (const line of rest.slice(run.index + run[0].length + 1).split("\n")) {
    if (line === "") {
      lines.push("");
      continue;
    }
    if (!line.startsWith(" ".repeat(indent))) break;
    lines.push(line.slice(indent));
  }
  return lines.join("\n");
}

// Every packages/*/project.json, as [shortName, parsed].
function projects() {
  const dir = join(root, "packages");
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        return [[entry.name, JSON.parse(readFileSync(join(dir, entry.name, "project.json"), "utf8"))]];
      } catch {
        return [];
      }
    });
}

function baselinePackages() {
  return projects()
    .filter(([, project]) => project.targets?.["on-pr"]?.options?.ci?.cppTestsBaseline === true)
    .map(([name, project]) => [name, project]);
}

test("at least one package declares cppTestsBaseline, so the wiring below is exercised", () => {
  const names = baselinePackages().map(([name]) => name);
  assert.ok(names.includes("translation-nmtcpp"), `translation-nmtcpp opts in; found: ${names.join(", ") || "none"}`);
});

test("every cppTestsBaseline package has a test:cpp lane and sits in the on-pr matrix", () => {
  for (const [name, project] of baselinePackages()) {
    const onPr = project.targets["on-pr"].options.ci;
    assert.notEqual(
      onPr.carveOut,
      true,
      `${name}: an on-pr carve-out never reaches on-pr-nx's matrix, so its cppTestsBaseline would select nothing`,
    );
    const testCpp = project.targets["test:cpp"]?.options?.ci;
    assert.ok(
      testCpp && typeof testCpp === "object",
      `${name}: cppTestsBaseline needs a test:cpp target with options.ci, or cpp-tests-nx builds no row for it`,
    );
  }
});

test("on-pr-nx's matrix emits cppbaseline from the on-pr rows", () => {
  const source = read(ORCHESTRATOR);
  const matrix = jobBlock(source, "matrix");
  assert.match(
    matrix,
    /^ {6}cppbaseline: \$\{\{ steps\.filter\.outputs\.cppbaseline \}\}$/m,
    "matrix job declares the cppbaseline output",
  );
  assert.match(
    stepRunBlock(source, "filter"),
    /echo "cppbaseline=.*select\(\.cppTestsBaseline == true\)/,
    "filter step selects rows by cppTestsBaseline",
  );
});

// Run the real filter script over a two-package matrix: one opted in, one not.
test("the filter script lists exactly the opted-in packages", () => {
  const script = stepRunBlock(read(ORCHESTRATOR), "filter");
  const rows = [
    { package: "translation-nmtcpp", workdir: "packages/translation-nmtcpp", hasCppLint: true, cppTestsBaseline: true },
    { package: "asr-ggml", workdir: "packages/asr-ggml", hasCppLint: true },
  ];

  const directory = mkdtempSync(join(tmpdir(), "qvac-cpp-baseline-"));
  const outputPath = join(directory, "github-output");
  try {
    // The script also reads the PR-head fabric-consumers manifest.
    mkdirSync(join(directory, ".fabric-consumers-head/.github"), { recursive: true });
    writeFileSync(join(directory, ".fabric-consumers-head/.github/fabric-consumers.json"), '{"npm_runtime":[]}');
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputPath, M: JSON.stringify(rows) },
    });
    assert.equal(result.status, 0, `filter script failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`);

    const outputs = Object.fromEntries(
      readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    assert.deepEqual(JSON.parse(outputs.cppbaseline), ["translation-nmtcpp"]);
    assert.deepEqual(JSON.parse(outputs.packages), ["asr-ggml", "translation-nmtcpp"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("on-pr-nx's cpp-tests job runs the baseline list when the label is absent", () => {
  const block = jobBlock(read(ORCHESTRATOR), "cpp-tests");
  const guard = block.match(/^ {4}if: \|\n((?: {6}.*\n)+)/m);
  assert.ok(guard, "cpp-tests has a multi-line if:");
  assert.match(
    guard[1],
    /\(needs\.ci-router\.outputs\.run_cpp_tests == 'true' \|\| needs\.matrix\.outputs\.cppbaseline != '\[\]'\)/,
    "the label or a non-empty baseline list starts the job",
  );
  // A skipped or failed matrix exposes cppbaseline as '', and '' != '[]'
  // would otherwise start the job over an empty package list.
  assert.match(guard[1], /needs\.matrix\.result == 'success'/, "a failed matrix must not start cpp-tests");
  assert.match(
    block,
    /^ {6}packages: \$\{\{ needs\.ci-router\.outputs\.run_cpp_tests == 'true' && needs\.matrix\.outputs\.packages \|\| needs\.matrix\.outputs\.cppbaseline \}\}$/m,
    "the label widens the run to every affected package; without it only the baseline list is passed",
  );
});

test("security-baseline runs this suite", () => {
  assert.match(
    read(".github/workflows/security-baseline.yml"),
    /^ {10}\.github\/scripts\/test\/cpp-tests-baseline\.test\.mjs$/m,
    "cpp-tests-baseline.test.mjs is listed in the trust-policy test step",
  );
});
