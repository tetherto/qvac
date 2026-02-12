import RPC from "bare-rpc";
import spawn, {
  type ChildProcess as BareChildProcess,
} from "bare-runtime/spawn";
import type { Duplex, DuplexEvents } from "bare-stream";
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

const SOCKET_PATH =
  process.platform === "win32"
    ? `\\\\.\\pipe\\qvac-worker-${process.pid}`
    : path.join(os.tmpdir(), `qvac-worker-${process.pid}.sock`);

async function ensureRPC(): Promise<RPC> {
  if (rpcInstance) return rpcInstance;
  if (rpcPromise) return rpcPromise;

  rpcPromise = new Promise((resolve, reject) => {
    ipcServer = createServer((socket) => {
      rpcInstance = new RPC(
        socket as unknown as Duplex<DuplexEvents>,
        () => {},
      );
      resolve(rpcInstance);
    });

    ipcServer.on("error", reject);

    ipcServer.listen(SOCKET_PATH, () => {
      bareWorkerProc = spawn("bare", {
        args: [
          WORKER_PATH,
          JSON.stringify({
            QVAC_IPC_SOCKET_PATH: SOCKET_PATH,
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

export function close() {
  logger.info("🧹 Closing RPC client");
  if (bareWorkerProc) {
    logger.info("🐻🔫 Killing bare worker process");
    bareWorkerProc.kill("SIGTERM");
    bareWorkerProc = null;
  }
  if (ipcServer) {
    logger.info("🔌 Closing IPC server");
    ipcServer.close();
    ipcServer = null;
  }
  rpcInstance = null;
  rpcPromise = null;
}

// Register cleanup handlers for the parent process
process.once("exit", close);
