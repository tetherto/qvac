#!/usr/bin/env bun
/**
 * Generate API documentation from TypeScript source (TypeDoc → MDX).
 * Production implementation per API-DOCS-AUTOMATION-COMPLETE-GUIDE Appendix E.
 *
 * Usage:
 *   bun run scripts/generate-api-docs.ts <version> [--no-update-latest]
 *   bun run scripts/generate-api-docs.ts --rollback
 *
 * Path format: content/docs/sdk/api/vX.Y.Z/ and content/docs/sdk/api/latest/
 * SDK path: Set SDK_PATH env to point to sdk package (default: ../sdk from cwd).
 */

import * as fs from "fs/promises";
import * as path from "path";
import { Application } from "typedoc";
import { ReflectionKind } from "typedoc";
import type { DeclarationReflection, SignatureReflection } from "typedoc";

interface ApiFunction {
  name: string;
  signature: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
  }>;
  returns: { type: string; description: string };
  examples?: string[];
  deprecated?: string;
}

interface GenerateOptions {
  updateLatest: boolean;
}

const SDK_PATH =
  process.env.SDK_PATH ||
  path.join(process.cwd(), "..", "sdk");

async function generateApiDocs(
  version: string,
  options: GenerateOptions = { updateLatest: true }
) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Invalid version format: "${version}"\nExpected semver: X.Y.Z (e.g., 0.6.1)`
    );
  }

  console.log(`📚 Generating API docs for v${version}...`);
  console.log(
    `   Update latest: ${options.updateLatest ? "yes" : "no (backfill mode)"}`
  );
  console.log(`   SDK path: ${SDK_PATH}`);

  const entryPoint = path.join(SDK_PATH, "index.ts");
  const tsconfigPath = path.join(SDK_PATH, "tsconfig.json");

  try {
    await fs.stat(entryPoint);
  } catch {
    throw new Error(
      `SDK entry point not found: ${entryPoint}\n\n` +
        `Either:\n` +
        `  1. Clone or copy the sdk package to: ${SDK_PATH}\n` +
        `  2. Or set SDK_PATH to your SDK root, e.g.:\n` +
        `     set SDK_PATH=C:\\path\\to\\sdk   (Windows)\n` +
        `     export SDK_PATH=/path/to/sdk     (Linux/macOS)\n` +
        `  Then run: npm run docs:generate-api -- 0.7.0`
    );
  }

  const app = await Application.bootstrapWithPlugins({
    entryPoints: [entryPoint],
    tsconfig: tsconfigPath,
    excludePrivate: true,
    excludeProtected: true,
    excludeExternals: true,
    skipErrorChecking: true, // SDK may have internal TS errors; we only need the public API surface
  });

  const project = await app.convert();
  if (!project) {
    throw new Error("TypeDoc failed to convert project");
  }

  console.log(`✓ TypeDoc analysis complete`);

  const apiFunctions = extractApiFunctions(project);
  console.log(`✓ Extracted ${apiFunctions.length} API functions`);

  if (apiFunctions.length === 0) {
    throw new Error(
      "No API functions extracted. Check that:\n" +
        "  1. Functions are exported in index.ts\n" +
        "  2. Functions have JSDoc comments\n" +
        "  3. TypeScript compiles without errors"
    );
  }

  console.log(`🔍 Validating extracted functions...`);
  for (const fn of apiFunctions) {
    validateApiFunction(fn);
  }
  console.log(`✓ Validation passed for all ${apiFunctions.length} functions`);

  const outputDir = path.join(
    process.cwd(),
    "content",
    "docs",
    "sdk",
    "api",
    `v${version}`
  );
  await fs.mkdir(outputDir, { recursive: true });

  await Promise.all(
    apiFunctions.map(async (fn) => {
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

  console.log(`✓ Generated ${apiFunctions.length} MDX files`);

  const indexMDX = generateIndexMDX(apiFunctions, version);
  await fs.writeFile(path.join(outputDir, "index.mdx"), indexMDX, "utf-8");
  console.log(`✓ Generated index.mdx`);

  if (options.updateLatest) {
    await updateLatestSafely(version);
  } else {
    console.log(`⏭️  Skipping latest update (--no-update-latest flag)`);
  }

  await smokeTest(version);

  console.log(`✅ API docs generation complete for v${version}`);
  console.log(`   Location: ${outputDir}`);
  console.log(
    `   Files: ${apiFunctions.length + 1} (${apiFunctions.length} functions + index)`
  );
}

function validateApiFunction(fn: ApiFunction): void {
  const errors: string[] = [];
  if (!fn.name?.trim()) errors.push("Missing name");
  if (
    !fn.description?.trim() ||
    fn.description === "undefined" ||
    fn.description === "null"
  ) {
    errors.push(
      `Missing or invalid description (add JSDoc comment in source)`
    );
  }
  if (!fn.signature?.trim()) errors.push("Missing signature");
  if (
    fn.description &&
    (fn.description.includes("undefined") ||
      fn.description.includes("[object Object]"))
  ) {
    errors.push(
      `Description contains invalid placeholder: "${fn.description}"`
    );
  }
  if (errors.length > 0) {
    throw new Error(
      `Validation failed for function "${fn.name || "unknown"}":\n` +
        errors.map((e) => `  - ${e}`).join("\n")
    );
  }
}

function extractApiFunctions(project: any): ApiFunction[] {
  const functions: ApiFunction[] = [];
  const allFunctions = project.getReflectionsByKind(ReflectionKind.Function) as DeclarationReflection[];
  for (const refl of allFunctions) {
    const decl = refl as DeclarationReflection;
    const sig = (decl.signatures?.[0] ?? decl.children?.find((c: any) => c.kind === ReflectionKind.CallSignature)) as SignatureReflection | undefined;
    if (!sig) continue;
    const comment = decl.comment ?? (sig as any).comment;
    const summary = comment?.summary ?? (sig as any).comment?.summary;
    const blockTags = comment?.blockTags ?? (sig as any).comment?.blockTags ?? [];
    const sourcePath = (decl.sources?.[0]?.fullFileName ?? (decl as any).sources?.[0]?.file?.fullFileName ?? "") as string;
    const normalizedPath = sourcePath.replace(/\\/g, "/");
    if (normalizedPath && (normalizedPath.includes("/server/") || normalizedPath.includes("/examples/"))) continue;
    functions.push({
      name: decl.name,
      signature: formatSignature(sig),
      description: extractComment(summary) || "No description available",
      parameters: ((sig as any).parameters || []).map((p: any) => ({
        name: p.name,
        type: formatType(p.type),
        required: !p.flags?.isOptional,
        description: extractComment(p.comment?.summary) || "",
      })),
      returns: {
        type: formatType((sig as any).type),
        description: extractComment((comment as any)?.returns ?? (sig as any).comment?.returns) || "",
      },
      examples: blockTags
        .filter((tag: any) => tag.tag === "@example")
        .map((tag: any) => extractComment(tag.content)) || [],
      deprecated: (() => {
        const depTag = blockTags.find((tag: any) => tag.tag === "@deprecated");
        if (depTag) return extractComment(depTag.content) || "This function is deprecated.";
        if (comment?.isDeprecated) return "This function is deprecated.";
        return undefined;
      })(),
    });
  }
  return functions.sort((a, b) => a.name.localeCompare(b.name));
}

function formatType(type: any): string {
  if (!type) return "unknown";
  if (type.type === "intrinsic") return type.name;
  if (type.type === "reference") return type.name;
  if (type.type === "union") {
    return type.types.map((t: any) => formatType(t)).join(" | ");
  }
  if (type.type === "array") {
    return `${formatType(type.elementType)}[]`;
  }
  return type.toString?.() ?? "unknown";
}

function formatSignature(signature: any): string {
  const params = (signature.parameters || [])
    .map(
      (p: any) =>
        `${p.name}${p.flags?.isOptional ? "?" : ""}: ${formatType(p.type)}`
    )
    .join(", ");
  return `function ${signature.name}(${params}): ${formatType(signature.type)}`;
}

function extractComment(nodes: any): string {
  if (!nodes) return "";
  if (Array.isArray(nodes)) {
    return nodes.map((node: any) => node.text || "").join("");
  }
  return nodes.text || "";
}

function generateMDXForFunction(fn: ApiFunction): string {
  const parametersTable =
    fn.parameters.length > 0
      ? `## Parameters

| Name | Type | Required? | Description |
| --- | --- | :---: | --- |
${fn.parameters
  .map(
    (p) =>
      `| \`${p.name}\` | \`${p.type}\` | ${p.required ? "✓" : "✗"} | ${p.description || "No description"} |`
  )
  .join("\n")}`
      : "";

  const examplesSection = fn.examples?.length
    ? `## Examples

${fn.examples
  .map(
    (ex) => `\`\`\`typescript
${ex}
\`\`\``
  )
  .join("\n\n")}`
    : "";

  const desc = String(fn.description ?? "No description available").replace(/"/g, '\\"').replace(/\bundefined\b/g, "—");
  const returnsDesc = String(fn.returns?.description ?? "No description available").replace(/\bundefined\b/g, "—");
  const bodyDesc = String(fn.description ?? "No description available").replace(/\bundefined\b/g, "—");

  const deprecationCallout = fn.deprecated
    ? `<Callout type="warn" title="Deprecated">\n${fn.deprecated}\n</Callout>\n\n`
    : "";

  return `---
title: "${fn.name}( )"
titleStyle: code
description: "${desc}"
---

${deprecationCallout}\`\`\`typescript
${fn.signature}
\`\`\`

## Description

${bodyDesc}

${parametersTable}

## Returns

\`\`\`typescript
${fn.returns?.type ?? "unknown"}
\`\`\`

${returnsDesc}

${examplesSection}
`.trim();
}

function generateIndexMDX(functions: ApiFunction[], version: string): string {
  return `---
title: "API Reference"
description: Complete API reference for QVAC SDK v${version}
---

## Overview

Complete API reference for **QVAC SDK v${version}** with ${functions.length} functions.

## Available Functions

${functions
  .map((fn) => {
    const badge = fn.deprecated ? " *(deprecated)*" : "";
    return `- [\`${fn.name}()\`](./${fn.name})${badge} - ${fn.description}`;
  })
  .join("\n")}
`;
}

async function updateLatestSafely(version: string) {
  const base = path.join(process.cwd(), "content", "docs", "sdk", "api");
  const latestDir = path.join(base, "latest");
  const versionDir = path.join(base, `v${version}`);
  const backupDir = path.join(base, ".latest-backup");

  console.log(`📌 Updating 'latest' to point to v${version}...`);

  try {
    const stat = await fs.stat(latestDir);
    if (stat.isDirectory()) {
      await fs.rm(backupDir, { recursive: true, force: true });
      await fs.rename(latestDir, backupDir);
      console.log("✓ Backed up current latest → .latest-backup");
    }
  } catch {
    console.log("✓ No previous latest to backup (first generation)");
  }

  await fs.cp(versionDir, latestDir, { recursive: true });
  console.log(`✓ Updated latest → v${version}`);
}

async function smokeTest(version: string): Promise<void> {
  console.log(`🧪 Running smoke test...`);
  const base = path.join(process.cwd(), "content", "docs", "sdk", "api");
  const versionDir = path.join(base, `v${version}`);

  const indexPath = path.join(versionDir, "index.mdx");
  await fs.stat(indexPath);

  const files = await fs.readdir(versionDir);
  const mdxFiles = files.filter(
    (f) => f.endsWith(".mdx") && f !== "index.mdx"
  );
  if (mdxFiles.length === 0) {
    throw new Error("Smoke test failed: No function docs generated");
  }

  for (const file of mdxFiles) {
    const content = await fs.readFile(
      path.join(versionDir, file),
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
  const base = path.join(process.cwd(), "content", "docs", "sdk", "api");
  const latestDir = path.join(base, "latest");
  const backupDir = path.join(base, ".latest-backup");

  const backupExists = await fs
    .stat(backupDir)
    .then(() => true)
    .catch(() => false);
  if (!backupExists) {
    console.log("⚠️  No backup available to rollback to");
    return;
  }

  await fs.rm(latestDir, { recursive: true, force: true });
  await fs.rename(backupDir, latestDir);
  console.log("✅ Rolled back latest to previous version");
}

// CLI
const args = process.argv.slice(2);
const versionArg = args.find((arg) => !arg.startsWith("--"));
const updateLatest = !args.includes("--no-update-latest");
const rollback = args.includes("--rollback");

if (rollback) {
  rollbackLatest()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Rollback failed:", err);
      process.exit(1);
    });
} else if (!versionArg) {
  console.error("❌ Error: Version argument required\n");
  console.error("Usage:");
  console.error("  bun run scripts/generate-api-docs.ts <version> [flags]\n");
  console.error("Flags:");
  console.error(
    "  --no-update-latest    Skip updating latest/ (use for backfills)"
  );
  console.error("  --rollback            Restore previous version of latest/\n");
  console.error("Examples:");
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
