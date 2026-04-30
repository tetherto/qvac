/**
 * MCP DuckDuckGo Search Example
 *
 * A web search example using DuckDuckGo - no API key required!
 * The server provides tools to search the web and get answers.
 *
 * Prerequisites:
 * - Install MCP SDK: bun add @modelcontextprotocol/sdk
 *
 * Run with: bun run examples/mcp-websearch.ts
 */

import {
  completion,
  loadModel,
  unloadModel,
  QWEN3_1_7B_INST_Q4,
} from "@/index";

// MCP SDK is a user-installed optional dependency
// Install with: bun add @modelcontextprotocol/sdk
// eslint-disable-next-line import/no-unresolved
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// eslint-disable-next-line import/no-unresolved
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ============================================================
// Helper: Parse MCP search results into clean format for LLM
// ============================================================
type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type McpContent = {
  type: string;
  text?: string;
};

type McpToolResult = {
  content: McpContent[];
};

type RawSearchResult = {
  title?: string;
  url?: string;
  snippet?: string;
  Description?: string;
};

function parseSearchResults(mcpResult: unknown): string {
  try {
    const result = mcpResult as McpToolResult;

    // Extract text content from MCP response
    const textContent = result.content?.find((c) => c.type === "text");
    if (!textContent?.text) {
      return JSON.stringify(mcpResult);
    }

    // Parse the JSON array of search results
    const rawResults = JSON.parse(textContent.text) as RawSearchResult[];

    // Extract just the useful fields (title, url, snippet)
    const cleanResults: SearchResult[] = rawResults.slice(0, 5).map((r) => ({
      title: r.title ?? "Unknown",
      url: r.url ?? "",
      snippet: r.snippet ?? "",
    }));

    // Format as concise text for LLM
    return cleanResults
      .map(
        (r, i) => `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`,
      )
      .join("\n\n");
  } catch {
    // If parsing fails, return a truncated version
    const str =
      typeof mcpResult === "string" ? mcpResult : JSON.stringify(mcpResult);
    return str.slice(0, 2000);
  }
}

let mcpClient: Client | null = null;

try {
  console.log("🦆 MCP DuckDuckGo Search Example\n");

  // ============================================================
  // STEP 1: Connect to DuckDuckGo MCP server
  // ============================================================
  console.log("1️⃣  Starting DuckDuckGo MCP server...");

  mcpClient = new Client({
    name: "qvac-ddg-example",
    version: "1.0.0",
  });

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@oevortex/ddg_search"],
  });

  await mcpClient.connect(transport);
  console.log("   ✓ MCP server connected\n");

  // ============================================================
  // STEP 2: Load model
  // ============================================================
  console.log("2️⃣  Loading model...");
  const modelId = await loadModel({
    modelSrc: QWEN3_1_7B_INST_Q4,
    modelType: "llm",
    modelConfig: {
      ctx_size: 4096,
      tools: true,
    },
    onProgress: (progress) =>
      process.stdout.write(`\r   Loading: ${progress.percentage.toFixed(1)}%`),
  });
  console.log(`\n   ✓ Model loaded\n`);

  // ============================================================
  // STEP 3: Ask AI to search the web (with MCP client)
  // ============================================================
  const history = [
    {
      role: "system",
      content: `You are a helpful assistant with access to web search.
Use the search tool when you need current information.
Always cite your sources with the URL.`,
    },
    {
      role: "user",
      content: "What is the current weather in New York City?",
    },
  ];

  console.log("3️⃣  Asking AI to search the web...\n");
  console.log("🤖 AI Response:");

  // Pass MCP client directly to completion - tools are adapted internally!
  const result = completion({
    modelId,
    history,
    stream: true,
    mcp: [{ client: mcpClient, includeResources: false }],
  });

  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }

  const toolCalls = await result.toolCalls;
  console.log("\n");

  // ============================================================
  // STEP 4: Execute tool calls using call() - automatic MCP routing!
  // ============================================================
  if (toolCalls.length > 0) {
    console.log("4️⃣  Executing search...\n");

    const toolResults: Array<{ id: string; result: string }> = [];

    for (const toolCall of toolCalls) {
      console.log(`🔍 ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`);

      if (!toolCall.invoke) {
        console.log(`   ⚠️ No handler found for tool "${toolCall.name}"`);
        continue;
      }

      // Use invoke() - automatically routes to the correct MCP client!
      const mcpResult = await toolCall.invoke();

      // Parse and clean up the search results
      const cleanResult = parseSearchResults(mcpResult);

      console.log(`   ✓ Got search results:`);
      console.log(
        cleanResult
          .split("\n")
          .map((l) => `      ${l}`)
          .join("\n"),
      );
      console.log();

      toolResults.push({ id: toolCall.id, result: cleanResult });
    }

    // ============================================================
    // STEP 5: Continue with search results
    // ============================================================
    console.log("5️⃣  Getting AI response with search results...\n");

    history.push({
      role: "assistant",
      content: await result.text,
    });

    for (const tr of toolResults) {
      history.push({
        role: "tool",
        content: tr.result,
      });
    }

    console.log("🤖 Final Response:");
    const finalResult = completion({
      modelId,
      history,
      stream: true,
      mcp: [{ client: mcpClient, includeResources: false }],
    });

    for await (const token of finalResult.tokenStream) {
      process.stdout.write(token);
    }
    console.log("\n");
  }

  // ============================================================
  // Cleanup
  // ============================================================
  console.log("6️⃣  Cleaning up...");
  await unloadModel({ modelId, clearStorage: false });
  console.log("   ✓ Done\n");

  console.log("🎉 Example completed!");
  process.exit(0);
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
} finally {
  if (mcpClient) {
    try {
      await mcpClient.close();
    } catch {
      // Ignore close errors
    }
  }
}
