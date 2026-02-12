import {
  requestSchema,
  responseSchema,
  type PingResponse,
  type Request,
} from "@/schemas";
import { handleCompletionStream } from "@/server/rpc/handlers/completion-stream";
import { handleDownloadAsset } from "@/server/rpc/handlers/download-asset";
import { handleLoadModel } from "@/server/rpc/handlers/load-model";
import { handleLoadModelDelegated } from "@/server/rpc/handlers/load-model-delegated";
import { handleCompletionStreamDelegated } from "@/server/rpc/handlers/completion-stream-delegated";
import { getModelEntry } from "@/server/bare/registry/model-registry";
import { setSDKConfig } from "@/server/bare/registry/config-registry";
import { setRuntimeContext } from "@/server/bare/registry/runtime-context-registry";
import type { QvacConfig, RuntimeContext } from "@/schemas";
import { handleUnloadModel } from "@/server/rpc/handlers/unload-model";
import { handleTranscribeStream } from "@/server/rpc/handlers/transcribe-stream";
import { handleEmbed } from "@/server/rpc/handlers/embed";
import { handleTranslate } from "@/server/rpc/handlers/translate";
import { handleLoggingStream } from "@/server/rpc/handlers/logging-stream";
import { cancelHandler } from "./handlers/cancelHandler";
import { provideHandler } from "./handlers/provideHandler";
import { stopProvideHandler } from "./handlers/stopProvideHandler";
import { handleRag } from "@/server/rpc/handlers/rag";
import { handleDeleteCache } from "@/server/rpc/handlers/delete-cache";
import { handleTextToSpeech } from "@/server/rpc/handlers/text-to-speech";
import { handleGetModelInfo } from "@/server/rpc/handlers/get-model-info";
import { handleOCRStream } from "@/server/rpc/handlers/ocr-stream";
import type RPC from "bare-rpc";
import {
  sendErrorResponse,
  sendStreamErrorResponse,
} from "@/server/error-handlers";
import {
  NoDataReceivedError,
  UnknownRequestTypeError,
} from "@/utils/errors-client";
import { normalizeModelType, type CanonicalModelType } from "@/schemas";
import { resolveModelConfig } from "@/server/bare/registry/model-config-registry";

export type BareRPCRequest = {
  data: Buffer;
  reply: (data: string, encoding: BufferEncoding) => void;
  createResponseStream: () => {
    write: (data: string, encoding: BufferEncoding) => void;
    end: () => void;
    [Symbol.asyncIterator]?: () => AsyncIterator<Buffer>;
  };
};

export async function handleRequest(req: RPC.IncomingRequest): Promise<void> {
  try {
    const rawData = req.data?.toString();
    if (!rawData) {
      throw new NoDataReceivedError();
    }
    const jsonData: unknown = JSON.parse(rawData);

    // Handle special internal config initialization message
    if (
      jsonData &&
      typeof jsonData === "object" &&
      "type" in jsonData &&
      jsonData.type === "__init_config"
    ) {
      try {
        const initData = jsonData as {
          type: string;
          config: unknown;
          runtimeContext?: RuntimeContext;
        };
        if (initData.config) {
          setSDKConfig(initData.config as QvacConfig);
        }
        if (initData.runtimeContext) {
          setRuntimeContext(initData.runtimeContext);
        }
        req.reply(JSON.stringify({ success: true }), "utf-8");
      } catch (error) {
        req.reply(
          JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }),
          "utf-8",
        );
      }
      return;
    }

    const processedData = applyDeviceDefaultsToRequest(jsonData);
    const request: Request = requestSchema.parse(processedData);

    switch (request.type) {
      case "downloadAsset": {
        if (request.withProgress) {
          const stream = req.createResponseStream();
          try {
            const response = await handleDownloadAsset(request, (update) => {
              const data = JSON.stringify(responseSchema.parse(update));
              stream.write(data + "\n", "utf-8");
            });

            // Send final response
            const data = JSON.stringify(responseSchema.parse(response));
            stream.write(data + "\n", "utf-8");
            stream.end();
          } catch (error) {
            sendStreamErrorResponse(stream, error);
          }
        } else {
          try {
            const response = await handleDownloadAsset(request);
            req.reply(JSON.stringify(responseSchema.parse(response)), "utf-8");
          } catch (error) {
            sendErrorResponse(req, error);
          }
        }
        break;
      }

      case "loadModel": {
        if (request.withProgress) {
          const stream = req.createResponseStream();
          try {
            // Route to appropriate handler based on delegation
            let response;
            if (request.delegate) {
              response = await handleLoadModelDelegated(request, (update) => {
                const data = JSON.stringify(responseSchema.parse(update));
                stream.write(data + "\n", "utf-8");
              });
            } else {
              response = await handleLoadModel(request, (update) => {
                const data = JSON.stringify(responseSchema.parse(update));
                stream.write(data + "\n", "utf-8");
              });
            }

            // Send final response
            const data = JSON.stringify(responseSchema.parse(response));
            stream.write(data + "\n", "utf-8");
            stream.end();
          } catch (error) {
            sendStreamErrorResponse(stream, error);
          }
        } else if (request.delegate) {
          try {
            const response = await handleLoadModelDelegated(request);
            req.reply(JSON.stringify(responseSchema.parse(response)), "utf-8");
          } catch (error) {
            sendErrorResponse(req, error);
          }
        } else {
          // Load without progress/delegate, or reload config
          try {
            const response = await handleLoadModel(request);
            req.reply(JSON.stringify(responseSchema.parse(response)), "utf-8");
          } catch (error) {
            sendErrorResponse(req, error);
          }
        }
        break;
      }

      case "completionStream": {
        const stream = req.createResponseStream();
        try {
          // Check if the model is delegated and route accordingly
          const entry = getModelEntry(request.modelId);
          const handler = entry?.isDelegated
            ? handleCompletionStreamDelegated
            : handleCompletionStream;
          for await (const response of handler(request)) {
            const validatedResponse = responseSchema.parse(response);
            const data = JSON.stringify(validatedResponse);
            stream.write(data + "\n", "utf-8");
          }

          stream.end();
          break;
        } catch (error) {
          sendStreamErrorResponse(stream, error);
        }
        break;
      }

      case "unloadModel": {
        const response = await handleUnloadModel(request);
        req.reply(JSON.stringify(responseSchema.parse(response)), "utf-8");
        break;
      }

      case "transcribeStream": {
        const stream = req.createResponseStream();
        try {
          for await (const response of handleTranscribeStream(request)) {
            const validatedResponse = responseSchema.parse(response);
            const data = JSON.stringify(validatedResponse);
            stream.write(data + "\n", "utf-8");
          }
          stream.end();
        } catch (error) {
          sendStreamErrorResponse(stream, error);
          return;
        }
        break;
      }

      case "loggingStream": {
        const stream = req.createResponseStream();
        try {
          for await (const response of handleLoggingStream(request)) {
            const validatedResponse = responseSchema.parse(response);
            const data = JSON.stringify(validatedResponse);
            stream.write(data + "\n", "utf-8");
          }
          stream.end();
        } catch (error) {
          sendStreamErrorResponse(stream, error);
          return;
        }
        break;
      }

      case "ping": {
        const res: PingResponse = {
          type: "pong",
          number: Math.random() * 100,
        };
        req.reply(JSON.stringify(res), "utf-8");
        break;
      }

      case "embed": {
        try {
          const response = await handleEmbed(request);
          req.reply(JSON.stringify(responseSchema.parse(response)), "utf-8");
        } catch (error) {
          sendErrorResponse(req, error);
        }
        break;
      }

      case "translate": {
        const stream = req.createResponseStream();
        try {
          for await (const response of handleTranslate(request)) {
            const validatedResponse = responseSchema.parse(response);
            const data = JSON.stringify(validatedResponse);
            stream.write(data + "\n", "utf-8");
          }
          stream.end();
        } catch (error) {
          sendStreamErrorResponse(stream, error);
        }
        break;
      }

      case "cancel": {
        try {
          const response = await cancelHandler(request);
          req.reply(JSON.stringify(responseSchema.parse(response)), "utf-8");
        } catch (error) {
          sendErrorResponse(req, error);
        }
        break;
      }

      case "provide": {
        const response = await provideHandler(request);
        req.reply(JSON.stringify(responseSchema.parse(response)), "utf-8");
        break;
      }

      case "stopProvide": {
        const response = stopProvideHandler(request);
        req.reply(JSON.stringify(responseSchema.parse(response)), "utf-8");
        break;
      }

      case "rag": {
        // Only ingest, saveEmbeddings, and reindex support progress
        const supportsProgress =
          request.operation === "ingest" ||
          request.operation === "saveEmbeddings" ||
          request.operation === "reindex";
        const withProgress = supportsProgress && request.withProgress;

        if (withProgress) {
          const stream = req.createResponseStream();
          try {
            const response = await handleRag(request, (update) => {
              const data = JSON.stringify(responseSchema.parse(update));
              stream.write(data + "\n", "utf-8");
            });

            // Send final response
            const data = JSON.stringify(responseSchema.parse(response));
            stream.write(data + "\n", "utf-8");
            stream.end();
          } catch (error) {
            sendStreamErrorResponse(stream, error);
          }
        } else {
          try {
            const response = await handleRag(request);
            req.reply(JSON.stringify(responseSchema.parse(response)), "utf-8");
          } catch (error) {
            sendErrorResponse(req, error);
          }
        }
        break;
      }

      case "deleteCache": {
        try {
          const response = await handleDeleteCache(request);
          req.reply(JSON.stringify(responseSchema.parse(response)), "utf-8");
        } catch (error) {
          sendErrorResponse(req, error);
        }
        break;
      }

      case "textToSpeech": {
        const stream = req.createResponseStream();
        try {
          for await (const response of handleTextToSpeech(request)) {
            const validatedResponse = responseSchema.parse(response);
            const data = JSON.stringify(validatedResponse);
            stream.write(data + "\n", "utf-8");
          }
          stream.end();
        } catch (error) {
          sendStreamErrorResponse(stream, error);
        }
        break;
      }

      case "getModelInfo": {
        try {
          const response = await handleGetModelInfo(request);
          req.reply(JSON.stringify(responseSchema.parse(response)), "utf-8");
        } catch (error) {
          sendErrorResponse(req, error);
        }
        break;
      }

      case "ocrStream": {
        const stream = req.createResponseStream();
        try {
          for await (const response of handleOCRStream(request)) {
            const validatedResponse = responseSchema.parse(response);
            const data = JSON.stringify(validatedResponse);
            stream.write(data + "\n", "utf-8");
          }
          stream.end();
        } catch (error) {
          sendStreamErrorResponse(stream, error);
        }
        break;
      }

      default: {
        throw new UnknownRequestTypeError();
      }
    }
  } catch (error) {
    sendErrorResponse(req, error);
  }
}

/**
 * Apply device-specific config defaults to loadModel requests before schema parsing.
 * This ensures device defaults are applied before schema defaults.
 *
 * Priority: User config > Device defaults > Schema defaults
 */
function applyDeviceDefaultsToRequest(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;

  const obj = data as Record<string, unknown>;
  const requestType = obj["type"];

  // Only process loadModel requests (not reload config which uses modelId)
  if (
    requestType !== "loadModel" ||
    !obj["modelType"] ||
    !("modelSrc" in obj)
  ) {
    return data;
  }

  // Normalize model type to canonical form
  let canonicalType: CanonicalModelType;
  try {
    canonicalType = normalizeModelType(
      obj["modelType"] as Parameters<typeof normalizeModelType>[0],
    );
  } catch {
    // Invalid model type, let schema validation handle it
    return data;
  }

  // Apply device defaults and full schema defaults to modelConfig
  const rawConfig = (obj["modelConfig"] as Record<string, unknown>) ?? {};
  const configWithDefaults = resolveModelConfig(canonicalType, rawConfig);

  return {
    ...obj,
    modelConfig: configWithDefaults,
  };
}
