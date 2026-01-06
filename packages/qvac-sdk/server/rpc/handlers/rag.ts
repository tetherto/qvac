import type { RagRequest, RagResponse } from "@/schemas";
import {
  saveEmbeddings,
  search,
  deleteEmbeddings,
} from "@/server/bare/rag-hyperdb";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function handleRag(request: RagRequest): Promise<RagResponse> {
  try {
    switch (request.operation) {
      case "saveEmbeddings": {
        const result = await saveEmbeddings(request);
        return {
          type: "rag",
          operation: request.operation,
          success: true,
          processed: result.processed,
          droppedIndices: result.droppedIndices,
        };
      }

      case "search": {
        const results = await search(request);
        return {
          type: "rag",
          operation: request.operation,
          success: true,
          results,
        };
      }

      case "deleteEmbeddings": {
        const success = await deleteEmbeddings(request);
        return {
          type: "rag",
          operation: request.operation,
          success,
        };
      }
    }
  } catch (error) {
    logger.error("Error in RAG handler:", error);

    const baseError = {
      type: "rag" as const,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };

    switch (request.operation) {
      case "saveEmbeddings":
        return {
          ...baseError,
          operation: request.operation,
          processed: [],
          droppedIndices: [],
        };
      case "search":
        return {
          ...baseError,
          operation: request.operation,
          results: [],
        };
      case "deleteEmbeddings":
        return {
          ...baseError,
          operation: request.operation,
        };
      default:
        throw error;
    }
  }
}
