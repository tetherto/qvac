import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A package on the CI contract opts in with `metadata.baseline: true` on its cpp:tests target: select-projects emits
// build:baseline and cpp:tests:baseline rows for it, and pr-build-test.yml builds and tests those rows when the labels
// are absent, so a PR that lands new C++ tests cannot report them as skipped (QVAC-25289).

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

// The raw text of one top-level job, up to the next job heading.
function jobBlock(source, name) {
  const start = source.search(new RegExp(`^ {2}${name}:\\s*$`, "m"));
  assert.notEqual(start, -1, `defines job '${name}'`);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/^ {2}[a-z][a-z0-9-]*:\s*$/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
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

function contractBaselinePackages() {
  return projects()
    .filter(([, project]) => project.targets?.["cpp:tests"]?.metadata?.baseline === true)
    .map(([name]) => name);
}

test("at least one package opts into the C++ baseline, so the wiring below is exercised", () => {
  const names = [...baselinePackages().map(([name]) => name), ...contractBaselinePackages()];
  assert.ok(names.includes("translation-nmtcpp"), `translation-nmtcpp opts in; found: ${names.join(", ") || "none"}`);
});

test("every contract baseline package has build and cpp:tests configurations", () => {
  for (const name of contractBaselinePackages()) {
    const { targets, tags } = JSON.parse(read(`packages/${name}/project.json`));
    assert.ok(tags?.includes("ci:contract"), `${name}: metadata.baseline is read only for packages on the CI contract`);
    assert.ok(Object.keys(targets["cpp:tests"].configurations ?? {}).length, `${name}: cpp:tests needs a configuration`);
    assert.ok(Object.keys(targets.build.configurations ?? {}).length, `${name}: the baseline build needs a configuration`);
  }
});

test("pr-build-test runs the baseline rows when the labels are absent, and only those", () => {
  const source = read(".github/workflows/pr-build-test.yml");
  const build = jobBlock(source, "build");
  const cppTests = jobBlock(source, "cpp-tests");
  const status = jobBlock(source, "status");
  assert.match(build, /needs\.route\.outputs\.run_prebuilds == 'true' \|\| fromJSON\(needs\.select\.outputs\.matrices\)\['build:baseline'\]\[0\] != null/);
  assert.match(build, /run_prebuilds == 'true' && fromJSON\(needs\.select\.outputs\.matrices\)\.build \|\| fromJSON\(needs\.select\.outputs\.matrices\)\['build:baseline'\]/);
  assert.match(cppTests, /needs\.route\.outputs\.run_cpp_tests == 'true' \|\| fromJSON\(needs\.select\.outputs\.matrices\)\['cpp:tests:baseline'\]\[0\] != null/);
  assert.match(cppTests, /run_cpp_tests == 'true' && fromJSON\(needs\.select\.outputs\.matrices\)\['cpp:tests'\] \|\| fromJSON\(needs\.select\.outputs\.matrices\)\['cpp:tests:baseline'\]/);
  // A package the baseline run did not test must not read as a pass it never earned.
  assert.match(status, /CPP_TEST_RESULT: \$\{\{ \(needs\.route\.outputs\.run_cpp_tests == 'true' \|\| matrix\.project\.cppBaseline\) && needs\.cpp-tests\.result \|\| 'skipped' \}\}/);
  assert.match(status, /PREBUILD_RESULT: \$\{\{ \(needs\.route\.outputs\.run_prebuilds == 'true' \|\| matrix\.project\.cppBaseline\) && /);
});

test("select-projects emits baseline rows for the opted-in package alone", async () => {
  const { select } = await import(join(root, ".github/scripts/select-projects.mjs"));
  const cfg = { "linux-x64": { ci: { runner: "linux_ubuntu2204_x64" } } };
  const node = (name, baseline) => ({
    name,
    data: {
      root: `packages/${name}`,
      tags: ["ci:contract"],
      targets: {
        build: { configurations: cfg },
        "cpp:tests": { configurations: cfg, metadata: baseline ? { baseline: true } : {} },
      },
    },
  });
  const graph = { nodes: { a: node("a", true), b: node("b", false) }, dependencies: {} };
  const out = select({
    graph,
    affected: null,
    targets: ["build", "cpp:tests"],
    labels: { linux_ubuntu2204_x64: "qvac-ubuntu2204-x64" },
    gate: { a: "a", b: "b" },
  });
  assert.deepEqual(out.matrices["build:baseline"].map((r) => r.project), ["a"]);
  assert.deepEqual(out.matrices["cpp:tests:baseline"].map((r) => r.project), ["a"]);
  assert.deepEqual(out.projects.map((p) => [p.name, p.cppBaseline]), [["a", true], ["b", false]]);
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

test("security-baseline runs this suite", () => {
  assert.match(
    read(".github/workflows/security-baseline.yml"),
    /^ {10}\.github\/scripts\/test\/cpp-tests-baseline\.test\.mjs$/m,
    "cpp-tests-baseline.test.mjs is listed in the trust-policy test step",
  );
});
