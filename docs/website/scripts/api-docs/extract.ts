/**
 * Extraction phase: TypeDoc bootstrap, function extraction, validation,
 * and error-code parsing. Produces an ApiData JSON blob that downstream
 * rendering consumes.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { Application, ReflectionKind } from "typedoc";
import type { DeclarationReflection, SignatureReflection } from "typedoc";
import type { ApiFunction, ApiObject, ApiType, ExpandedType, TypeField, ErrorEntry, ApiData } from "./types.js";
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
    plugin: ["typedoc-plugin-zod"],
  });

  const project = await app.convert();
  if (!project) {
    throw new Error("TypeDoc failed to convert project");
  }

  console.log(`✓ TypeDoc analysis complete`);

  buildTypeMap(project);
  initTsProgram(tsconfigPath);

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

  const apiObjects = extractApiObjects(project);
  console.log(`✓ Extracted ${apiObjects.length} API objects`);

  const apiTypes = extractApiTypes(project);
  console.log(`✓ Extracted ${apiTypes.length} shared types`);

  const errors = await extractErrors(sdkPath);

  const apiData: ApiData = {
    version,
    generatedAt: new Date().toISOString(),
    functions: apiFunctions,
    objects: apiObjects.length > 0 ? apiObjects : undefined,
    types: apiTypes.length > 0 ? apiTypes : undefined,
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
        defaultValue: cleanDefaultValue(p.defaultValue),
        description: extractComment(p.comment?.summary) || "",
      })),
      expandedParams: ((sig as any).parameters || [])
        .map((p: any) => {
          const _target = p.type?._target;
          if (_target?.fileName && _target?.qualifiedName) {
            const tsResult = resolveExpandedViaTypeScript(
              _target.fileName,
              _target.qualifiedName,
              _target.pos,
            );
            if (tsResult && tsResult.fields.length > 0) return tsResult;
          }

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
// TypeDoc object extraction (exported variables with object-like shapes)
// ---------------------------------------------------------------------------

function extractApiObjects(project: any): ApiObject[] {
  const objects: ApiObject[] = [];
  const allVars = project.getReflectionsByKind(ReflectionKind.Variable) as DeclarationReflection[];

  for (const refl of allVars) {
    const decl = refl as DeclarationReflection;
    const type = (decl as any).type;
    const props = extractTypeProperties(type, new Set<string>());
    if (!props || props.length === 0) continue;

    const hasMethodMember = props.some((p: any) =>
      p.type?.type === "reflection" && p.type.declaration?.signatures?.length > 0,
    );
    if (!hasMethodMember) continue;

    const sourcePath = (decl.sources?.[0]?.fullFileName ?? (decl as any).sources?.[0]?.file?.fullFileName ?? "") as string;
    const normalizedPath = sourcePath.replace(/\\/g, "/");
    if (normalizedPath && (normalizedPath.includes("/server/") || normalizedPath.includes("/examples/"))) continue;

    const comment = decl.comment;
    const summary = comment?.summary;
    const blockTags = comment?.blockTags ?? [];

    const fields = props.map((p: any) => ({
      name: p.name,
      type: formatType(p.type),
      required: !p.flags?.isOptional,
      defaultValue: cleanDefaultValue(p.defaultValue),
      description: extractComment(p.comment?.summary),
    }));

    const children: ExpandedType[] = [];
    for (const prop of props) {
      const childName = getResolvableTypeName(prop.type)
        ?? (prop.type?.type === "array" ? getResolvableTypeName(prop.type.elementType) : null);
      if (!childName) continue;
      const visited = new Set<string>([childName]);
      const target = prop.type?.type === "array" ? prop.type.elementType : prop.type;
      const expanded = resolveExpandedType(target, childName, visited, 0);
      if (expanded) children.push(expanded);
    }

    const moduleDoc = extractComment(summary)
      ? null
      : readModuleJsDoc(sourcePath);
    const description = extractComment(summary) || moduleDoc?.description || "No description available";
    const extractedExamples = blockTags
      .filter((tag: any) => tag.tag === "@example")
      .map((tag: any) => extractComment(tag.content));
    const examples = extractedExamples.length > 0
      ? extractedExamples
      : moduleDoc?.examples ?? [];

    objects.push({
      name: decl.name,
      description,
      fields,
      children,
      examples,
    });
  }

  return objects.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// TypeDoc shared-type extraction (type aliases + interfaces)
// ---------------------------------------------------------------------------

function extractApiTypes(project: any): ApiType[] {
  const types: ApiType[] = [];

  const allTypeAliases = project.getReflectionsByKind(ReflectionKind.TypeAlias) as DeclarationReflection[];
  const allInterfaces = project.getReflectionsByKind(ReflectionKind.Interface) as DeclarationReflection[];
  const allReflections = [...allTypeAliases, ...allInterfaces];

  for (const refl of allReflections) {
    const decl = refl as DeclarationReflection;

    const sourcePath = (decl.sources?.[0]?.fullFileName ?? (decl as any).sources?.[0]?.file?.fullFileName ?? "") as string;
    const normalizedPath = sourcePath.replace(/\\/g, "/");
    if (normalizedPath && (normalizedPath.includes("/server/") || normalizedPath.includes("/examples/"))) continue;

    const comment = decl.comment;
    const summary = comment?.summary;

    const definition = formatTypeDefinition(decl);
    const members = extractTypeMembers(decl);

    types.push({
      name: decl.name,
      description: extractComment(summary) || "No description available",
      definition,
      members: members.length > 0 ? members : undefined,
    });
  }

  return types.sort((a, b) => a.name.localeCompare(b.name));
}

function formatTypeDefinition(decl: DeclarationReflection): string {
  const type = (decl as any).type;
  if (!type) return `type ${decl.name} = unknown`;

  if (type.type === "union" && type.types) {
    const members = type.types.map((t: any) => {
      if (t.type === "literal") return JSON.stringify(t.value);
      return formatType(t);
    });
    return `type ${decl.name} = ${members.join(" | ")}`;
  }

  if (type.type === "reflection" && type.declaration?.children) {
    const fields = type.declaration.children.map((c: any) => {
      const opt = c.flags?.isOptional ? "?" : "";
      return `  ${c.name}${opt}: ${formatType(c.type)};`;
    });
    return `interface ${decl.name} {\n${fields.join("\n")}\n}`;
  }

  if (decl.children && decl.children.length > 0) {
    const fields = decl.children.map((c: any) => {
      const opt = c.flags?.isOptional ? "?" : "";
      return `  ${c.name}${opt}: ${formatType((c as any).type)};`;
    });
    return `interface ${decl.name} {\n${fields.join("\n")}\n}`;
  }

  return `type ${decl.name} = ${formatType(type)}`;
}

function extractTypeMembers(decl: DeclarationReflection): Array<{ name: string; description: string }> {
  const type = (decl as any).type;

  if (type?.type === "union" && type.types) {
    return type.types
      .filter((t: any) => t.type === "literal" && t.value != null)
      .map((t: any) => ({
        name: String(t.value),
        description: "",
      }));
  }

  const children = decl.children ?? type?.declaration?.children;
  if (children && children.length > 0) {
    return children.map((c: any) => ({
      name: c.name,
      description: extractComment(c.comment?.summary),
    }));
  }

  return [];
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
// Project-wide type lookup (populated once after TypeDoc conversion)
//
// Module-level mutable state: typeMap, tsChecker, tsProgram are initialized
// by extractApiData() via buildTypeMap() and initTsProgram(). All extraction
// helpers depend on this state, so extractApiData() must run first.
// ---------------------------------------------------------------------------

const typeMap = new Map<string, DeclarationReflection>();

function buildTypeMap(project: any): void {
  typeMap.clear();
  const aliases = project.getReflectionsByKind(ReflectionKind.TypeAlias) as DeclarationReflection[];
  const interfaces = project.getReflectionsByKind(ReflectionKind.Interface) as DeclarationReflection[];
  for (const r of [...aliases, ...interfaces]) {
    typeMap.set(r.name, r);
  }
}

// ---------------------------------------------------------------------------
// TypeScript compiler fallback for unresolved references
// ---------------------------------------------------------------------------

let tsChecker: ts.TypeChecker | null = null;
let tsProgram: ts.Program | null = null;

function initTsProgram(tsconfigPath: string): void {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) return;

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsconfigPath),
  );

  tsProgram = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    skipLibCheck: true,
    noEmit: true,
  });
  tsChecker = tsProgram.getTypeChecker();
}

/**
 * Extract a module-level JSDoc block (the first /** ... *\/ comment at the
 * top of a file, above any statements). Used as a fallback description for
 * exports that don't have their own JSDoc but whose module does.
 */
function readModuleJsDoc(
  fileName: string,
): { description: string; examples: string[] } | null {
  if (!tsProgram) return null;
  const normalizedPath = fileName.replace(/\\/g, "/");
  const sourceFile = tsProgram.getSourceFile(normalizedPath);
  if (!sourceFile) return null;

  const fullText = sourceFile.getFullText();
  const firstStatement = sourceFile.statements[0];
  if (!firstStatement) return null;

  const commentRanges = ts.getLeadingCommentRanges(fullText, firstStatement.pos) ?? [];
  const jsdoc = commentRanges.find(
    (r) =>
      r.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
      fullText.slice(r.pos, r.pos + 3) === "/**",
  );
  if (!jsdoc) return null;

  const raw = fullText.slice(jsdoc.pos, jsdoc.end);
  return parseJsDocBlock(raw);
}

function parseJsDocBlock(raw: string): { description: string; examples: string[] } {
  const inner = raw
    .replace(/^\/\*\*\s*/, "")
    .replace(/\s*\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n");

  const exampleRe = /@example\s+([\s\S]*?)(?=\n@\w|$)/g;
  const examples: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = exampleRe.exec(inner)) !== null) {
    examples.push(m[1].trim());
  }

  const description = inner.replace(/@\w+[\s\S]*$/, "").trim();
  return { description, examples };
}

function findTsTypeAlias(
  fileName: string,
  qualifiedName: string,
  pos?: number,
): ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined {
  if (!tsProgram) return undefined;
  const normalizedPath = fileName.replace(/\\/g, "/");
  const sourceFile = tsProgram.getSourceFile(normalizedPath);
  if (!sourceFile) return undefined;

  let target: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined;
  ts.forEachChild(sourceFile, (node) => {
    if (
      (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
      node.name.text === qualifiedName
    ) {
      if (pos == null || Math.abs(node.pos - pos) < 50) {
        target = node;
      }
    }
  });
  return target;
}

/**
 * Given a ts.Type for a property, try to resolve a named type to expand as a
 * child section. Returns the name and the underlying object type, or null.
 */
function resolveNamedChildType(
  propType: ts.Type,
): { name: string; objectType: ts.Type } | null {
  if (!tsChecker) return null;

  let candidate: ts.Type = propType;

  // Unwrap arrays: Array<T> / readonly T[] — drill into element type.
  const refFlags = (ts as any).ObjectFlags?.Reference ?? 4;
  const objectFlags = ((candidate as any).objectFlags ?? 0) as number;
  if (
    (candidate as any).flags & ts.TypeFlags.Object &&
    objectFlags & refFlags &&
    tsChecker.isArrayType?.(candidate)
  ) {
    const args = tsChecker.getTypeArguments(candidate as ts.TypeReference);
    if (args && args[0]) candidate = args[0];
  }

  // Unwrap unions of T | undefined / T | null, keeping the meaningful branch.
  if (candidate.isUnion?.()) {
    const meaningful = (candidate as ts.UnionType).types.filter(
      (t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
    );
    if (meaningful.length === 1) candidate = meaningful[0];
  }

  const aliasName = candidate.aliasSymbol?.name;
  const symbolName = candidate.symbol?.name;
  const name = aliasName ?? symbolName;

  // Only expand named object types with their own property list. Skip
  // anonymous inline objects, intrinsics, utility types like Record<>, etc.
  if (!name || name === "__type" || name === "__object") return null;
  if (BUILTIN_TYPES.has(name)) return null;

  const hasOwnProps = candidate.getProperties().length > 0;
  if (!hasOwnProps) return null;

  return { name, objectType: candidate };
}

const BUILTIN_TYPES = new Set([
  "Promise", "Array", "ReadonlyArray", "Map", "Set", "WeakMap", "WeakSet",
  "Record", "Partial", "Required", "Readonly", "Pick", "Omit", "Exclude",
  "Extract", "NonNullable", "Parameters", "ReturnType", "InstanceType",
  "Date", "RegExp", "Error", "Function", "Object", "String", "Number",
  "Boolean", "Symbol", "BigInt", "AsyncGenerator", "Generator",
  "AsyncIterable", "Iterable", "AsyncIterableIterator", "IterableIterator",
  "Uint8Array", "Int8Array", "Uint16Array", "Int16Array", "Uint32Array",
  "Int32Array", "Float32Array", "Float64Array", "ArrayBuffer",
]);

function resolveViaTypeScript(
  fileName: string,
  qualifiedName: string,
  pos?: number,
): TypeField[] | null {
  if (!tsChecker || !tsProgram) return null;

  const targetNode = findTsTypeAlias(fileName, qualifiedName, pos);
  if (!targetNode) return null;

  const type = tsChecker.getTypeAtLocation(targetNode);
  return extractTsProperties(type, targetNode);
}

function extractTsProperties(type: ts.Type, location: ts.Node): TypeField[] | null {
  if (!tsChecker) return null;

  const props = type.getProperties();
  if (!props || props.length === 0) return null;

  const fields: TypeField[] = [];
  for (const prop of props) {
    const propType = tsChecker.getTypeOfSymbolAtLocation(prop, location);
    const typeStr = tsChecker.typeToString(propType);
    const isOptional = !!(prop.flags & ts.SymbolFlags.Optional);

    const comment = prop.getDocumentationComment(tsChecker);
    const description = comment.map((c) => c.text).join("").trim();

    const jsTags = prop.getJsDocTags(tsChecker);
    const defaultTag = jsTags.find((t) => t.name === "default" || t.name === "defaultValue");
    const defaultValue = defaultTag?.text?.map((t) => t.text).join("").trim();

    fields.push({
      name: prop.name,
      type: typeStr,
      required: !isOptional,
      defaultValue: cleanDefaultValue(defaultValue),
      description,
    });
  }

  return fields;
}

/**
 * Expand a named TS type into an ExpandedType, recursively expanding any
 * named child types referenced by its properties. `visited` prevents cycles.
 */
function expandTsType(
  type: ts.Type,
  typeName: string,
  location: ts.Node,
  visited: Set<string>,
  depth: number,
): ExpandedType | null {
  if (!tsChecker) return null;
  if (depth > 4) return null;

  const fields = extractTsProperties(type, location);
  if (!fields || fields.length === 0) return null;

  const children: ExpandedType[] = [];
  const seen = new Set<string>();
  for (const prop of type.getProperties()) {
    const propType = tsChecker.getTypeOfSymbolAtLocation(prop, location);
    const named = resolveNamedChildType(propType);
    if (!named) continue;
    if (visited.has(named.name) || seen.has(named.name)) continue;
    seen.add(named.name);
    const childVisited = new Set(visited);
    childVisited.add(named.name);
    const child = expandTsType(named.objectType, named.name, location, childVisited, depth + 1);
    if (child) children.push(child);
  }

  return { typeName, fields, children };
}

function resolveExpandedViaTypeScript(
  fileName: string,
  qualifiedName: string,
  pos?: number,
): ExpandedType | null {
  if (!tsChecker || !tsProgram) return null;

  const targetNode = findTsTypeAlias(fileName, qualifiedName, pos);
  if (!targetNode) return null;

  const type = tsChecker.getTypeAtLocation(targetNode);
  const visited = new Set<string>([qualifiedName]);
  return expandTsType(type, qualifiedName, targetNode, visited, 0);
}

// ---------------------------------------------------------------------------
// TypeDoc helpers (module-private)
// ---------------------------------------------------------------------------

function cleanDefaultValue(raw: string | undefined): string | undefined {
  if (!raw || raw === "..." || raw === "undefined") return undefined;
  return raw;
}

function formatType(type: any): string {
  if (!type) return "unknown";
  if (type.type === "intrinsic") return type.name;
  if (type.type === "literal") {
    if (typeof type.value === "string") return `"${type.value}"`;
    if (type.value === null) return "null";
    return String(type.value);
  }
  if (type.type === "reference") {
    const args = (type.typeArguments as any[] | undefined) ?? [];
    if (args.length > 0) {
      return `${type.name}<${args.map(formatType).join(", ")}>`;
    }
    return type.name;
  }
  if (type.type === "union") {
    return type.types.map((t: any) => formatType(t)).join(" | ");
  }
  if (type.type === "intersection") {
    return type.types.map((t: any) => formatType(t)).join(" & ");
  }
  if (type.type === "array") {
    return `${formatType(type.elementType)}[]`;
  }
  if (type.type === "tuple") {
    const elems = (type.elements as any[] | undefined) ?? [];
    return `[${elems.map(formatType).join(", ")}]`;
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
      defaultValue: cleanDefaultValue(prop.defaultValue),
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

    const name = type.name as string | undefined;
    if (name) {
      const alias = typeMap.get(name);
      if (alias) {
        if (alias.children) return alias.children;
        const aliasType = (alias as any).type;
        if (aliasType && !visited.has(name)) {
          visited.add(name);
          return extractTypeProperties(aliasType, visited);
        }
        if (aliasType?.type === "reflection" && aliasType.declaration?.children) {
          return aliasType.declaration.children;
        }
      }
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
  if (type.type === "reference") {
    if (type.reflection?.children) return type.reflection.name ?? type.name;
    if (type.target?.children) return type.target.name ?? type.name;

    const name = type.name as string | undefined;
    if (name && typeMap.has(name)) {
      const alias = typeMap.get(name)!;
      if (alias.children) return name;
      const aliasType = (alias as any).type;
      if (aliasType?.type === "reflection" && aliasType.declaration?.children) return name;
      if (aliasType?.type === "intersection") return name;
    }

    if (type._target?.fileName && name) return name;
  }
  if (type.type === "reflection" && type.declaration?.children) return null;
  return null;
}
