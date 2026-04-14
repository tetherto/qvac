/**
 * Rendering phase: reads extracted api-data.json and produces MDX files.
 * Complex section rendering is handled by TypeScript helpers (direct ports
 * of the former monolith functions) registered as Nunjucks globals.
 * Page-level assembly uses Nunjucks templates in scripts/api-docs/templates/.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "node:url";
import nunjucks from "nunjucks";
import type { ApiData, ApiFunction, ExpandedType, TypeField, ErrorEntry } from "./types.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(SCRIPT_DIR, "templates");

export interface RenderOptions {
  versionLabel: string;
}

// ---------------------------------------------------------------------------
// Nunjucks environment
// ---------------------------------------------------------------------------

function createEnv(): nunjucks.Environment {
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader(TEMPLATE_DIR),
    { autoescape: false, trimBlocks: true, lstripBlocks: true },
  );

  env.addFilter("escapeTable", escapeTable);
  env.addFilter("escapeTableLight", escapeTableLight);
  env.addFilter("firstSentence", firstSentence);
  env.addFilter("slugify", slugify);
  env.addFilter("formatShortSignature", formatShortSignature);
  env.addFilter("escapeQuotes", escapeQuotes);
  env.addFilter("stripFence", stripFence);

  env.addGlobal("renderExpandedTypes", renderExpandedTypes);
  env.addGlobal("renderErrorTable", renderErrorTable);
  env.addGlobal("renderFunctionPage", renderFunctionPage);
  env.addGlobal("renderIndexPage", renderIndexPage);
  env.addGlobal("renderErrorsPage", renderErrorsPageContent);

  return env;
}

// ---------------------------------------------------------------------------
// Filters — each replicates logic formerly inlined in generate-api-docs.ts
// ---------------------------------------------------------------------------

/** Escape backslashes, pipes, and braces for error-table cells. */
export function escapeTable(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[{}]/g, "\\$&");
}

/**
 * Escape braces and pipes for type strings and descriptions inside
 * parameter / field tables (does NOT escape leading backslashes).
 */
export function escapeTableLight(str: string): string {
  return str
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\|/g, "\\|");
}

/** Extract the first sentence from a block of text. */
export function firstSentence(text: string): string {
  const match = text.match(/^[^.!?]+[.!?]/);
  return match ? match[0] : text;
}

/** Convert a string to a URL-safe anchor slug. */
export function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Strip leading `function ` keyword and escape pipes for table display. */
export function formatShortSignature(sig: string): string {
  return sig.replace(/^function\s+/, "").replace(/\|/g, "\\|");
}

/** Escape double-quotes for safe embedding in YAML frontmatter values. */
export function escapeQuotes(str: string): string {
  return str.replace(/"/g, '\\"');
}

/** Strip surrounding code fences from an example string. */
export function stripFence(str: string): string {
  return str.replace(/^```\w*\n?/, "").replace(/\n?```\s*$/, "");
}

// ---------------------------------------------------------------------------
// Globals — section rendering helpers (direct ports from monolith)
// ---------------------------------------------------------------------------

export function renderExpandedTypes(types: ExpandedType[], baseDepth: number): string {
  const sections: string[] = [];

  for (const expanded of types) {
    const heading = "#".repeat(Math.min(baseDepth, 5));

    sections.push(`${heading} \`${expanded.typeName}\`

| Field | Type | Required? | Description |
| --- | --- | :---: | --- |
${expanded.fields
  .map((f) => {
    const typeStr = escapeTableLight(f.type);
    return `| \`${f.name}\` | \`${typeStr}\` | ${f.required ? "\u2713" : "\u2717"} | ${escapeTableLight(f.description || "\u2014")} |`;
  })
  .join("\n")}`);

    if (expanded.children.length > 0) {
      sections.push(renderExpandedTypes(expanded.children, baseDepth + 1));
    }
  }

  return sections.join("\n\n");
}

export function renderErrorTable(entries: ErrorEntry[]): string {
  return `| Error | Code | Summary |
| --- | --- | --- |
${entries.map((e) => `| \`${e.name}\` | ${e.code} | ${escapeTable(e.summary)} |`).join("\n")}`;
}

export function renderFunctionPage(fn: ApiFunction): string {
  const expandedParamsSection = fn.expandedParams.length > 0
    ? "\n\n" + renderExpandedTypes(fn.expandedParams, 3)
    : "";

  const parametersTable =
    fn.parameters.length > 0
      ? `## Parameters

| Name | Type | Required? | Description |
| --- | --- | :---: | --- |
${fn.parameters
  .map(
    (p) => {
      const typeStr = escapeTableLight(p.type);
      const anchor = slugify(p.type);
      const hasExpansion = fn.expandedParams.some(
        (e) => e.typeName.toLowerCase() === p.type.toLowerCase(),
      );
      const typeCell = hasExpansion ? `[\`${typeStr}\`](#${anchor})` : `\`${typeStr}\``;
      return `| \`${p.name}\` | ${typeCell} | ${p.required ? "\u2713" : "\u2717"} | ${escapeTableLight(p.description || "No description")} |`;
    },
  )
  .join("\n")}${expandedParamsSection}`
      : "";

  const examplesSection = fn.examples?.length
    ? `## Example

${fn.examples
  .map(
    (ex) => {
      const stripped = stripFence(ex);
      return `\`\`\`typescript\n${stripped}\n\`\`\``;
    },
  )
  .join("\n\n")}`
    : "";

  const desc = String(fn.description ?? "No description available").replace(/"/g, '\\"').replace(/\bundefined\b/g, "\u2014");
  const returnsDesc = String(fn.returns?.description ?? "No description available").replace(/\bundefined\b/g, "\u2014");

  const deprecationCallout = fn.deprecated
    ? `<Callout type="warn" title="Deprecated">\n${fn.deprecated}\n</Callout>\n\n`
    : "";

  const throwsSection = fn.throws?.length
    ? `## Throws

| Error | When |
| --- | --- |
${fn.throws.map((t) => `| \`${t.error}\` | ${t.description} |`).join("\n")}`
    : "";

  const returnFieldsTable = fn.returnFields.length > 0
    ? `\n\n| Field | Type | Description |
| --- | --- | --- |
${fn.returnFields
  .map((f) => {
    const typeStr = escapeTableLight(f.type);
    return `| \`${f.name}\` | \`${typeStr}\` | ${escapeTableLight(f.description || "\u2014")} |`;
  })
  .join("\n")}`
    : "";

  const expandedReturnsSection = fn.expandedReturns.length > 0
    ? "\n\n" + renderExpandedTypes(fn.expandedReturns, 3)
    : "";

  return `---
title: "${fn.name}( )"
titleStyle: code
description: "${desc}"
---

${deprecationCallout}\`\`\`typescript
${fn.signature}
\`\`\`

${parametersTable}

## Returns

\`\`\`typescript
${fn.returns?.type ?? "unknown"}
\`\`\`

${returnsDesc}${returnFieldsTable}${expandedReturnsSection}

${throwsSection}

${examplesSection}
`.trim();
}

export function renderIndexPage(functions: ApiFunction[], versionLabel: string): string {
  return `---
title: "@qvac/sdk"
titleStyle: code
description: API reference \u2014 ${versionLabel}
---

## Overview

\`@qvac/sdk\` npm package exposes a function-centric, typed JS API.

## Functions

| Function | Summary | Signature |
| --- | --- | --- |
${functions
  .map((fn) => {
    const summary = firstSentence(fn.description).replace(/\|/g, "\\|");
    const sig = formatShortSignature(fn.signature);
    return `| [\`${fn.name}()\`](./${fn.name}) | ${summary} | \`${sig}\` |`;
  })
  .join("\n")}

## Errors

See [Errors](./errors) for the full list of SDK error codes.
`;
}

export function renderErrorsPageContent(errors: { client: ErrorEntry[]; server: ErrorEntry[] }): string | null {
  if (errors.client.length === 0 && errors.server.length === 0) {
    return null;
  }

  const sections: string[] = [];

  sections.push(`---
title: Errors
description: SDK error codes reference
---

## Example

\`\`\`typescript
import { SDK_CLIENT_ERROR_CODES, SDK_SERVER_ERROR_CODES } from "@qvac/sdk";

try {
  await loadModel({ modelSrc: "/path/to/model.gguf", modelType: "llm" });
} catch (error) {
  if (error.code === SDK_SERVER_ERROR_CODES.MODEL_LOAD_FAILED) {
    // handle model load failure
  }
}
\`\`\``);

  if (errors.client.length > 0) {
    sections.push(`## Client errors

Thrown on the client side (response validation, RPC, provider). Access via \`SDK_CLIENT_ERROR_CODES.{ERROR_NAME}\`.

${renderErrorTable(errors.client)}`);
  }

  if (errors.server.length > 0) {
    sections.push(`## Server errors

Thrown by the server (model operations, downloads, cache, RAG). Access via \`SDK_SERVER_ERROR_CODES.{ERROR_NAME}\`.

${renderErrorTable(errors.server)}`);
  }

  return sections.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function renderApiDocs(
  dataPath: string,
  outputDir: string,
  options: RenderOptions,
): Promise<void> {
  const raw = await fs.readFile(dataPath, "utf-8");
  const apiData: ApiData = JSON.parse(raw);

  const env = createEnv();
  await fs.mkdir(outputDir, { recursive: true });

  await Promise.all(
    apiData.functions.map(async (fn) => {
      const mdx = renderFunctionPage(fn);
      const sanitized = mdx.replace(/\bundefined\b/g, "\u2014").trim();
      if (!sanitized.startsWith("---")) {
        throw new Error(
          `Generated invalid MDX for ${fn.name} (missing frontmatter)`,
        );
      }
      await fs.writeFile(
        path.join(outputDir, `${fn.name}.mdx`),
        sanitized,
        "utf-8",
      );
    }),
  );
  console.log(`\u2713 Generated ${apiData.functions.length} MDX files`);

  const indexMdx = renderIndexPage(apiData.functions, options.versionLabel);
  await fs.writeFile(path.join(outputDir, "index.mdx"), indexMdx, "utf-8");
  console.log("\u2713 Generated index.mdx");

  const errorsMdx = renderErrorsPageContent(apiData.errors);
  if (errorsMdx) {
    await fs.writeFile(
      path.join(outputDir, "errors.mdx"),
      errorsMdx,
      "utf-8",
    );
    console.log(
      `\u2713 Generated errors.mdx (${apiData.errors.client.length} client + ${apiData.errors.server.length} server errors)`,
    );
  } else {
    console.log("\u26a0\ufe0f  No error codes found, skipping errors.mdx");
  }
}
