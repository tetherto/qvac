import type { Tool, ToolCall, ToolCallError } from "@/schemas";

function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

let toolCallSequence = 0;

function generateStableToolCallId(name: string, args: Record<string, unknown>) {
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

function isValidToolCall(obj: unknown): obj is {
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

function validateToolArguments(
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

function parseGemmaFormat(
  text: string,
  tools: Tool[],
): { toolCalls: ToolCall[]; errors: ToolCallError[] } {
  const toolCalls: ToolCall[] = [];
  const errors: ToolCallError[] = [];

  try {
    const parsed = JSON.parse(text) as unknown;

    if (
      parsed &&
      typeof parsed === "object" &&
      "tool_calls" in parsed &&
      Array.isArray(parsed.tool_calls)
    ) {
      for (const callItem of parsed.tool_calls) {
        if (!isValidToolCall(callItem)) {
          continue;
        }

        const call = callItem;

        const validation = validateToolArguments(
          call.name,
          call.arguments,
          tools,
        );

        if (!validation.isValid && validation.error) {
          errors.push({
            ...validation.error,
            raw: JSON.stringify(call),
          });
          continue;
        }

        toolCalls.push({
          id: call.id || generateStableToolCallId(call.name, call.arguments),
          name: call.name,
          arguments: call.arguments,
          raw: JSON.stringify(call),
        });
      }
    }
  } catch {
    // Not Gemma format, continue to next parser
  }

  return { toolCalls, errors };
}

function parseQwenFormat(
  text: string,
  tools: Tool[],
): { toolCalls: ToolCall[]; errors: ToolCallError[] } {
  const toolCalls: ToolCall[] = [];
  const errors: ToolCallError[] = [];

  const toolCallRegex = /<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/g;
  const matches = Array.from(text.matchAll(toolCallRegex));

  for (const match of matches) {
    try {
      const callJson = match[1];
      if (!callJson) continue;

      const trimmedJson = callJson.trim();
      const callItem = JSON.parse(trimmedJson) as unknown;

      if (!isValidToolCall(callItem)) {
        continue;
      }

      const call = callItem;

      const validation = validateToolArguments(
        call.name,
        call.arguments,
        tools,
      );

      if (!validation.isValid && validation.error) {
        errors.push({
          ...validation.error,
          raw: trimmedJson,
        });
        continue;
      }

      toolCalls.push({
        id: call.id || generateStableToolCallId(call.name, call.arguments),
        name: call.name,
        arguments: call.arguments,
        raw: trimmedJson,
      });
    } catch (error) {
      errors.push({
        code: "PARSE_ERROR",
        message: `Failed to parse Qwen tool call: ${error instanceof Error ? error.message : String(error)}`,
        raw: match[1],
      });
    }
  }

  return { toolCalls, errors };
}

function parseLlamacppFormat(
  text: string,
  tools: Tool[],
): { toolCalls: ToolCall[]; errors: ToolCallError[] } {
  const toolCalls: ToolCall[] = [];
  const errors: ToolCallError[] = [];

  try {
    const parsedItem = JSON.parse(text) as unknown;

    if (isValidToolCall(parsedItem)) {
      const parsed = parsedItem;

      const validation = validateToolArguments(
        parsed.name,
        parsed.arguments,
        tools,
      );

      if (!validation.isValid && validation.error) {
        errors.push({
          ...validation.error,
          raw: text,
        });
      } else {
        toolCalls.push({
          id:
            parsed.id ||
            generateStableToolCallId(parsed.name, parsed.arguments),
          name: parsed.name,
          arguments: parsed.arguments,
          raw: text,
        });
      }
    }
  } catch {
    // Not valid JSON format
  }

  return { toolCalls, errors };
}

function parseGenericFormat(
  text: string,
  tools: Tool[],
): { toolCalls: ToolCall[]; errors: ToolCallError[] } {
  const toolCalls: ToolCall[] = [];
  const errors: ToolCallError[] = [];

  const jsonObjectRegex = /\{[\s\S]*?"name"[\s\S]*?"arguments"[\s\S]*?\}/g;
  let match;

  while ((match = jsonObjectRegex.exec(text)) !== null) {
    try {
      const objItem = JSON.parse(match[0]) as unknown;
      if (isValidToolCall(objItem)) {
        const obj = objItem;

        const validation = validateToolArguments(
          obj.name,
          obj.arguments,
          tools,
        );

        if (!validation.isValid && validation.error) {
          errors.push({
            ...validation.error,
            raw: match[0],
          });
          continue;
        }

        toolCalls.push({
          id: obj.id || generateStableToolCallId(obj.name, obj.arguments),
          name: obj.name,
          arguments: obj.arguments,
          raw: match[0],
        });
      }
    } catch (error) {
      errors.push({
        code: "PARSE_ERROR",
        message: `Failed to parse generic tool call: ${error instanceof Error ? error.message : String(error)}`,
        raw: match[0],
      });
    }
  }

  return { toolCalls, errors };
}

export function parseToolCalls(
  text: string,
  tools: Tool[],
): { toolCalls: ToolCall[]; errors: ToolCallError[] } {
  if (!tools || tools.length === 0) {
    return { toolCalls: [], errors: [] };
  }

  const cleaned = stripThinkingBlocks(text);

  let result = parseGemmaFormat(cleaned, tools);
  if (result.toolCalls.length > 0) {
    return result;
  }

  result = parseQwenFormat(cleaned, tools);
  if (result.toolCalls.length > 0) {
    return result;
  }

  result = parseLlamacppFormat(cleaned, tools);
  if (result.toolCalls.length > 0) {
    return result;
  }

  if (cleaned.includes("<tool_call>")) {
    return { toolCalls: [], errors: [] };
  }

  result = parseGenericFormat(cleaned, tools);
  return result;
}

export function convertToolsToGrammar(tools: Tool[]): string {
  const toolSchemas = tools.map((tool) => {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(tool.parameters.properties)) {
      properties[key] = {
        type: value.type,
        ...(value.description && { description: value.description }),
        ...(value.enum && { enum: value.enum }),
      };
    }

    return {
      type: "object",
      properties: {
        name: { type: "string", const: tool.name },
        arguments: {
          type: "object",
          properties,
          required: tool.parameters.required || [],
        },
      },
      required: ["name", "arguments"],
    };
  });

  const grammar = {
    oneOf: toolSchemas,
  };

  return JSON.stringify(grammar);
}
