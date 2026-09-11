"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RpcServerRdmaUnavailableError =
  exports.RpcServerStartTimeoutError =
  exports.RpcServerExitedError =
  exports.RpcServerSpawnError =
  exports.RpcServerNonLoopbackHostError =
  exports.RpcServerPortAllocationError =
  exports.RpcServerUnsupportedPlatformError =
  exports.RpcServerBinaryNotFoundError =
  exports.RPC_SERVER_HEALTH_POLL_INTERVAL_MS =
  exports.DEFAULT_RPC_SERVER_SHUTDOWN_GRACE_MS =
  exports.DEFAULT_RPC_SERVER_START_TIMEOUT_MS =
  exports.DEFAULT_RPC_SERVER_HOST =
    void 0;
exports.resolveRpcServerBinaryPath = resolveRpcServerBinaryPath;
exports.allocateFreePort = allocateFreePort;
exports.rpcServerLogsIndicateRdmaSupport = rpcServerLogsIndicateRdmaSupport;
exports.startRpcServer = startRpcServer;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_net_1 = require("node:net");
const node_process_1 = require("node:process");
const node_path_1 = require("node:path");
exports.DEFAULT_RPC_SERVER_HOST = "127.0.0.1";
exports.DEFAULT_RPC_SERVER_START_TIMEOUT_MS = 10000;
exports.DEFAULT_RPC_SERVER_SHUTDOWN_GRACE_MS = 2000;
exports.RPC_SERVER_HEALTH_POLL_INTERVAL_MS = 100;
const PREBUILD_MODULE_DIR = "qvac__ggml-rpc-server";
const SUPPORTED_PREBUILD_TARGETS = new Set([
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
]);
const RDMA_SUPPORT_MARKER = "RDMA auto-negotiate enabled";
class RpcServerBinaryNotFoundError extends Error {
  constructor(path) {
    super(`ggml-rpc-server binary was not found at ${path}`);
    this.name = "RpcServerBinaryNotFoundError";
  }
}
exports.RpcServerBinaryNotFoundError = RpcServerBinaryNotFoundError;
class RpcServerUnsupportedPlatformError extends Error {
  constructor(runtimePlatform, runtimeArch) {
    super(
      `ggml-rpc-server is not packaged for ${runtimePlatform}-${runtimeArch}`,
    );
    this.name = "RpcServerUnsupportedPlatformError";
  }
}
exports.RpcServerUnsupportedPlatformError = RpcServerUnsupportedPlatformError;
class RpcServerPortAllocationError extends Error {
  constructor(cause) {
    super("Failed to allocate a free port for ggml-rpc-server", { cause });
    this.name = "RpcServerPortAllocationError";
  }
}
exports.RpcServerPortAllocationError = RpcServerPortAllocationError;
class RpcServerNonLoopbackHostError extends Error {
  constructor(host) {
    super(
      `ggml-rpc-server only supports loopback hosts in this package: ${host}`,
    );
    this.name = "RpcServerNonLoopbackHostError";
  }
}
exports.RpcServerNonLoopbackHostError = RpcServerNonLoopbackHostError;
class RpcServerSpawnError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "RpcServerSpawnError";
  }
}
exports.RpcServerSpawnError = RpcServerSpawnError;
class RpcServerExitedError extends Error {
  code;
  signal;
  output;
  constructor(code, signal, output) {
    super(
      `ggml-rpc-server exited before it was ready: code=${String(code)} signal=${String(signal)}`,
    );
    this.name = "RpcServerExitedError";
    this.code = code;
    this.signal = signal;
    this.output = output;
  }
}
exports.RpcServerExitedError = RpcServerExitedError;
class RpcServerStartTimeoutError extends Error {
  host;
  port;
  timeoutMs;
  output;
  constructor(host, port, timeoutMs, output) {
    super(
      `ggml-rpc-server did not listen on ${host}:${port} within ${timeoutMs}ms`,
    );
    this.name = "RpcServerStartTimeoutError";
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.output = output;
  }
}
exports.RpcServerStartTimeoutError = RpcServerStartTimeoutError;
class RpcServerRdmaUnavailableError extends Error {
  output;
  constructor(output) {
    super(
      "ggml-rpc-server was expected to support RDMA, but startup logs did not report RDMA auto-negotiation support",
    );
    this.name = "RpcServerRdmaUnavailableError";
    this.output = output;
  }
}
exports.RpcServerRdmaUnavailableError = RpcServerRdmaUnavailableError;
function prebuildTarget(
  runtimePlatform = node_process_1.platform,
  runtimeArch = node_process_1.arch,
) {
  let target;
  switch (runtimePlatform) {
    case "darwin":
      if (runtimeArch === "arm64") target = "darwin-arm64";
      if (runtimeArch === "x64") target = "darwin-x64";
      break;
    case "linux":
      if (runtimeArch === "x64") target = "linux-x64";
      if (runtimeArch === "arm64") target = "linux-arm64";
      break;
    case "win32":
      if (runtimeArch === "x64") target = "win32-x64";
      break;
  }
  if (target !== undefined && SUPPORTED_PREBUILD_TARGETS.has(target)) {
    return target;
  }
  throw new RpcServerUnsupportedPlatformError(runtimePlatform, runtimeArch);
}
function binaryName(runtimePlatform = node_process_1.platform) {
  return runtimePlatform === "win32"
    ? "ggml-rpc-server.exe"
    : "ggml-rpc-server";
}
function resolveRpcServerBinaryPath() {
  const resolved = (0, node_path_1.join)(
    __dirname,
    "prebuilds",
    prebuildTarget(),
    PREBUILD_MODULE_DIR,
    binaryName(),
  );
  if (!(0, node_fs_1.existsSync)(resolved)) {
    throw new RpcServerBinaryNotFoundError(resolved);
  }
  return resolved;
}
function allocateFreePort(host = exports.DEFAULT_RPC_SERVER_HOST, options = {}) {
  assertLoopbackHost(host, options.allowNonLoopbackHost);
  return new Promise((resolve, reject) => {
    const server = (0, node_net_1.createServer)();
    server.once("error", (err) =>
      reject(new RpcServerPortAllocationError(err)),
    );
    server.listen({ host, port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new RpcServerPortAllocationError()));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}
function rpcServerLogsIndicateRdmaSupport(logs) {
  return logs.includes(RDMA_SUPPORT_MARKER);
}
function fileContainsRdmaSupportMarker(path) {
  try {
    return (0, node_fs_1.readFileSync)(path).includes(
      Buffer.from(RDMA_SUPPORT_MARKER),
    );
  } catch {
    return false;
  }
}
function rpcServerBinaryIndicatesRdmaSupport(binaryPath) {
  if (fileContainsRdmaSupportMarker(binaryPath)) {
    return true;
  }
  try {
    for (const entry of (0, node_fs_1.readdirSync)(
      (0, node_path_1.dirname)(binaryPath),
    )) {
      if (!/\.(dll|dylib|so)$/.test(entry)) {
        continue;
      }
      if (
        fileContainsRdmaSupportMarker(
          (0, node_path_1.join)((0, node_path_1.dirname)(binaryPath), entry),
        )
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function assertLoopbackHost(host, allowNonLoopbackHost = false) {
  if (allowNonLoopbackHost) {
    return;
  }
  if (host === "localhost" || host === "::1") return;
  if ((0, node_net_1.isIP)(host) === 4 && host.startsWith("127.")) return;
  throw new RpcServerNonLoopbackHostError(host);
}
function attachOutputTail(child, maxChars = 65536) {
  let tail = "";
  function append(chunk) {
    tail = (tail + chunk.toString("utf8")).slice(-maxChars);
  }
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => tail;
}
function canConnect(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = (0, node_net_1.connect)({ host, port });
    const done = (connected) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(connected);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => {
      done(true);
    });
    socket.once("error", () => {
      done(false);
    });
  });
}
async function waitForListening(params) {
  const deadline = Date.now() + params.timeoutMs;
  const state = {
    exit: null,
    spawnError: null,
  };
  params.child.once("exit", (code, signal) => {
    state.exit = { code, signal };
  });
  params.child.once("error", (err) => {
    state.spawnError = err;
  });
  while (true) {
    if (state.spawnError !== null) {
      throw new RpcServerSpawnError(
        `Failed to spawn ggml-rpc-server: ${state.spawnError.message}`,
        state.spawnError,
      );
    }
    if (state.exit !== null) {
      throw new RpcServerExitedError(
        state.exit.code,
        state.exit.signal,
        params.getTail(),
      );
    }
    if (await canConnect(params.host, params.port)) return;
    if (Date.now() >= deadline) {
      throw new RpcServerStartTimeoutError(
        params.host,
        params.port,
        params.timeoutMs,
        params.getTail(),
      );
    }
    await delay(exports.RPC_SERVER_HEALTH_POLL_INTERVAL_MS);
  }
}
function rpcServerArgs(options) {
  const args = ["--host", options.host, "--port", String(options.port)];
  if (options.device !== undefined && options.device.length > 0) {
    args.push("--device", options.device);
  }
  if (options.cache) args.push("--cache");
  return args;
}
function normalizeDevice(device) {
  if (typeof device === "string" || device === undefined) return device;
  return device.join(",");
}
function signalProcessTree(child, signal) {
  const pid = child.pid;
  if (pid === undefined) return false;
  if (node_process_1.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // Fall through to direct signalling below.
    }
  }
  try {
    child.kill(signal);
    return true;
  } catch {
    return false;
  }
}
async function stopProcess(child, graceMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", () => resolve()));
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const timedOut = await Promise.race([
    exited.then(() => false),
    delay(graceMs).then(() => true),
  ]);
  if (timedOut) {
    signalProcessTree(child, "SIGKILL");
    await Promise.race([exited, delay(500)]);
  }
}
function attachExitCleanup(child) {
  const cleanup = () => {
    signalProcessTree(child, "SIGTERM");
  };
  process.once("exit", cleanup);
  return () => process.removeListener("exit", cleanup);
}
async function startRpcServer(options = {}) {
  const host = options.host ?? exports.DEFAULT_RPC_SERVER_HOST;
  assertLoopbackHost(host, options.allowNonLoopbackHost);
  const port =
    options.port ??
    (await allocateFreePort(host, {
      allowNonLoopbackHost: options.allowNonLoopbackHost,
    }));
  const device = normalizeDevice(options.device);
  const binaryPath = options.binaryPath ?? resolveRpcServerBinaryPath();
  const binaryRdmaCapable = rpcServerBinaryIndicatesRdmaSupport(binaryPath);
  const startTimeoutMs =
    options.startTimeoutMs ?? exports.DEFAULT_RPC_SERVER_START_TIMEOUT_MS;
  const shutdownGraceMs =
    options.shutdownGraceMs ?? exports.DEFAULT_RPC_SERVER_SHUTDOWN_GRACE_MS;
  const args = rpcServerArgs({
    device,
    host,
    port,
    cache: options.cache ?? false,
  });
  const spawnOptions = {
    detached: true,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  };
  const child = (0, node_child_process_1.spawn)(binaryPath, args, spawnOptions);
  const getTail = attachOutputTail(child);
  const detachExitCleanup =
    options.cleanupOnExit === false ? () => {} : attachExitCleanup(child);
  if (child.pid === undefined) {
    await new Promise((resolve) => child.once("error", () => resolve()));
    detachExitCleanup();
    throw new RpcServerSpawnError(`Failed to spawn ${binaryPath}`);
  }
  try {
    await waitForListening({
      child,
      host,
      port,
      timeoutMs: startTimeoutMs,
      getTail,
    });
    if (
      options.expectRdma === true &&
      !binaryRdmaCapable &&
      !rpcServerLogsIndicateRdmaSupport(getTail())
    ) {
      throw new RpcServerRdmaUnavailableError(getTail());
    }
  } catch (err) {
    detachExitCleanup();
    await stopProcess(child, shutdownGraceMs).catch(() => {});
    throw err;
  }
  child.once("exit", detachExitCleanup);
  const rdmaCapable =
    binaryRdmaCapable || rpcServerLogsIndicateRdmaSupport(getTail());
  return {
    child,
    pid: child.pid,
    host,
    port,
    url: `${host}:${port}`,
    device,
    rdmaCapable,
    logs: getTail,
    stop: async () => {
      detachExitCleanup();
      await stopProcess(child, shutdownGraceMs);
    },
  };
}
