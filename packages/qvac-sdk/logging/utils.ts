import { LEVEL_PRIORITIES } from "@qvac/logging/constants";
import type { LogLevel } from "@qvac/logging";
import stringify from "fast-safe-stringify";
import type { Request } from "@/schemas";

export function isLevelEnabled(messageLevel: LogLevel, currentLevel: LogLevel) {
  const messagePriority = LEVEL_PRIORITIES[messageLevel];
  const currentPriority = LEVEL_PRIORITIES[currentLevel];

  if (messagePriority === undefined || currentPriority === undefined) {
    return false;
  }

  return messagePriority <= currentPriority;
}

export function formatArg(arg: unknown) {
  // Primitives
  if (
    arg === null ||
    arg === undefined ||
    typeof arg === "string" ||
    typeof arg === "number" ||
    typeof arg === "boolean" ||
    typeof arg === "symbol"
  ) {
    return String(arg);
  }

  // Functions - avoid printing source code
  if (typeof arg === "function") {
    return "[function]";
  }

  // Errors - preserve message and stack
  if (arg instanceof Error) {
    return `${arg.name || "Error"}: ${arg.message}${
      arg.stack ? `\n${arg.stack}` : ""
    }`;
  }

  // All other objects with a custom replacer
  try {
    const replacer = (_key: string, value: unknown): unknown => {
      if (value instanceof Set) return Array.from(value) as unknown[];
      if (value instanceof Map)
        return Object.fromEntries(value) as Record<string, unknown>;
      if (value instanceof RegExp) return String(value);
      if (typeof value === "bigint") return value.toString();
      return value;
    };

    return stringify(arg, replacer);
  } catch {
    return "[object]";
  }
}

export function summarizeRequest(request: Request): Record<string, unknown> {
  const summary: Record<string, unknown> = { type: request.type };
  if ("modelId" in request) summary["modelId"] = request["modelId"];

  // Only summarize requests with large payloads
  if (request.type === "transcribeStream") {
    const chunk = request["audioChunk"];
    summary["audioChunk"] = `[${chunk.type}: ${chunk.value.length} bytes]`;
    return summary;
  }

  if (request.type === "ocrStream") {
    const img = request["image"];
    summary["image"] = `[${img.type}: ${img.value.length} bytes]`;
    return summary;
  }

  if (request.type === "embed") {
    const text = request["text"];
    if (Array.isArray(text)) {
      const totalLen = text.reduce((sum, t) => sum + t.length, 0);
      summary["text"] = `[${text.length} items, ${totalLen} chars]`;
    } else if (text.length > 200) {
      summary["text"] = `[${text.length} chars]`;
    } else {
      summary["text"] = text;
    }
    return summary;
  }

  if (request.type === "rag") {
    const op = request["operation"];
    if (op === "ingest" || op === "chunk") {
      summary["operation"] = op;
      if ("workspace" in request) summary["workspace"] = request["workspace"];
      const docs = request["documents"];
      if (Array.isArray(docs)) {
        const totalLen = docs.reduce((sum, d) => sum + d.length, 0);
        summary["documents"] = `[${docs.length} docs, ${totalLen} chars]`;
      } else if (docs.length > 200) {
        summary["documents"] = `[${docs.length} chars]`;
      } else {
        summary["documents"] = docs;
      }
      return summary;
    }
    if (op === "saveEmbeddings") {
      summary["operation"] = op;
      if ("workspace" in request) summary["workspace"] = request["workspace"];
      const docs = request["documents"];
      const dims = docs[0]?.embedding?.length ?? 0;
      summary["documents"] =
        `[${docs.length} docs with ${dims}-dim embeddings]`;
      return summary;
    }
  }

  // All other requests - return full request (no large payloads)
  return request as unknown as Record<string, unknown>;
}
