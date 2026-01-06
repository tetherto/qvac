import type { Tool } from "@/schemas/tools";
import type { JsonSchema } from "@/schemas/json-schema";
import type { McpClientInput, McpClient } from "@/schemas/mcp-adapter";
import type { ToolHandler } from "@/utils/tool-helpers";
import { mapValues } from "@/utils/object";

export type { McpClient, McpClientInput } from "@/schemas/mcp-adapter";

export type ToolHandlerMap = Map<string, ToolHandler>;

export type McpToolsResult = {
  tools: Tool[];
  handlers: ToolHandlerMap;
};

const VALID_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
] as const;

type ValidType = (typeof VALID_TYPES)[number];
type PropEntry = { type: ValidType; description?: string; enum?: string[] };
type PropInput = { type?: unknown; description?: string; enum?: string[] };

function isValidType(value: unknown): value is ValidType {
  return typeof value === "string" && VALID_TYPES.includes(value as ValidType);
}

function convertMcpToolToTool(mcpTool: {
  name: string;
  description?: string | undefined;
  inputSchema: JsonSchema | Record<string, unknown>;
}): Tool {
  const inputSchema = mcpTool.inputSchema as JsonSchema;
  const properties = inputSchema.properties ?? {};
  const required = inputSchema.required ?? [];

  const convertedProperties = mapValues(properties, (prop): PropEntry => {
    const { type, description, enum: enumVal } = prop as PropInput;
    return {
      type: isValidType(type) ? type : "string",
      ...(description && { description }),
      ...(enumVal && { enum: enumVal }),
    };
  });

  return {
    type: "function",
    name: mcpTool.name,
    description: mcpTool.description ?? "",
    parameters: {
      type: "object",
      properties: convertedProperties,
      required: required.length > 0 ? required : undefined,
    },
  };
}

function createMcpToolHandler(
  client: McpClient,
  toolName: string,
): ToolHandler {
  return async (args: Record<string, unknown>) => {
    return client.callTool({ name: toolName, arguments: args });
  };
}

export async function getMcpToolsWithHandlers(
  clients: McpClientInput[],
): Promise<McpToolsResult> {
  const allTools: Tool[] = [];
  const handlers: ToolHandlerMap = new Map();

  for (const { client, includeResources } of clients) {
    const { tools: mcpTools } = await client.listTools();

    for (const mcpTool of mcpTools) {
      allTools.push(convertMcpToolToTool(mcpTool));
      handlers.set(mcpTool.name, createMcpToolHandler(client, mcpTool.name));
    }

    if (includeResources !== false && client.listResources) {
      allTools.push({
        type: "function",
        name: "list_resources",
        description: "List available resources from MCP server",
        parameters: {
          type: "object",
          properties: {},
        },
      });
      handlers.set("list_resources", async () => {
        if (!client.listResources) {
          return { resources: [] };
        }
        const result = await client.listResources();
        return {
          type: "text",
          text: JSON.stringify(result.resources, null, 2),
        };
      });

      if (client.readResource) {
        allTools.push({
          type: "function",
          name: "read_resource",
          description: "Read content of a specific resource by URI",
          parameters: {
            type: "object",
            properties: {
              uri: {
                type: "string",
                description: "The URI of the resource to read",
              },
            },
            required: ["uri"],
          },
        });
        handlers.set("read_resource", async (args) => {
          if (!client.readResource) {
            return { error: "readResource not available" };
          }
          const result = await client.readResource({
            uri: args["uri"] as string,
          });
          return result.contents[0];
        });
      }
    }
  }

  return { tools: allTools, handlers };
}

export async function getMcpTools(clients: McpClientInput[]): Promise<Tool[]> {
  const { tools } = await getMcpToolsWithHandlers(clients);
  return tools;
}
