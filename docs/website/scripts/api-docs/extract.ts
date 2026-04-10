/**
 * Extraction phase: TypeDoc bootstrap, function extraction, validation,
 * and error-code parsing. Produces an ApiData JSON blob that downstream
 * rendering consumes.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "node:url";
import { Application, ReflectionKind } from "typedoc";
import type { DeclarationReflection, SignatureReflection } from "typedoc";
import type { ApiFunction, ExpandedType, ErrorEntry, ApiData } from "./types.js";
import { auditTsDoc } from "./audit-tsdoc.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_DATA_PATH = path.join(SCRIPT_DIR, "api-data.json");
const EXTRACT_SCRIPT_PATH = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Mtime-based extraction cache
// ---------------------------------------------------------------------------

async function getNewestMtime(dir: string, ext: string): Promise<number> {
  const entries = await fs.readdir(dir, { recursive: true });
  let newest = 0;
  for (const entry of entries) {
    if (!entry.endsWith(ext)) continue;
    const stat = await fs.stat(path.join(dir, entry));
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return newest;
}

async function tryLoadCache(sdkPath: string): Promise<ApiData | null> {
  let cacheStat;
  try {
    cacheStat = await fs.stat(API_DATA_PATH);
  } catch {
    return null;
  }

  const newestSourceMtime = await getNewestMtime(sdkPath, ".ts");

  const extractScriptStat = await fs.stat(EXTRACT_SCRIPT_PATH);
  const sentinelMtime = Math.max(newestSourceMtime, extractScriptStat.mtimeMs);

  if (cacheStat.mtimeMs > sentinelMtime) {
    const raw = await fs.readFile(API_DATA_PATH, "utf-8");
    console.log("⚡ Skipping TypeDoc extraction (api-data.json is up to date)");
    return JSON.parse(raw) as ApiData;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function extractApiData(
  sdkPath: string,
  version: string,
  options?: { forceExtract?: boolean },
): Promise<ApiData> {
  const entryPoint = path.join(sdkPath, "index.ts").replace(/\\/g, "/");
  const tsconfigPath = path.join(sdkPath, "tsconfig.json").replace(/\\/g, "/");

  try {
    await fs.stat(entryPoint);
  } catch {
    throw new Error(
      `SDK entry point not found: ${entryPoint}\n\n` +
        `Either:\n` +
        `  1. Ensure the sdk package exists at: ${sdkPath}\n` +
        `  2. Or set SDK_PATH to your SDK root, e.g.:\n` +
        `     set SDK_PATH=C:\\path\\to\\sdk   (Windows)\n` +
        `     export SDK_PATH=/path/to/sdk     (Linux/macOS)\n` +
        `  Then run: bun run scripts/generate-api-docs.ts 0.7.0`,
    );
  }

  if (!options?.forceExtract) {
    const cached = await tryLoadCache(sdkPath);
    if (cached) return cached;
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

  console.log(`🔍 Auditing TSDoc completeness...`);
  await auditTsDoc(project, sdkPath);

  const apiFunctions = extractApiFunctions(project);
  console.log(`✓ Extracted ${apiFunctions.length} API functions`);

  if (apiFunctions.length === 0) {
    throw new Error(
      "No API functions extracted. Check that:\n" +
        "  1. Functions are exported in index.ts\n" +
        "  2. Functions have JSDoc comments\n" +
        "  3. TypeScript compiles without errors",
    );
  }

  console.log(`🔍 Validating extracted functions...`);
  for (const fn of apiFunctions) {
    validateApiFunction(fn);
  }
  console.log(`✓ Validation passed for all ${apiFunctions.length} functions`);

  const errors = await extractErrors(sdkPath);

  const apiData: ApiData = {
    version,
    generatedAt: new Date().toISOString(),
    functions: apiFunctions,
    errors,
  };

  await fs.writeFile(API_DATA_PATH, JSON.stringify(apiData, null, 2) + "\n", "utf-8");
  console.log(`✓ Wrote ${API_DATA_PATH}`);

  return apiData;
}

// ---------------------------------------------------------------------------
// Error extraction
// ---------------------------------------------------------------------------

async function extractErrors(
  sdkPath: string,
): Promise<{ client: ErrorEntry[]; server: ErrorEntry[] }> {
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

  return {
    client: parseErrorCodes(clientSource, "SDK_CLIENT_ERROR_CODES"),
    server: parseErrorCodes(serverSource, "SDK_SERVER_ERROR_CODES"),
  };
}

function parseErrorCodes(source: string, constantName: string): ErrorEntry[] {
  const codesBlockRe = new RegExp(
    `${constantName}\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*as\\s*const`,
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
      `\\[${constantName}\\.${entry.name}\\]:\\s*\\{[\\s\\S]*?message:\\s*([\\s\\S]*?)\\n\\s*\\},`,
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

// ---------------------------------------------------------------------------
// TypeDoc function extraction
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateApiFunction(fn: ApiFunction): void {
  const errors: string[] = [];
  if (!fn.name?.trim()) errors.push("Missing name");
  if (
    !fn.description?.trim() ||
    fn.description === "undefined" ||
    fn.description === "null"
  ) {
    errors.push(
      `Missing or invalid description (add JSDoc comment in source)`,
    );
  }
  if (!fn.signature?.trim()) errors.push("Missing signature");
  if (
    fn.description &&
    (fn.description.includes("undefined") ||
      fn.description.includes("[object Object]"))
  ) {
    errors.push(
      `Description contains invalid placeholder: "${fn.description}"`,
    );
  }
  if (errors.length > 0) {
    throw new Error(
      `Validation failed for function "${fn.name || "unknown"}":\n` +
        errors.map((e) => `  - ${e}`).join("\n"),
    );
  }
}

// ---------------------------------------------------------------------------
// TypeDoc helpers (module-private)
// ---------------------------------------------------------------------------

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
        `${p.name}${p.flags?.isOptional ? "?" : ""}: ${formatType(p.type)}`,
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
