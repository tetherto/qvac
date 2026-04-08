#!/usr/bin/env bun
/**
 * Generate API documentation from TypeScript source (TypeDoc → MDX).
 * Production implementation per API-DOCS-AUTOMATION-COMPLETE-GUIDE Appendix E.
 *
 * Usage:
 *   bun run scripts/generate-api-docs.ts <version> [--no-update-latest]
 *   bun run scripts/generate-api-docs.ts --dev
 *   bun run scripts/generate-api-docs.ts --rollback
 *
 * --dev writes to content/docs/dev/sdk/api/ without creating a versioned folder
 * or updating (latest). Use during day-to-day development of the next version.
 *
 * Path format: content/docs/v{X.Y.Z}/sdk/api/ and content/docs/(latest)/sdk/api/
 * SDK path: Set SDK_PATH env to point to sdk package (default: ../../packages/sdk from cwd).
 */

import * as fs from "fs/promises";
import * as path from "path";
import { extractApiData } from "./api-docs/extract.js";
import type { ApiFunction, ExpandedType, ErrorEntry, GenerateOptions } from "./api-docs/types.js";

const SDK_PATH =
  process.env.SDK_PATH ||
  path.join(process.cwd(), "..", "..", "packages", "sdk");

async function generateApiDocs(
  version: string,
  options: GenerateOptions = { updateLatest: true }
) {
  if (!options.devMode && !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Invalid version format: "${version}"\nExpected semver: X.Y.Z (e.g., 0.6.1)`
    );
  }

  const label = options.devMode ? "dev" : `v${version}`;
  console.log(`📚 Generating API docs for ${label}...`);
  if (!options.devMode) {
    console.log(
      `   Update latest: ${options.updateLatest ? "yes" : "no (backfill mode)"}`
    );
  }
  console.log(`   SDK path: ${SDK_PATH}`);

  const apiData = await extractApiData(SDK_PATH, version);

  const outputFolder = options.devMode ? "dev" : `v${version}`;
  const outputDir = path.join(
    process.cwd(),
    "content",
    "docs",
    outputFolder,
    "sdk",
    "api"
  );
  await fs.mkdir(outputDir, { recursive: true });

  await Promise.all(
    apiData.functions.map(async (fn) => {
      const mdx = generateMDXForFunction(fn);
      const sanitized = mdx.replace(/\bundefined\b/g, "—").trim();
      if (!sanitized.startsWith("---")) {
        throw new Error(`Generated invalid MDX for ${fn.name} (missing frontmatter)`);
      }
      await fs.writeFile(
        path.join(outputDir, `${fn.name}.mdx`),
        sanitized,
        "utf-8"
      );
    })
  );

  console.log(`✓ Generated ${apiData.functions.length} MDX files`);

  const indexMDX = generateIndexMDX(apiData.functions, label);
  await fs.writeFile(path.join(outputDir, "index.mdx"), indexMDX, "utf-8");
  console.log(`✓ Generated index.mdx`);

  await writeErrorsPage(apiData.errors, outputDir);

  if (!options.devMode && options.updateLatest) {
    await updateLatestSafely(version);
  } else if (!options.devMode) {
    console.log(`⏭️  Skipping latest update (--no-update-latest flag)`);
  }

  await smokeTestDir(outputDir);

  console.log(`✅ API docs generation complete for ${label}`);
  console.log(`   Location: ${outputDir}`);
  console.log(
    `   Files: ${apiData.functions.length + 2} (${apiData.functions.length} functions + index + errors)`
  );
}

// ---------------------------------------------------------------------------
// MDX rendering
// ---------------------------------------------------------------------------

function renderExpandedTypes(types: ExpandedType[], baseDepth: number): string {
  const sections: string[] = [];

  for (const expanded of types) {
    const heading = "#".repeat(Math.min(baseDepth, 5));

    sections.push(`${heading} \`${expanded.typeName}\`

| Field | Type | Required? | Description |
| --- | --- | :---: | --- |
${expanded.fields
  .map((f) => {
    const typeStr = f.type.replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\|/g, "\\|");
    return `| \`${f.name}\` | \`${typeStr}\` | ${f.required ? "✓" : "✗"} | ${(f.description || "—").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\|/g, "\\|")} |`;
  })
  .join("\n")}`);

    if (expanded.children.length > 0) {
      sections.push(renderExpandedTypes(expanded.children, baseDepth + 1));
    }
  }

  return sections.join("\n\n");
}

function generateMDXForFunction(fn: ApiFunction): string {
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
      const typeStr = p.type.replace(/\{/g, "\\{").replace(/\}/g, "\\}");
      const anchor = p.type.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const hasExpansion = fn.expandedParams.some(
        (e) => e.typeName.toLowerCase() === p.type.toLowerCase()
      );
      const typeCell = hasExpansion ? `[\`${typeStr}\`](#${anchor})` : `\`${typeStr}\``;
      return `| \`${p.name}\` | ${typeCell} | ${p.required ? "✓" : "✗"} | ${(p.description || "No description").replace(/\{/g, "\\{").replace(/\}/g, "\\}")} |`;
    }
  )
  .join("\n")}${expandedParamsSection}`
      : "";

  const examplesSection = fn.examples?.length
    ? `## Example

${fn.examples
  .map(
    (ex) => {
      const stripped = ex.replace(/^```\w*\n?/, "").replace(/\n?```\s*$/, "");
      return `\`\`\`typescript\n${stripped}\n\`\`\``;
    }
  )
  .join("\n\n")}`
    : "";

  const desc = String(fn.description ?? "No description available").replace(/"/g, '\\"').replace(/\bundefined\b/g, "—");
  const returnsDesc = String(fn.returns?.description ?? "No description available").replace(/\bundefined\b/g, "—");

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
    const typeStr = f.type.replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\|/g, "\\|");
    return `| \`${f.name}\` | \`${typeStr}\` | ${(f.description || "—").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\|/g, "\\|")} |`;
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

function formatShortSignature(fn: ApiFunction): string {
  const sig = fn.signature.replace(/^function\s+/, "");
  return sig.replace(/\|/g, "\\|");
}

function generateIndexMDX(functions: ApiFunction[], versionLabel: string): string {
  const firstSentence = (text: string) => {
    const match = text.match(/^[^.!?]+[.!?]/);
    return match ? match[0] : text;
  };

  return `---
title: "@qvac/sdk"
titleStyle: code
description: API reference — ${versionLabel}
---

## Overview

\`@qvac/sdk\` npm package exposes a function-centric, typed JS API.

## Functions

| Function | Summary | Signature |
| --- | --- | --- |
${functions
  .map((fn) => {
    const summary = firstSentence(fn.description).replace(/\|/g, "\\|");
    const sig = formatShortSignature(fn);
    return `| [\`${fn.name}()\`](./${fn.name}) | ${summary} | \`${sig}\` |`;
  })
  .join("\n")}

## Errors

See [Errors](./errors) for the full list of SDK error codes.
`;
}

// ---------------------------------------------------------------------------
// Errors page (rendering only — extraction handled by extract.ts)
// ---------------------------------------------------------------------------

async function writeErrorsPage(
  errors: { client: ErrorEntry[]; server: ErrorEntry[] },
  outputDir: string,
): Promise<void> {
  if (errors.client.length === 0 && errors.server.length === 0) {
    console.log("⚠️  No error codes found, skipping errors.mdx");
    return;
  }

  function renderTable(entries: ErrorEntry[]): string {
    return `| Error | Code | Summary |
| --- | --- | --- |
${entries.map((e) => `| \`${e.name}\` | ${e.code} | ${e.summary.replace(/\|/g, "\\|").replace(/[{}]/g, "\\$&")} |`).join("\n")}`;
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

${renderTable(errors.client)}`);
  }

  if (errors.server.length > 0) {
    sections.push(`## Server errors

Thrown by the server (model operations, downloads, cache, RAG). Access via \`SDK_SERVER_ERROR_CODES.{ERROR_NAME}\`.

${renderTable(errors.server)}`);
  }

  await fs.writeFile(
    path.join(outputDir, "errors.mdx"),
    sections.join("\n\n") + "\n",
    "utf-8"
  );
  console.log(`✓ Generated errors.mdx (${errors.client.length} client + ${errors.server.length} server errors)`);
}

// ---------------------------------------------------------------------------
// Latest management & smoke test
// ---------------------------------------------------------------------------

async function updateLatestSafely(version: string) {
  const docsBase = path.join(process.cwd(), "content", "docs");
  const latestApiDir = path.join(docsBase, "(latest)", "sdk", "api");
  const versionApiDir = path.join(docsBase, `v${version}`, "sdk", "api");
  const backupDir = path.join(docsBase, ".latest-api-backup");

  console.log(`📌 Updating (latest)/sdk/api/ to match v${version}...`);

  try {
    const stat = await fs.stat(latestApiDir);
    if (stat.isDirectory()) {
      await fs.rm(backupDir, { recursive: true, force: true });
      await fs.cp(latestApiDir, backupDir, { recursive: true });
      console.log("✓ Backed up current (latest)/sdk/api/ → .latest-api-backup");
    }
  } catch {
    console.log("✓ No previous (latest)/sdk/api/ to backup (first generation)");
  }

  await fs.rm(latestApiDir, { recursive: true, force: true });
  await fs.cp(versionApiDir, latestApiDir, { recursive: true });
  console.log(`✓ Updated (latest)/sdk/api/ → v${version}`);
}

async function smokeTestDir(apiDir: string): Promise<void> {
  console.log(`🧪 Running smoke test...`);

  const indexPath = path.join(apiDir, "index.mdx");
  await fs.stat(indexPath);

  const files = await fs.readdir(apiDir);
  const mdxFiles = files.filter(
    (f) => f.endsWith(".mdx") && f !== "index.mdx"
  );
  if (mdxFiles.length === 0) {
    throw new Error("Smoke test failed: No function docs generated");
  }

  for (const file of mdxFiles) {
    const content = await fs.readFile(
      path.join(apiDir, file),
      "utf-8"
    );
    if (!content.startsWith("---\n")) {
      throw new Error(
        `Smoke test failed: Invalid MDX in ${file} (missing frontmatter)`
      );
    }
    if (!content.includes("title:") || !content.includes("description:")) {
      throw new Error(
        `Smoke test failed: Invalid MDX in ${file} (missing required fields)`
      );
    }
  }

  console.log(`✅ Smoke test passed (${mdxFiles.length} files verified)`);
}

async function rollbackLatest(): Promise<void> {
  const docsBase = path.join(process.cwd(), "content", "docs");
  const latestApiDir = path.join(docsBase, "(latest)", "sdk", "api");
  const backupDir = path.join(docsBase, ".latest-api-backup");

  const backupExists = await fs
    .stat(backupDir)
    .then(() => true)
    .catch(() => false);
  if (!backupExists) {
    console.log("⚠️  No backup available to rollback to");
    return;
  }

  await fs.rm(latestApiDir, { recursive: true, force: true });
  await fs.cp(backupDir, latestApiDir, { recursive: true });
  await fs.rm(backupDir, { recursive: true, force: true });
  console.log("✅ Rolled back (latest)/sdk/api/ to previous version");
}

// CLI
const args = process.argv.slice(2);
const versionArg = args.find((arg) => !arg.startsWith("--"));
const updateLatest = !args.includes("--no-update-latest");
const rollback = args.includes("--rollback");
const devMode = args.includes("--dev");

if (rollback) {
  rollbackLatest()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Rollback failed:", err);
      process.exit(1);
    });
} else if (devMode) {
  generateApiDocs("dev", { updateLatest: false, devMode: true }).catch((error) => {
    console.error("❌ Error generating dev API docs:", error.message);
    if (error.stack) console.error("\nStack trace:", error.stack);
    process.exit(1);
  });
} else if (!versionArg) {
  console.error("❌ Error: Version argument required (or use --dev)\n");
  console.error("Usage:");
  console.error("  bun run scripts/generate-api-docs.ts <version> [flags]");
  console.error("  bun run scripts/generate-api-docs.ts --dev\n");
  console.error("Flags:");
  console.error(
    "  --dev                 Generate into dev/sdk/api/ (no versioned folder)"
  );
  console.error(
    "  --no-update-latest    Skip updating latest/ (use for backfills)"
  );
  console.error("  --rollback            Restore previous version of latest/\n");
  console.error("Examples:");
  console.error("  bun run scripts/generate-api-docs.ts --dev");
  console.error("  bun run scripts/generate-api-docs.ts 0.6.1");
  console.error(
    "  bun run scripts/generate-api-docs.ts 0.5.0 --no-update-latest"
  );
  console.error("  bun run scripts/generate-api-docs.ts --rollback");
  process.exit(1);
} else {
  generateApiDocs(versionArg, { updateLatest }).catch((error) => {
    console.error("❌ Error generating API docs:", error.message);
    if (error.stack) console.error("\nStack trace:", error.stack);
    if (updateLatest) {
      console.log("\n🔄 Attempting rollback...");
      rollbackLatest().catch((e) =>
        console.error("❌ Rollback also failed:", e)
      );
    }
    process.exit(1);
  });
}
