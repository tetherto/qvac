"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const smokeSource = readFileSync(join(__dirname, "prebuild-smoke.cjs"), "utf8");

async function runSmoke(platform, arch, metalLogFor) {
  const starts = [];
  const process = { platform, arch, env: { TEST_ENV: "kept" }, exitCode: 0 };
  const errors = [];
  await runInNewContext(smokeSource, {
    process,
    console: {
      log() {},
      error(error) {
        errors.push(error);
      },
    },
    require(id) {
      if (id === "../../index.js") {
        return {
          resolveRpcServerBinaryPath() {
            throw new Error("Windows-only path must not be used");
          },
          startRpcServer(options) {
            starts.push(options);
            return Promise.resolve({
              host: "127.0.0.1",
              port: 50052,
              url: "127.0.0.1:50052",
              logs: () =>
                metalLogFor(options)
                  ? "ggml_metal_library_init: loaded in 42 sec"
                  : "CPU ready",
              stop() {
                return Promise.resolve();
              },
            });
          },
        };
      }
      if (id === "../mobile/rpc-protocol.cjs") {
        return {
          probeRpcServerProtocol() {
            return Promise.resolve({ version: "109.0.0", deviceCount: 1 });
          },
        };
      }
      return require(id);
    },
  });
  assert.deepEqual(errors, []);
  assert.equal(process.exitCode, 0);
  return starts;
}

test("Darwin x64 smoke isolates CPU startup before measuring Metal startup", async () => {
  const starts = await runSmoke(
    "darwin",
    "x64",
    (options) => options.env?.GGML_METAL_DEVICES === "1",
  );
  assert.equal(starts.length, 2);
  assert.equal(starts[0].device, "CPU");
  assert.equal(starts[0].startTimeoutMs, 30000);
  assert.equal(starts[0].env.GGML_METAL_DEVICES, "0");
  assert.equal(starts[0].env.TEST_ENV, "kept");
  assert.equal(starts[1].device, "CPU");
  assert.equal(starts[1].startTimeoutMs, 120000);
  assert.equal(starts[1].env.GGML_METAL_DEVICES, "1");
});

test("other platforms retain the original smoke check", async () => {
  const starts = await runSmoke("darwin", "arm64", () => false);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].device, "CPU");
  assert.equal(starts[0].startTimeoutMs, 30000);
  assert.equal(starts[0].env, undefined);
});
