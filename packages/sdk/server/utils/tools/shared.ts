import type { Tool, ToolCall, ToolCallError } from "@/schemas";

export type ParserResult = {
  matched: boolean;
  toolCalls: ToolCall[];
  errors: ToolCallError[];
};

export function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

let toolCallSequence = 0;

export function generateStableToolCallId(
  name: string,
  args: Record<string, unknown>,
) {
  const content = `${name}:${JSON.stringify(args)}`;
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  const sequence = toolCallSequence++;
  return `call_${Math.abs(hash).toString(36)}_${sequence}`;
}

export function isValidToolCall(obj: unknown): obj is {
  name: string;
  arguments: Record<string, unknown>;
  id?: string;
} {
  if (!obj || typeof obj !== "object") {
    return false;
  }
  if (!("name" in obj) || typeof obj.name !== "string") {
    return false;
  }
  if (
    !("arguments" in obj) ||
    typeof obj.arguments !== "object" ||
    obj.arguments === null
  ) {
    return false;
  }
  return true;
}

export function validateToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  tools: Tool[],
): { isValid: boolean; error?: ToolCallError } {
  const tool = tools.find((t) => t.name === toolName);

  if (!tool) {
    return {
      isValid: false,
      error: {
        code: "UNKNOWN_TOOL",
        message: `Tool "${toolName}" not found in available tools`,
      },
    };
  }

  const required = tool.parameters.required || [];
  for (const requiredParam of required) {
    if (!(requiredParam in args)) {
      return {
        isValid: false,
        error: {
          code: "VALIDATION_ERROR",
          message: `Missing required parameter "${requiredParam}" for tool "${toolName}"`,
        },
      };
    }
  }

  return { isValid: true };
}
