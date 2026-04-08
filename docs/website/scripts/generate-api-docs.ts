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
import { Application } from "typedoc";
import { ReflectionKind } from "typedoc";
import type { DeclarationReflection, SignatureReflection } from "typedoc";
import type { ApiFunction, ExpandedType, TypeField, ErrorEntry, GenerateOptions } from "./api-docs/types.js";

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

  const entryPoint = path.join(SDK_PATH, "index.ts").replace(/\\/g, "/");
  const tsconfigPath = path.join(SDK_PATH, "tsconfig.json").replace(/\\/g, "/");

  try {
    await fs.stat(entryPoint);
  } catch {
    throw new Error(
      `SDK entry point not found: ${entryPoint}\n\n` +
        `Either:\n` +
        `  1. Ensure the sdk package exists at: ${SDK_PATH}\n` +
        `  2. Or set SDK_PATH to your SDK root, e.g.:\n` +
        `     set SDK_PATH=C:\\path\\to\\sdk   (Windows)\n` +
        `     export SDK_PATH=/path/to/sdk     (Linux/macOS)\n` +
        `  Then run: bun run scripts/generate-api-docs.ts 0.7.0`
    );
  }

  const app = await Application.bootstrapWithPlugins({
    entryPoints: [entryPoint],
    tsconfig: tsconfigPath,
    excludePrivate: true,
    excludeProtected: true,
    excludeExternals: true,
    skipErrorChecking: true,
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

  const indexMDX = generateIndexMDX(apiFunctions, label);
  await fs.writeFile(path.join(outputDir, "index.mdx"), indexMDX, "utf-8");
  console.log(`✓ Generated index.mdx`);

  await generateErrorsPage(SDK_PATH, outputDir);

  if (!options.devMode && options.updateLatest) {
    await updateLatestSafely(version);
  } else if (!options.devMode) {
    console.log(`⏭️  Skipping latest update (--no-update-latest flag)`);
  }

  await smokeTestDir(outputDir);

  console.log(`✅ API docs generation complete for ${label}`);
  console.log(`   Location: ${outputDir}`);
  console.log(
    `   Files: ${apiFunctions.length + 2} (${apiFunctions.length} functions + index + errors)`
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
      expandedParams: ((sig as any).parameters || [])
        .map((p: any) => {
          const typeName = getResolvableTypeName(p.type)
            ?? (p.type?.type === "array" ? getResolvableTypeName(p.type.elementType) : null);
          if (!typeName) return null;
          const visited = new Set<string>([typeName]);
          const target = p.type?.type === "array" ? p.type.elementType : p.type;
          return resolveExpandedType(target, typeName, visited, 0);
        })
        .filter(Boolean) as ExpandedType[],
      returns: {
        type: formatType((sig as any).type),
        description: extractComment((comment as any)?.returns ?? (sig as any).comment?.returns) || "",
      },
      returnFields: (() => {
        const retType = (sig as any).type;
        const props = extractTypeProperties(retType, new Set());
        if (!props) return [];
        return props.map((p: any) => ({
          name: p.name,
          type: formatType(p.type),
          required: !p.flags?.isOptional,
          description: extractComment(p.comment?.summary),
        }));
      })(),
      expandedReturns: (() => {
        const retType = (sig as any).type;
        const results: ExpandedType[] = [];
        const props = extractTypeProperties(retType, new Set());
        if (props) {
          for (const prop of props) {
            const childName = getResolvableTypeName(prop.type)
              ?? (prop.type?.type === "array" ? getResolvableTypeName(prop.type.elementType) : null);
            if (!childName) continue;
            const visited = new Set<string>([childName]);
            const target = prop.type?.type === "array" ? prop.type.elementType : prop.type;
            const expanded = resolveExpandedType(target, childName, visited, 0);
            if (expanded) results.push(expanded);
          }
        }
        return results;
      })(),
      throws: blockTags
        .filter((tag: any) => tag.tag === "@throws")
        .map((tag: any) => {
          const text = extractComment(tag.content);
          const match = text.match(/^\{([^}]+)\}\s*(.*)/);
          if (match) return { error: match[1], description: match[2] };
          return { error: text, description: "" };
        })
        .filter((t: any) => t.error) || [],
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

function resolveExpandedType(
  type: any,
  typeName: string,
  visited: Set<string>,
  depth: number,
): ExpandedType | null {
  if (depth > 4) return null;

  const props = extractTypeProperties(type, visited);
  if (!props || props.length === 0) return null;

  const expanded: ExpandedType = { typeName, fields: [], children: [] };

  for (const prop of props) {
    expanded.fields.push({
      name: prop.name,
      type: formatType(prop.type),
      required: !prop.flags?.isOptional,
      defaultValue: prop.defaultValue ?? undefined,
      description: extractComment(prop.comment?.summary),
    });

    const childTypeName = getResolvableTypeName(prop.type);
    if (childTypeName && !visited.has(childTypeName)) {
      const childVisited = new Set(visited);
      childVisited.add(childTypeName);
      const child = resolveExpandedType(prop.type, childTypeName, childVisited, depth + 1);
      if (child) expanded.children.push(child);
    }

    if (prop.type?.type === "array" && prop.type.elementType) {
      const elName = getResolvableTypeName(prop.type.elementType);
      if (elName && !visited.has(elName)) {
        const childVisited = new Set(visited);
        childVisited.add(elName);
        const child = resolveExpandedType(prop.type.elementType, elName, childVisited, depth + 1);
        if (child) expanded.children.push(child);
      }
    }
  }

  return expanded;
}

function extractTypeProperties(type: any, visited: Set<string>): any[] | null {
  if (!type) return null;

  if (type.type === "reference") {
    const refl = type.reflection ?? type.target;
    if (refl && typeof refl === "object") {
      if (refl.children) return refl.children;
      if (refl.type) return extractTypeProperties(refl.type, visited);
    }
    return null;
  }

  if (type.type === "reflection" && type.declaration) {
    if (type.declaration.children) return type.declaration.children;
    if (type.declaration.signatures) {
      return null;
    }
  }

  if (type.type === "intersection" && type.types) {
    const allProps: any[] = [];
    for (const t of type.types) {
      const props = extractTypeProperties(t, visited);
      if (props) allProps.push(...props);
    }
    return allProps.length > 0 ? allProps : null;
  }

  return null;
}

function getResolvableTypeName(type: any): string | null {
  if (!type) return null;
  if (type.type === "reference" && type.reflection?.children) return type.reflection.name ?? type.name;
  if (type.type === "reference" && type.target?.children) return type.target.name ?? type.name;
  if (type.type === "reflection" && type.declaration?.children) return null;
  return null;
}

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

function parseErrorCodes(source: string, constantName: string): ErrorEntry[] {
  const codesBlockRe = new RegExp(
    `${constantName}\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*as\\s*const`
  );
  const codesMatch = source.match(codesBlockRe);
  if (!codesMatch) return [];

  const entries: ErrorEntry[] = [];
  const lineRe = /(\w+):\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(codesMatch[1])) !== null) {
    entries.push({ name: m[1], code: parseInt(m[2], 10), summary: "" });
  }

  for (const entry of entries) {
    const blockRe = new RegExp(
      `\\[${constantName}\\.${entry.name}\\]:\\s*\\{[\\s\\S]*?message:\\s*([\\s\\S]*?)\\n\\s*\\},`
    );
    const blockMatch = source.match(blockRe);
    if (blockMatch) {
      const messagePart = blockMatch[1].trim();
      let raw = "";
      const stringMatch = messagePart.match(/^"([^"]+)"/);
      const singleMatch = messagePart.match(/^'([^']+)'/);
      if (stringMatch) {
        raw = stringMatch[1];
      } else if (singleMatch) {
        raw = singleMatch[1];
      } else {
        const arrowBodyMatch = messagePart.match(/=>\s*([\s\S]*)/);
        if (arrowBodyMatch) {
          const body = arrowBodyMatch[1].trim();
          const tlMatch = body.match(/`([^`]*)`/);
          const strMatch = body.match(/"([^"]*)"/);
          raw = tlMatch?.[1] ?? strMatch?.[1] ?? "";
        }
      }
      if (raw) {
        entry.summary = raw
          .replace(/\$\{[^}]*\}/g, "…")
          .replace(/\$\{.*$/g, "…")
          .replace(/\s*\+\s*\([\s\S]*?\)/g, "")
          .trim();
      }
    }
    if (!entry.summary) {
      entry.summary = entry.name
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/^./, (c) => c.toUpperCase());
    }
  }

  return entries;
}

async function generateErrorsPage(sdkPath: string, outputDir: string): Promise<void> {
  const schemasDir = path.join(sdkPath, "schemas");
  let clientSource = "";
  let serverSource = "";

  try {
    clientSource = await fs.readFile(path.join(schemasDir, "sdk-errors-client.ts"), "utf-8");
  } catch {
    console.log("⚠️  sdk-errors-client.ts not found, skipping client errors");
  }
  try {
    serverSource = await fs.readFile(path.join(schemasDir, "sdk-errors-server.ts"), "utf-8");
  } catch {
    console.log("⚠️  sdk-errors-server.ts not found, skipping server errors");
  }

  const clientErrors = parseErrorCodes(clientSource, "SDK_CLIENT_ERROR_CODES");
  const serverErrors = parseErrorCodes(serverSource, "SDK_SERVER_ERROR_CODES");

  if (clientErrors.length === 0 && serverErrors.length === 0) {
    console.log("⚠️  No error codes found, skipping errors.mdx");
    return;
  }

  function renderTable(errors: ErrorEntry[]): string {
    return `| Error | Code | Summary |
| --- | --- | --- |
${errors.map((e) => `| \`${e.name}\` | ${e.code} | ${e.summary.replace(/\|/g, "\\|").replace(/[{}]/g, "\\$&")} |`).join("\n")}`;
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

  if (clientErrors.length > 0) {
    sections.push(`## Client errors

Thrown on the client side (response validation, RPC, provider). Access via \`SDK_CLIENT_ERROR_CODES.{ERROR_NAME}\`.

${renderTable(clientErrors)}`);
  }

  if (serverErrors.length > 0) {
    sections.push(`## Server errors

Thrown by the server (model operations, downloads, cache, RAG). Access via \`SDK_SERVER_ERROR_CODES.{ERROR_NAME}\`.

${renderTable(serverErrors)}`);
  }

  await fs.writeFile(
    path.join(outputDir, "errors.mdx"),
    sections.join("\n\n") + "\n",
    "utf-8"
  );
  console.log(`✓ Generated errors.mdx (${clientErrors.length} client + ${serverErrors.length} server errors)`);
}

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
