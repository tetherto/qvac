"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const net = require("node:net");
const { performance } = require("node:perf_hooks");
const { startRpcServer } = require("../index.js");
const { probeRpcServerProtocol } = require("../test/mobile/rpc-protocol.cjs");

function inspect(command, args) {
  console.log(`$ ${command} ${args.join(" ")}`);
  console.log(execFileSync(command, args, { encoding: "utf8" }));
}

async function main() {
  assert.equal(process.platform, "darwin");
  console.log(JSON.stringify({ node: process.version, arch: process.arch }));
  inspect("sw_vers", []);
  inspect("sysctl", [
    "machdep.cpu.brand_string", "hw.model", "hw.ncpu", "hw.physicalcpu",
    "hw.logicalcpu", "hw.memsize", "vm.swapusage", "vm.loadavg",
  ]);
  inspect("system_profiler", ["SPDisplaysDataType"]);
  inspect("vm_stat", []);
  const results = [];
  for (let repetition = 1; repetition <= 3; repetition++) {
    for (const metal of ["0", "1"]) {
      const started = performance.now();
      const server = await startRpcServer({
        device: "CPU",
        startTimeoutMs: metal === "0" ? 30000 : 120000,
        env: { ...process.env, GGML_METAL_DEVICES: metal },
      });
      const startupMs = Math.round(performance.now() - started);
      try {
        const logs = server.logs();
        console.log(logs);
        assert.equal(logs.includes("ggml_metal_library_init: loaded in"), metal === "1");
        const probe = await probeRpcServerProtocol(net, server.host, server.port);
        assert.equal(probe.deviceCount, 1);
        const compilation = /ggml_metal_library_init: loaded in\s+([\d.]+) sec/.exec(logs);
        const result = {
          arch: process.arch, repetition, metal, startupMs,
          metalLibraryMs: compilation ? Number(compilation[1]) * 1000 : null,
          version: probe.version, deviceCount: probe.deviceCount,
        };
        results.push(result);
        console.log(`RESULT ${JSON.stringify(result)}`);
      } finally {
        await server.stop();
      }
    }
  }
  inspect("sysctl", ["vm.swapusage", "vm.loadavg"]);
  inspect("vm_stat", []);
  console.log(`RESULTS ${JSON.stringify(results)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
