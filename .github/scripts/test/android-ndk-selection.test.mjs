import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const actionPath = ".github/actions/setup-build-host/action.yml";
const workflowPaths = [
  ".github/workflows/reusable-prebuilds.yml",
  ".github/workflows/integration-mobile-test-inference-addon-cpp.yml",
];

function readStepScript(path, stepName) {
  const source = readFileSync(join(root, path), "utf8");
  const stepStart = source.indexOf(`name: ${stepName}`);
  assert.notEqual(stepStart, -1);
  const remainder = source.slice(stepStart);
  const run = remainder.match(/^([ ]*)run: \|\r?\n/m);
  assert.ok(run);
  const indentation = " ".repeat(run[1].length + 2);
  const lines = remainder.slice(run.index + run[0].length).split(/\r?\n/);
  const end = lines.findIndex((line) => line && !line.startsWith(indentation));
  return lines
    .slice(0, end < 0 ? lines.length : end)
    .map((line) => line.slice(indentation.length))
    .join("\n");
}

function runStep(script, env) {
  return spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function readExports(path) {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

test("host setup replaces the runner's NDK 30 selector with the validated pin", () => {
  const directory = mkdtempSync(join(tmpdir(), "qvac-ndk-"));
  try {
    const source = readFileSync(join(root, actionPath), "utf8");
    const version = source.match(/NDK_VERSION: ([\d.]+)/)[1];
    const sdk = directory.replaceAll("\\", "/");
    const ndk = `${sdk}/ndk/${version}`;
    mkdirSync(ndk, { recursive: true });
    writeFileSync(
      join(ndk, "source.properties"),
      `Pkg.Revision = ${version}\n`,
    );
    const output = join(directory, "github-env").replaceAll("\\", "/");
    const result = runStep(readStepScript(actionPath, "Select Android NDK"), {
      ANDROID_HOME: sdk,
      ANDROID_NDK_LATEST_HOME: `${sdk}/ndk/30.0.0`,
      NDK_VERSION: version,
      GITHUB_ENV: output,
    });
    assert.equal(result.status, 0, result.stderr);
    const exports = readExports(output);
    for (const selector of [
      "ANDROID_NDK",
      "ANDROID_NDK_HOME",
      "ANDROID_NDK_ROOT",
      "ANDROID_NDK_LATEST_HOME",
    ]) {
      assert.equal(exports[selector], ndk, selector);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const path of workflowPaths) {
  test(`${path} overrides Bare's latest selector after pinned host setup`, () => {
    const directory = mkdtempSync(join(tmpdir(), "qvac-ndk-"));
    try {
      const source = readFileSync(join(root, path), "utf8");
      assert.ok(
        source.indexOf("name: Align Bare NDK selection") >
          source.indexOf(
            "uses: tetherto/qvac/.github/actions/setup-build-host@",
          ),
      );
      const output = join(directory, "github-env").replaceAll("\\", "/");
      const selectedNdk = "C:/fake-sdk/ndk/pinned-version";
      const script = readStepScript(path, "Align Bare NDK selection");
      const result = runStep(script, {
        ANDROID_NDK_HOME: selectedNdk,
        ANDROID_NDK_LATEST_HOME: "C:/fake-sdk/ndk/newer-version",
        GITHUB_ENV: output,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readExports(output).ANDROID_NDK_LATEST_HOME, selectedNdk);
      const missingNdk = runStep(script, {
        ANDROID_NDK_HOME: "",
        GITHUB_ENV: output,
      });
      assert.notEqual(missingNdk.status, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
