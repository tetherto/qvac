import type { JsonSchema } from "@/schemas/json-schema";

// ============== MCP Client Types (Duck-typed interface) ==============

export type McpTool = {
  name: string;
  description?: string | undefined;
  inputSchema: JsonSchema | Record<string, unknown>;
};

export type McpResource = {
  uri: string;
  name: string;
  description?: string | undefined;
  mimeType?: string | undefined;
};

export type McpToolCallResult = {
  content?: Array<{
    type: string;
    text?: string | undefined;
    data?: string | undefined;
    mimeType?: string | undefined;
  }>;
  toolResult?: unknown;
  isError?: boolean | undefined;
};

export type McpClient = {
  listTools: () => Promise<{ tools: McpTool[]; [key: string]: unknown }>;
  callTool: (params: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<McpToolCallResult | Record<string, unknown>>;
  listResources?: () => Promise<{
    resources: McpResource[];
    [key: string]: unknown;
  }>;
  readResource?: (params: { uri: string }) => Promise<{
    contents: unknown[];
    [key: string]: unknown;
  }>;
};

// ============== Completion MCP Input ==============

export type McpClientInput = {
  client: McpClient;
  includeResources?: boolean;
};
