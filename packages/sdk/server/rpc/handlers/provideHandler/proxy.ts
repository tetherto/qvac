import { handleRequest } from "@/server/rpc/handle-request";
import type RPC from "bare-rpc";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

// Proxies RPC requests to the main handler: handleRequest
export function createRpcProxy() {
  return async (rpcRequest: RPC.IncomingRequest) => {
    logger.debug("📬 RPC request callback triggered!");
    logger.debug("📦 Raw RPC request data:", rpcRequest.data?.toString());
    try {
      logger.debug("🚀 Calling handleRequest...");
      await handleRequest(rpcRequest);
      logger.debug("✅ handleRequest completed successfully");
    } catch (error) {
      logger.error("❌ Error:", error instanceof Error ? error.message : error);
      const errorResponse = JSON.stringify({
        type: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
      logger.debug("📤 Sending error response:", errorResponse);
      rpcRequest.reply(errorResponse, "utf-8");
    }
  };
}
