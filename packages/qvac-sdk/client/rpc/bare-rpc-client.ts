import RPC from "bare-rpc";
import { spawn, type ChildProcess } from "bare-subprocess";
import { createServer, type Server } from "bare-net";
import os from "bare-os";
import path from "bare-path";
import process from "bare-process";
import type { Duplex, DuplexEvents } from "bare-stream";
import { initializeConfig } from "@/client/init-hooks";
import { resolveConfig } from "@/client/config-loader/resolve-config.bare";
import { getClientLogger } from "@/logging";

const logger = getClientLogger();

let rpcInstance: RPC | null = null;
let ipcServer: Server | null = null;
let childProcess: ChildProcess | null = null;
const cwd = process.cwd();

// Resolve worker path relative to this module's location (in the SDK)
// In Bare, we'll use a simpler path resolution
let WORKER_PATH: string;
if (cwd.includes("/dist/") || cwd.includes("\\dist\\")) {
  // Running from compiled dist/ - worker is in same dist/ folder
  const distRoot = cwd.includes("/dist/")
    ? cwd.split("/dist/")[0] + "/dist"
    : cwd.split("\\dist\\")[0] + "\\dist";
  WORKER_PATH = path.join(distRoot, "server/worker.js");
} else {
  // Running from source - worker is in dist/ folder
  WORKER_PATH = path.resolve(cwd, "dist/server/worker.js");
}

const SOCKET_PATH = path.join(os.tmpdir(), `qvac-worker-${process.pid}.sock`);

export async function getRPC() {
  if (rpcInstance) {
    logger.debug("returning cached bare rpc");
    return rpcInstance;
  }

  logger.info("initRPC for bare runtime with socket:", SOCKET_PATH);

  // Start IPC server (Unix socket)
  const serverPromise = new Promise<RPC>((resolve, reject) => {
    const server = createServer((socket) => {
      logger.info("Worker connected via IPC socket");

      // Create RPC instance using the socket
      rpcInstance = new RPC(socket as unknown as Duplex<DuplexEvents>, () => {
        // Use this for async callbacks
      });

      resolve(rpcInstance);
    });

    server.on("error", (err: Error) => {
      logger.error("Failed to start IPC server:", err);
      reject(err);
    });

    server.listen(SOCKET_PATH, () => {
      logger.info(`IPC server listening on ${SOCKET_PATH}`);

      ipcServer = server;

      // Spawn the worker process only after the socket is listening
      logger.debug("Spawning worker at:", WORKER_PATH);

      childProcess = spawn(
        "bare",
        [
          WORKER_PATH,
          JSON.stringify({
            QVAC_IPC_SOCKET_PATH: SOCKET_PATH,
            HOME_DIR: os.homedir(),
          }),
        ],
        {
          stdio: ["inherit", "inherit", "inherit"],
        },
      );

      childProcess.on("exit", (code: number | null) => {
        logger.info("Worker process exited with code:", code);
        // Clean up
        rpcInstance = null;
        if (ipcServer) {
          ipcServer.close();
          ipcServer = null;
        }
      });

      childProcess.on("error", (err: Error) => {
        logger.error("Worker process error:", err);
      });
    });
  });

  // Wait for RPC to initialize, then send config
  const rpc = await serverPromise;
  await initializeConfig(rpc, resolveConfig);

  return rpc;
}

// Clean up function
export function cleanup() {
  if (childProcess) {
    childProcess.kill();
    childProcess = null;
  }
  if (ipcServer) {
    ipcServer.close();
    ipcServer = null;
  }
  rpcInstance = null;
}
