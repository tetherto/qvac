"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RpcServerStopError =
  exports.RpcServerBackendError =
  exports.RpcServerStartError =
  exports.RpcServerCacheError =
  exports.RpcServerDeviceError =
  exports.RpcServerNativeError =
  exports.RpcServerRdmaUnavailableError =
  exports.RpcServerInvalidHostError =
  exports.RpcServerNonLoopbackHostError =
  exports.RpcServerPortAllocationError =
  exports.DEFAULT_RPC_SERVER_HOST =
    void 0;
exports.allocateFreePort = allocateFreePort;
exports.startRpcServer = startRpcServer;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and native bindings expose CommonJS export shapes. */
const net = require("bare-net");
const path = require("bare-path");
const fabricBackends = require("@qvac/fabric/backends");
const binding = require("./binding");
/* eslint-enable @typescript-eslint/no-require-imports */
exports.DEFAULT_RPC_SERVER_HOST = "127.0.0.1";
const TRUSTED_LAN_WARNING_CODE = "QVAC_GGML_RPC_SERVER_TRUSTED_LAN";
// Keep native handles alive until an explicit stop finishes. Otherwise their
// finalizer can synchronously stop and join a live server during garbage collection.
const activeServerHandles = new Set();
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
      `${host} is not a loopback host; pass allowNonLoopbackHost: true to bind it on a trusted network`,
    );
    this.name = "RpcServerNonLoopbackHostError";
  }
}
exports.RpcServerNonLoopbackHostError = RpcServerNonLoopbackHostError;
class RpcServerInvalidHostError extends Error {
  constructor(host) {
    super(`ggml-rpc-server requires an IPv4 address or localhost: ${host}`);
    this.name = "RpcServerInvalidHostError";
  }
}
exports.RpcServerInvalidHostError = RpcServerInvalidHostError;
class RpcServerRdmaUnavailableError extends Error {
  constructor(cause) {
    super(
      "RDMA is not available: the @qvac/fabric RPC backend lacks it, libibverbs.so.1 " +
        "could not be loaded, or GGML_RPC_NO_RDMA is set",
      { cause },
    );
    this.name = "RpcServerRdmaUnavailableError";
  }
}
exports.RpcServerRdmaUnavailableError = RpcServerRdmaUnavailableError;
/**
 * A failure reported by the native server. The addon raises plain errors with a
 * `code`; these classes let callers branch on `name` or `instanceof` as they do
 * for the errors above. `code` equals `name`, and `cause` is the native error.
 */
class RpcServerNativeError extends Error {
  code;
  // Names are literals, not new.target.name, so they survive minification.
  constructor(name, message, cause) {
    super(message, { cause });
    this.name = name;
    this.code = name;
  }
}
exports.RpcServerNativeError = RpcServerNativeError;
/** No requested device exists, or no device is available. */
class RpcServerDeviceError extends RpcServerNativeError {
  constructor(message, cause) {
    super("RpcServerDeviceError", message, cause);
  }
}
exports.RpcServerDeviceError = RpcServerDeviceError;
/** The RPC cache directory could not be resolved or created. */
class RpcServerCacheError extends RpcServerNativeError {
  constructor(message, cause) {
    super("RpcServerCacheError", message, cause);
  }
}
exports.RpcServerCacheError = RpcServerCacheError;
/** The server could not be created or bound, or the RPC backend is missing. */
class RpcServerStartError extends RpcServerNativeError {
  constructor(message, cause) {
    super("RpcServerStartError", message, cause);
  }
}
exports.RpcServerStartError = RpcServerStartError;
/** The Fabric backends directory is invalid or could not be inspected. */
class RpcServerBackendError extends RpcServerNativeError {
  constructor(message, cause) {
    super("RpcServerBackendError", message, cause);
  }
}
exports.RpcServerBackendError = RpcServerBackendError;
/** The server did not stop cleanly. */
class RpcServerStopError extends RpcServerNativeError {
  constructor(message, cause) {
    super("RpcServerStopError", message, cause);
  }
}
exports.RpcServerStopError = RpcServerStopError;
const nativeErrorClasses = new Map([
  ["RpcServerDeviceError", RpcServerDeviceError],
  ["RpcServerCacheError", RpcServerCacheError],
  ["RpcServerStartError", RpcServerStartError],
  ["RpcServerBackendError", RpcServerBackendError],
  ["RpcServerStopError", RpcServerStopError],
]);
function toTypedError(error) {
  const code = error?.code;
  if (code === "RpcServerRdmaUnavailableError") {
    return new RpcServerRdmaUnavailableError(error);
  }
  const ErrorClass =
    typeof code === "string" ? nativeErrorClasses.get(code) : undefined;
  return ErrorClass === undefined
    ? error
    : new ErrorClass(error.message, error);
}
async function callNative(call) {
  try {
    return await call();
  } catch (error) {
    throw toTypedError(error);
  }
}
function isLoopbackHost(host) {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}
function isIpv4Host(host) {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}
function normalizeHost(host) {
  return host === "localhost" ? exports.DEFAULT_RPC_SERVER_HOST : host;
}
function assertSupportedHost(host) {
  if (!isIpv4Host(host)) {
    throw new RpcServerInvalidHostError(host);
  }
}
function assertLoopbackHost(host, allowNonLoopbackHost = false) {
  if (!allowNonLoopbackHost && !isLoopbackHost(host)) {
    throw new RpcServerNonLoopbackHostError(host);
  }
}
function warnForTrustedLanHost(host, allowNonLoopbackHost = false) {
  if (!allowNonLoopbackHost || isLoopbackHost(host)) return;
  console.warn(
    `[${TRUSTED_LAN_WARNING_CODE}] ggml-rpc-server is binding to non-loopback host ${host}. ` +
      "The ggml RPC transport has no authentication or encryption; use this only on a trusted private network with external access controls.",
  );
}
function normalizeDevice(device) {
  if (device === undefined) return undefined;
  // The native side splits on ',' or '/' and matches names exactly, so trim
  // each name: 'Vulkan0, CPU' would otherwise look up ' CPU'.
  const names = typeof device === "string" ? device.split(/[,/]/) : device;
  const trimmed = names.map((name) => name.trim());
  // A blank-only value must not collapse to '', which means "default devices".
  // Pass it through untouched so the native side rejects it as unknown.
  if (
    trimmed.every((name) => name === "") &&
    names.some((name) => name !== "")
  ) {
    return names.join(",");
  }
  return trimmed.join(",");
}
function validatePort(port) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new RangeError("port must be an integer between 1 and 65535");
  }
}
function validateThreads(threads) {
  if (
    threads !== undefined &&
    (!Number.isSafeInteger(threads) || threads <= 0)
  ) {
    throw new TypeError("threads must be a positive integer");
  }
}
/**
 * Finds a port that is free now. Another process can take it before you bind
 * it, so `startRpcServer()` without a `port` lets the server bind one itself.
 */
function allocateFreePort(
  host = exports.DEFAULT_RPC_SERVER_HOST,
  options = {},
) {
  const bindHost = normalizeHost(host);
  assertSupportedHost(bindHost);
  assertLoopbackHost(bindHost, options.allowNonLoopbackHost);
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) =>
      reject(new RpcServerPortAllocationError(error)),
    );
    server.listen(0, bindHost, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new RpcServerPortAllocationError()));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}
async function startRpcServer(options = {}) {
  const host = normalizeHost(options.host ?? exports.DEFAULT_RPC_SERVER_HOST);
  assertSupportedHost(host);
  assertLoopbackHost(host, options.allowNonLoopbackHost);
  warnForTrustedLanHost(host, options.allowNonLoopbackHost);
  validateThreads(options.threads);
  // Packed mobile bundles do not retain a resolvable node_modules tree. Their
  // packagers stage Fabric's backends beside this addon instead.
  const backendsDir =
    fabricBackends.resolveBackendsDir() ?? path.join(__dirname, "prebuilds");
  if (options.port !== undefined) validatePort(options.port);
  const device = normalizeDevice(options.device);
  // Without a port the server binds port 0 itself and reports the port it got,
  // so no other process can take the port between choosing and binding it.
  const { handle, port, rdmaCapable } = await callNative(() =>
    binding.startServer({
      endpoint: `${host}:${options.port ?? 0}`,
      device,
      cache: options.cache ?? false,
      threads: options.threads,
      backendsDir,
      expectRdma: options.expectRdma === true,
    }),
  );
  activeServerHandles.add(handle);
  let stopPromise;
  return {
    host,
    port,
    url: `${host}:${port}`,
    device,
    rdmaCapable,
    stop: () => {
      stopPromise ??= callNative(() => binding.stopServer(handle)).then(
        () => {
          activeServerHandles.delete(handle);
        },
        (error) => {
          // Keep the handle pinned so the caller can retry a failed stop.
          stopPromise = undefined;
          throw error;
        },
      );
      return stopPromise;
    },
  };
}
