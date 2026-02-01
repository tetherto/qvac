import type { z } from "zod";
import {
  toolSchema,
  type Tool,
  type ToolCall,
  type ToolCallWithCall,
} from "@/schemas/tools";
import {
  InvalidToolsArrayError,
  InvalidToolSchemaError,
} from "@/utils/errors-client";

type ZodObjectType = z.ZodObject<z.ZodRawShape>;

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export type ToolInput<T extends ZodObjectType = ZodObjectType> = {
  name: string;
  description: string;
  parameters: T;
  handler?: ToolHandler;
};

function zodTypeToJsonSchemaType(
  type: string,
): "string" | "number" | "integer" | "boolean" | "object" | "array" {
  switch (type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    case "array":
      return "array";
    case "optional":
    default:
      return "string";
  }
}

export function convertToolInput(input: ToolInput): Tool {
  const zodSchema = input.parameters as unknown as {
    shape?: Record<string, unknown>;
    def?: { shape?: Record<string, unknown> };
  };

  // Try both shape and def.shape for Zod v4 compatibility
  const shape =
    zodSchema.shape ||
    (typeof zodSchema.def?.shape === "object" ? zodSchema.def.shape : {});

  const properties: Record<
    string,
    {
      type: "string" | "number" | "integer" | "boolean" | "object" | "array";
      description?: string;
      enum?: string[];
    }
  > = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const field = value as {
      type?: string;
      description?: string;
      def?: {
        type?: string;
        values?: string[];
        innerType?: {
          type?: string;
          description?: string;
          def?: { type?: string };
        };
      };
    };

    const fieldType = field.type || field.def?.type || "string";
    const isOptional = fieldType === "optional";

    let actualType = isOptional ? "string" : fieldType;
    let actualDescription = field.description;

    if (isOptional && field.def?.innerType) {
      const innerType = field.def.innerType;
      actualType = innerType.type || innerType.def?.type || "string";
      // Get description from inner type if not on wrapper
      if (!actualDescription && innerType.description) {
        actualDescription = innerType.description;
      }
    }

    properties[key] = {
      type: zodTypeToJsonSchemaType(actualType),
    };

    if (actualDescription) {
      properties[key].description = actualDescription;
    }

    if (field.def?.values) {
      properties[key].enum = field.def.values;
    }

    if (!isOptional) {
      required.push(key);
    }
  }

  const tool: Tool = {
    type: "function",
    name: input.name,
    description: input.description,
    parameters: {
      type: "object",
      properties,
      required: required.length > 0 ? required : undefined,
    },
  };

  return toolSchema.parse(tool);
}

export function convertTools(inputs: ToolInput[]): Tool[] {
  return inputs.map(convertToolInput);
}

/**
 * Validates and converts tools from either ToolInput (with Zod schemas) or full Tool format.
 * Returns validated Tool[] array.
 */
export type ToolHandlerMap = Map<string, ToolHandler>;

export type ValidateToolsResult = {
  tools: Tool[];
  handlers: ToolHandlerMap;
};

export function validateTools(
  tools: Tool[] | ToolInput[],
): ValidateToolsResult {
  if (tools.length === 0) {
    return { tools: [], handlers: new Map() };
  }

  const firstTool = tools[0];
  if (!firstTool) {
    throw new InvalidToolsArrayError();
  }

  const handlers: ToolHandlerMap = new Map();

  const parseResult = toolSchema.safeParse(firstTool);

  if (parseResult.success) {
    const validatedTools: Tool[] = [];
    for (const tool of tools as Tool[]) {
      const result = toolSchema.safeParse(tool);
      if (!result.success) {
        throw new InvalidToolSchemaError(result.error.message, result.error);
      }
      validatedTools.push(result.data);
    }
    return { tools: validatedTools, handlers };
  } else {
    const toolInputs = tools as ToolInput[];
    const convertedTools = convertTools(toolInputs);

    for (const toolInput of toolInputs) {
      if (toolInput.handler) {
        handlers.set(toolInput.name, toolInput.handler);
      }
    }

    return { tools: convertedTools, handlers };
  }
}

export function attachHandlersToToolCalls(
  toolCalls: ToolCall[],
  handlers: ToolHandlerMap,
): ToolCallWithCall[] {
  return toolCalls.map((toolCall) => {
    const handler = handlers.get(toolCall.name);
    if (handler) {
      return {
        ...toolCall,
        invoke: async () => await handler(toolCall.arguments),
      };
    }
    return toolCall;
  });
}
