import RPC from "bare-rpc";
import spawn, {
  type ChildProcess as BareChildProcess,
} from "bare-runtime/spawn";
import type { Duplex, DuplexEvents } from "bare-stream";
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RPCRequestNotSentError } from "@/utils/errors-client";
import { initializeConfig } from "@/client/init-hooks";
import { resolveConfig } from "@/client/config-loader/resolve-config.node";
import { getClientLogger } from "@/logging";
import type { RuntimeContext } from "@/schemas";

const logger = getClientLogger();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let rpcInstance: RPC | null = null;
let rpcPromise: Promise<RPC> | null = null;
let bareWorkerProc: BareChildProcess | null = null;
let ipcServer: ReturnType<typeof createServer> | null = null;
let currentSocketPath: string | null = null;
let closePromise: Promise<void> | null = null;

// Smart path resolution for worker
let WORKER_PATH: string;
if (__dirname.includes("/dist/") || __dirname.includes("\\dist\\")) {
  const distRoot = __dirname.includes("/dist/")
    ? __dirname.split("/dist/")[0] + "/dist"
    : __dirname.split("\\dist\\")[0] + "\\dist";
  WORKER_PATH = path.join(distRoot, "server/worker.js");
} else {
  WORKER_PATH = path.resolve(__dirname, "../../dist/server/worker.js");
}

function createSocketPath() {
  const timestamp = Date.now().toString(36);
  const randomSuffix = randomBytes(2).toString("hex");
  const socketName = `qvac-worker-${process.pid}-${timestamp}-${randomSuffix}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${socketName}`
    : path.join(os.tmpdir(), `${socketName}.sock`);
}

function bestEffortUnlinkSocket(socketPath: string | null) {
  // Windows named pipes are not filesystem paths, so unlink is Unix-only.
  if (!socketPath || process.platform === "win32") return;
  try {
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
  } catch (error) {
    logger.debug("Failed to unlink IPC socket path", { socketPath, error });
  }
}

function snapshotAndResetState() {
  const workerToClose = bareWorkerProc;
  const serverToClose = ipcServer;
  const socketPathToClose = currentSocketPath;

  rpcInstance = null;
  rpcPromise = null;
  bareWorkerProc = null;
  ipcServer = null;
  currentSocketPath = null;

  return { workerToClose, serverToClose, socketPathToClose };
}

function closeSyncForExit() {
  const { workerToClose, serverToClose, socketPathToClose } =
    snapshotAndResetState();

  if (workerToClose) {
    try {
      workerToClose.kill("SIGTERM");
    } catch (error) {
      logger.debug("Failed to kill bare worker during process exit", { error });
    }
  }

  if (serverToClose) {
    try {
      serverToClose.close();
    } catch (error) {
      logger.debug("Failed to close IPC server during process exit", { error });
    }
  }

  bestEffortUnlinkSocket(socketPathToClose);
}

async function ensureRPC(): Promise<RPC> {
  if (rpcInstance) return rpcInstance;
  if (rpcPromise) return rpcPromise;
  if (closePromise) {
    await closePromise;
  }

  const socketPath = createSocketPath();
  currentSocketPath = socketPath;

  rpcPromise = new Promise((resolve, reject) => {
    ipcServer = createServer((socket) => {
      rpcInstance = new RPC(
        socket as unknown as Duplex<DuplexEvents>,
        () => {},
      );
      resolve(rpcInstance);
    });

    ipcServer.on("error", (error) => {
      rpcPromise = null;
      rpcInstance = null;
      bareWorkerProc = null;
      ipcServer = null;
      currentSocketPath = null;
      reject(error);
    });

    ipcServer.listen(socketPath, () => {
      bareWorkerProc = spawn("bare", {
        args: [
          WORKER_PATH,
          JSON.stringify({
            QVAC_IPC_SOCKET_PATH: socketPath,
            HOME_DIR: os.homedir(),
          }),
        ],
        stdio: ["inherit", "inherit", "inherit"],
      });
    });
  });

  const rpc = await rpcPromise;

  const runtimeContext: RuntimeContext = {
    runtime: "node",
    platform: process.platform as "darwin" | "linux" | "win32",
  };
  await initializeConfig(rpc, resolveConfig, runtimeContext);

  return rpc;
}

const mockRPC = {
  request: (command: number) => {
    let sentData: { data: string; encoding: BufferEncoding } | null = null;

    return {
      send: (data: string, encoding: BufferEncoding) => {
        sentData = { data, encoding };
      },

      reply: async (encoding: BufferEncoding): Promise<Buffer> => {
        if (!sentData) {
          throw new RPCRequestNotSentError();
        }

        const rpc = await ensureRPC();
        const req = rpc.request(command);
        req.send(
          sentData.data,
          sentData.encoding as "utf-8" | "ascii" | "binary",
        );

        const response = await req.reply(
          encoding as "utf-8" | "ascii" | "binary",
        );
        return Buffer.isBuffer(response)
          ? response
          : Buffer.from(typeof response === "string" ? response : "", encoding);
      },

      createResponseStream: async function* () {
        if (!sentData) {
          throw new RPCRequestNotSentError();
        }

        const rpc = await ensureRPC();
        const req = rpc.request(command);
        req.send(
          sentData.data,
          sentData.encoding as "utf-8" | "ascii" | "binary",
        );
        const stream = req.createResponseStream({
          encoding: sentData.encoding as "utf-8" | "ascii" | "binary",
        });

        for await (const chunk of stream) {
          yield chunk;
        }
      },
    };
  },
};

export function getRPC() {
  return mockRPC;
}

export async function close() {
  if (closePromise) {
    await closePromise;
    return;
  }

  if (!rpcInstance && !rpcPromise && !bareWorkerProc && !ipcServer) return;

  logger.info("🧹 Closing RPC client");

  const { workerToClose, serverToClose, socketPathToClose } =
    snapshotAndResetState();

  closePromise = (async () => {
    if (workerToClose) {
      logger.info("🐻🔫 Killing bare worker process");
      try {
        workerToClose.kill("SIGTERM");
      } catch (error) {
        logger.debug("Failed to kill bare worker process", { error });
      }
    }

    if (serverToClose) {
      logger.info("🔌 Closing IPC server");
      await new Promise<void>((resolve) => {
        try {
          serverToClose.close(() => resolve());
        } catch (error) {
          logger.debug("Failed to close IPC server", { error });
          resolve();
        }
      });
    }

    bestEffortUnlinkSocket(socketPathToClose);
  })();

  try {
    await closePromise;
  } finally {
    closePromise = null;
  }
}

function handleTerminationSignal(signal: NodeJS.Signals) {
  logger.info(`Received ${signal}, closing RPC resources...`);
  closeSyncForExit();
  process.kill(process.pid, signal);
}

process.once("SIGINT", () => handleTerminationSignal("SIGINT"));
process.once("SIGTERM", () => handleTerminationSignal("SIGTERM"));
process.once("SIGHUP", () => handleTerminationSignal("SIGHUP"));
process.once("exit", closeSyncForExit);
