"use strict";

// Runs addon-test from the tests configure and writes its JUnit report.

const path = require("path");
const { spawnSync } = require("child_process");

const binary = process.platform === "win32" ? "addon-test.exe" : "./addon-test";
const cwd = path.resolve(__dirname, "..", "build", "test", "unit");

const result = spawnSync(binary, ["--gtest_output=xml:cpp-test-results.xml"], {
  cwd,
  stdio: "inherit",
  shell: false,
});

if (result.error) throw result.error;
if (result.signal) {
  console.error(`addon-test terminated by signal ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
