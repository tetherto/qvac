/**
 * Extraction phase: TypeDoc bootstrap, function extraction, validation,
 * and error-code parsing. Produces an ApiData JSON blob that downstream
 * rendering consumes.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { Application, ReflectionKind } from "typedoc";
import type { DeclarationReflection, SignatureReflection } from "typedoc";
import type { ApiFunction, ApiObject, ApiOverload, ExpandedType, TypeField, ErrorEntry, ApiData, StructuredType } from "./types.js";
import { auditTsDoc } from "./audit-tsdoc.js";
import {
  readSampleProse,
  readIndexSummaries,
  type SampleFunctionProse,
} from "./sample-parser.js";
import {
  extractZodDescriptions,
  type ZodDescriptionMap,
} from "./zod-describe-extractor.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_DATA_PATH = path.join(SCRIPT_DIR, "api-data.json");
const EXTRACT_SCRIPT_PATH = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Reproducible build timestamp
// ---------------------------------------------------------------------------

/**
 * Resolve the value emitted as `ApiData.generatedAt`. Honors the
 * `SOURCE_DATE_EPOCH` environment variable (reproducible-builds convention)
 * so CI and byte-identity tests produce the same JSON given identical
 * inputs. Without it, falls back to the literal string `"unspecified"` —
 * deliberately constant so byte-identity checks pass without requiring the
 * caller to set an env var.
 */
function resolveGeneratedAt(): string {
  const raw = process.env.SOURCE_DATE_EPOCH;
  if (raw && /^\d+$/.test(raw)) {
    return new Date(Number(raw) * 1000).toISOString();
  }
  return "unspecified";
}

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

async function tryLoadCache(
  sdkPath: string,
  samplesDir?: string,
): Promise<ApiData | null> {
  let cacheStat;
  try {
    cacheStat = await fs.stat(API_DATA_PATH);
  } catch {
    return null;
  }

  // Newest SDK source + every pipeline file that affects extraction /
  // rendering. Missing any of these from the sentinel leaves stale cache
  // hits when contributors change the helpers without touching SDK source.
  const newestSourceMtime = await getNewestMtime(sdkPath, ".ts");
  const newestSamplesMtime = samplesDir
    ? await getNewestMtime(samplesDir, ".mdx").catch(() => 0)
    : 0;
  const newestTemplatesMtime = await getNewestMtime(
    path.join(SCRIPT_DIR, "templates"),
    ".njk",
  ).catch(() => 0);

  const helperMtimes: number[] = [];
  const helperFiles = [
    EXTRACT_SCRIPT_PATH,
    path.join(SCRIPT_DIR, "types.ts"),
    path.join(SCRIPT_DIR, "sample-parser.ts"),
    path.join(SCRIPT_DIR, "zod-describe-extractor.ts"),
    path.join(SCRIPT_DIR, "audit-tsdoc.ts"),
    path.join(SCRIPT_DIR, "render.ts"),
  ];
  for (const file of helperFiles) {
    try {
      const s = await fs.stat(file);
      helperMtimes.push(s.mtimeMs);
    } catch {
      // missing helper file — ignore
    }
  }

  const sentinelMtime = Math.max(
    newestSourceMtime,
    newestSamplesMtime,
    newestTemplatesMtime,
    ...helperMtimes,
  );

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
  options?: { forceExtract?: boolean; samplesDir?: string },
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
    const cached = await tryLoadCache(sdkPath, options?.samplesDir);
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
  await loadZodDescriptions(path.join(sdkPath, "schemas"));
  await loadSampleProse(options?.samplesDir);

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

  // Fill gaps in the TypeScript-extracted data with prose from hand-authored
  // samples. JSDoc prose always wins; samples only populate empty fields.
  if (sampleProseCache.size > 0) {
    for (const fn of apiFunctions) applySampleProseToFunction(fn);
    console.log(
      `\u2713 Applied sample-prose fallback to ${apiFunctions.length} functions`,
    );
  }

  console.log(`🔍 Validating extracted functions...`);
  for (const fn of apiFunctions) {
    validateApiFunction(fn);
  }
  console.log(`✓ Validation passed for all ${apiFunctions.length} functions`);

  const apiObjects = extractApiObjects(project);
  if (sampleProseCache.size > 0) {
    for (const obj of apiObjects) applySampleProseToObject(obj);
  }
  // Mirror `validateApiFunction` across object methods so `profiler.enable`
  // (and friends) cannot ship with missing descriptions. Prefix the method
  // name with its parent object so validation errors remain informative.
  for (const obj of apiObjects) {
    if (!obj.methods) continue;
    for (const m of obj.methods) {
      validateApiFunction({ ...m, name: `${obj.name}.${m.name}` });
    }
  }
  console.log(`✓ Extracted ${apiObjects.length} API objects`);

  // The single-page summary intentionally drops shared-types and constants
  // pages — those details live in `.d.ts` for IDE/agent consumption. We
  // skip the (slow, error-prone) extraction passes that fed them.
  const errors = await extractErrors(sdkPath);

  const apiData: ApiData = {
    $schema: "./api-data.schema.json",
    version,
    generatedAt: resolveGeneratedAt(),
    functions: apiFunctions,
    objects: apiObjects.length > 0 ? apiObjects : undefined,
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

/**
 * Build a lookup map from dotted `@param` JSDoc tags so nested field
 * descriptions can be surfaced automatically.
 *
 * For source like:
 *   @param params - The completion parameters
 *   @param params.modelId - The identifier of the model
 *   @param params.history - Array of conversation messages
 *
 * Returns a map `{ "params.modelId" -> "The identifier of the model", ... }`.
 */
function buildParamDocsMap(blockTags: any[]): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(blockTags)) return map;
  for (const tag of blockTags) {
    if (tag?.tag !== "@param") continue;
    const name = typeof tag.name === "string" ? tag.name : "";
    if (!name || !name.includes(".")) continue;
    const desc = extractComment(tag.content).trim();
    if (desc) map.set(name, desc);
  }
  return map;
}

/**
 * Walk an ExpandedType tree and fill in empty field descriptions from the
 * dotted `@param` map. The map keys use the outer parameter name (`paramName`)
 * plus the dotted field path (e.g., `params.modelId`).
 */
function applyParamDocsToExpanded(
  expanded: ExpandedType,
  paramName: string,
  paramDocs: Map<string, string>,
): void {
  if (paramDocs.size === 0) return;
  const prefix = `${paramName}.`;
  const walk = (node: ExpandedType, path: string) => {
    for (const f of node.fields) {
      if (f.description && f.description.trim() !== "") continue;
      const doc = paramDocs.get(`${path}${f.name}`);
      if (doc) f.description = doc;
    }
    for (const child of node.children) {
      walk(child, `${path}${child.typeName}.`);
    }
  };
  walk(expanded, prefix);
}

/**
 * Build an ApiFunction record from a TypeDoc declaration + signature pair.
 * Used for both top-level exported functions and object methods.
 */
function buildApiFunction(
  name: string,
  decl: DeclarationReflection | null,
  sig: SignatureReflection,
  commentOverride?: any,
  allSignatures?: SignatureReflection[],
): ApiFunction {
  const comment = commentOverride ?? decl?.comment ?? (sig as any).comment;
  const summary = comment?.summary ?? (sig as any).comment?.summary;
  const blockTags = comment?.blockTags ?? (sig as any).comment?.blockTags ?? [];
  const paramDocs = buildParamDocsMap(blockTags);

  // Collect syntactic param/return types up-front so the expansion loop below
  // can fall back to the author's alias names when TypeDoc's `_target` info
  // is missing (common for `z.discriminatedUnion`).
  const sourcePath =
    (decl?.sources?.[0]?.fullFileName ??
      (decl as any)?.sources?.[0]?.file?.fullFileName ??
      "") as string;
  const syntacticParams = new Map<string, string>();
  if (sourcePath) {
    const read = readFunctionParamTypes(sourcePath, name);
    if (read) {
      for (const p of read) {
        if (p.isReference) syntacticParams.set(p.name, p.syntactic);
      }
    }
  }
  let syntacticReturn: string | null = null;
  if (sourcePath) {
    const ret = readFunctionReturnType(sourcePath, name);
    if (ret && ret.isReference) syntacticReturn = ret.syntactic;
  }

  const expandedParams = ((sig as any).parameters || [])
    .map((p: any) => {
      let result: ExpandedType | null = null;

      const _target = p.type?._target;
      if (_target?.fileName && _target?.qualifiedName) {
        const tsResult = resolveExpandedViaTypeScript(
          _target.fileName,
          _target.qualifiedName,
          _target.pos,
        );
        // Accept results that have either direct fields (normal object types)
        // or child variants (discriminated unions with no shared fields).
        if (tsResult && (tsResult.fields.length > 0 || tsResult.children.length > 0)) {
          result = tsResult;
        }
      }

      if (!result) {
        const typeName = getResolvableTypeName(p.type)
          ?? (p.type?.type === "array" ? getResolvableTypeName(p.type.elementType) : null);
        if (typeName) {
          const visited = new Set<string>([typeName]);
          const target = p.type?.type === "array" ? p.type.elementType : p.type;
          result = resolveExpandedType(target, typeName, visited, 0);
        }
      }

      if (!result) {
        // Anonymous inline object parameter type (e.g., `opts: { a, b }`).
        // Use the parameter name as the heading for the sub-section, but
        // also pass any named alias (from the original reference type) as
        // an ancestor hint so `.describe()` strings attached to a schema
        // like `RPCOptions` -> `rpcOptionsSchema` still resolve even when
        // the structural shape is what reached this branch.
        const inlineType = p.type?.type === "array" ? p.type.elementType : p.type;
        if (
          inlineType?.type === "reflection" &&
          inlineType.declaration?.children?.length >= 2
        ) {
          const visited = new Set<string>([p.name]);
          const aliasAncestor =
            (p.type?.type === "reference" && typeof p.type.name === "string"
              ? p.type.name
              : null) ??
            (inlineType?.type === "reference" && typeof inlineType.name === "string"
              ? inlineType.name
              : null) ??
            syntacticParams.get(p.name) ??
            null;
          const ancestorHints = aliasAncestor ? [aliasAncestor] : [];
          result = resolveExpandedType(
            inlineType,
            p.name,
            visited,
            0,
            ancestorHints,
          );
        }
      }

      // Final fallback: when TypeDoc's `_target` is absent (common for
      // `z.discriminatedUnion` and other Zod-inferred unions that the plugin
      // flattens structurally), fall back to the syntactic name from the SDK
      // source. Look up the alias declaration directly via the TS program
      // and run `expandTsType` on it so we get proper variant subsections.
      if (!result && sourcePath) {
        const typeName = syntacticParams.get(p.name);
        if (typeName) {
          result = resolveExpandedViaTypeScript(sourcePath, typeName);
        }
      }

      if (result) {
        applyParamDocsToExpanded(result, p.name, paramDocs);
      }
      return result;
    })
    .filter(Boolean) as ExpandedType[];

  const parameters = ((sig as any).parameters || []).map((p: any) => ({
    name: p.name,
    type: syntacticParams.get(p.name) ?? formatType(p.type),
    required: !p.flags?.isOptional,
    defaultValue: cleanDefaultValue(p.defaultValue) ?? readJsDocDefault(p.comment),
    description: extractComment(p.comment?.summary) || "",
    typeStructure: buildStructuredType(p.type),
  }));

  const returnType = syntacticReturn ?? formatType((sig as any).type);

  // Signature: when the function declares overloads, emit one `function ...`
  // line per overload so the reader sees each declared shape. Each overload
  // uses its own syntactic param/return types (from the SDK source) so the
  // rendered line reads `function loadModel(options: LoadModelOptions, ...)`
  // rather than inlining the full LoadModelOptions structural shape.
  const overloadSigs = allSignatures && allSignatures.length > 1 ? allSignatures : [sig];
  const perOverloadParams = sourcePath
    ? readFunctionParamTypesAllOverloads(sourcePath, name)
    : null;
  const perOverloadReturns = sourcePath
    ? readFunctionReturnTypesAllOverloads(sourcePath, name)
    : null;
  const perOverloadThrows = sourcePath
    ? readFunctionThrowsTagsAllOverloads(sourcePath, name)
    : null;

  // Build a per-overload record up-front so we can pair signature text
  // with the per-signature TSDoc (description / examples / throws / label)
  // before deduping.
  type RawOverload = {
    signature: string;
    description: string;
    examples: string[];
    throws: Array<{ error: string; description: string }>;
    deprecated?: string;
    label?: string;
  };
  const rawOverloads: RawOverload[] = overloadSigs.map((s, idx) => {
    const syntacticForThisOverload = perOverloadParams?.[idx];
    const syntacticByName = new Map<string, string>();
    if (syntacticForThisOverload) {
      for (const p of syntacticForThisOverload) {
        if (p.isReference) syntacticByName.set(p.name, p.syntactic);
      }
    }
    const params = ((s as any).parameters || []).map((p: any) => ({
      name: p.name,
      type: syntacticByName.get(p.name) ?? formatType(p.type),
      required: !p.flags?.isOptional,
    }));
    const syntacticRet = perOverloadReturns?.[idx];
    const retType =
      syntacticRet && syntacticRet.isReference
        ? syntacticRet.syntactic
        : formatType((s as any).type);
    const sigText = buildSyntacticSignature(name, params, retType, s);

    // Per-overload TSDoc lives on the signature's own comment when each
    // overload has its own JSDoc block (this is the common pattern — see
    // packages/sdk/client/api/embed.ts and load-model.ts).
    const sigComment = (s as any).comment;
    const sigBlockTags = sigComment?.blockTags ?? [];
    const description = extractComment(sigComment?.summary) || "";
    const examples = sigBlockTags
      .filter((t: any) => t.tag === "@example")
      .map((t: any) => extractComment(t.content));
    // @throws — prefer the raw-source reader so the `{ErrorClass}` curly
    // brace token survives. TypeDoc strips it from `t.content` before we
    // see it, leaving the description as the only signal. Fall back to
    // the parsed-from-typedoc form when the source reader can't find the
    // overload (e.g. cross-file re-exports).
    const sourceThrows = perOverloadThrows?.[idx];
    const throws =
      sourceThrows && sourceThrows.length > 0
        ? sourceThrows
        : sigBlockTags
            .filter((t: any) => t.tag === "@throws")
            .map((t: any) => {
              const text = extractComment(t.content);
              const m = text.match(/^\{([^}]+)\}\s*(.*)/);
              if (m) return { error: m[1], description: m[2] };
              return { error: text, description: "" };
            })
            .filter((t: any) => t.error);
    // Author-provided short label, written as `@overloadLabel "Single text"`.
    // When missing, the heading falls back to plain `Overload N`.
    const labelTag = sigBlockTags.find((t: any) => t.tag === "@overloadLabel");
    const labelRaw = labelTag ? extractComment(labelTag.content).trim() : "";
    const label = labelRaw.replace(/^["']|["']$/g, "") || undefined;
    // @deprecated on a specific overload — surfaces a warning in just that
    // overload's section instead of the whole function.
    const depTag = sigBlockTags.find((t: any) => t.tag === "@deprecated");
    const deprecated = depTag
      ? extractComment(depTag.content) || "This overload is deprecated."
      : undefined;

    return { signature: sigText, description, examples, throws, deprecated, label };
  });

  // De-dupe identical overload signatures (TypeDoc sometimes emits the
  // implementation signature as an extra entry matching one of the
  // overloads; we only want each unique shape once). When duplicates carry
  // different TSDoc, the first one wins — TypeDoc puts the implementation
  // signature last and authors document the overloads, not the impl.
  const seenSignatures = new Set<string>();
  const uniqueOverloads: RawOverload[] = [];
  for (const ov of rawOverloads) {
    if (seenSignatures.has(ov.signature)) continue;
    seenSignatures.add(ov.signature);
    uniqueOverloads.push(ov);
  }
  const uniqueSignatures = uniqueOverloads.map((o) => o.signature);
  const signature = uniqueSignatures.join("\n");

  // Per-overload breakdown. Populated only when there's >1 unique
  // signature so the renderer can emit one `#### Overload N` block per
  // entry. Each entry carries its own description, throws, examples,
  // deprecated state, and optional `@overloadLabel`.
  const overloads: ApiOverload[] | undefined =
    uniqueOverloads.length > 1
      ? uniqueOverloads.map((ov) => {
          const entry: ApiOverload = { signature: ov.signature };
          if (ov.description) entry.description = ov.description;
          if (ov.throws.length > 0) entry.throws = ov.throws;
          if (ov.examples.length > 0) entry.examples = ov.examples;
          if (ov.deprecated) entry.deprecated = ov.deprecated;
          if (ov.label) entry.label = ov.label;
          return entry;
        })
      : undefined;

  return {
    name,
    signature,
    overloads,
    description: extractComment(summary) || "No description available",
    parameters,
    expandedParams,
    returns: {
      type: returnType,
      description: extractComment((comment as any)?.returns ?? (sig as any).comment?.returns) || "",
      typeStructure: buildStructuredType((sig as any).type),
    },
    returnFields: (() => {
      const retType = (sig as any).type;
      const props = extractTypeProperties(retType, new Set());
      if (!props) return [];
      // Hint with the return type's leading alias name so `.describe()`
      // strings only resolve when the schema is an exact match. Strip the
      // Promise wrapper so `Promise<ModelInfo>` resolves as `ModelInfo`.
      // Without this hint, the lookup falls back to "no description" rather
      // than leaking a same-named field's describe() from another schema.
      const unwrappedRet = unwrapReturnWrapper(retType) ?? retType;
      const returnAlias =
        getResolvableTypeName(unwrappedRet) ??
        (unwrappedRet?.type === "array"
          ? getResolvableTypeName(unwrappedRet.elementType)
          : null);
      return props.map((p: any) => {
        const tsDoc = extractComment(p.comment?.summary);
        return {
          name: p.name,
          type: formatType(p.type),
          required: !p.flags?.isOptional,
          description:
            tsDoc || lookupZodDescription(p.name, returnAlias ?? undefined),
        };
      });
    })(),
    expandedReturns: (() => {
      const retType = (sig as any).type;
      const results: ExpandedType[] = [];
      const props = extractTypeProperties(retType, new Set());
      if (props) {
        for (const prop of props) {
          // Unwrap wrapper types like `Promise<T>` so the heading labels the
          // meaningful payload (`CompletionStats`) rather than the wrapper
          // (`Promise`). Without this the return subsection renders as
          // `### Promise` and its nested field lookup can't find the
          // schema-scoped `.describe()` strings.
          const unwrapped = unwrapReturnWrapper(prop.type);
          const candidateType = unwrapped ?? prop.type;

          // Named alias reference: expand using the alias name as heading.
          const childName =
            getResolvableTypeName(candidateType) ??
            (candidateType?.type === "array"
              ? getResolvableTypeName(candidateType.elementType)
              : null);
          if (childName) {
            const visited = new Set<string>([childName]);
            const target =
              candidateType?.type === "array"
                ? candidateType.elementType
                : candidateType;
            const expanded = resolveExpandedType(target, childName, visited, 0);
            if (expanded) results.push(expanded);
            continue;
          }

          // Inline anonymous object field (e.g. `stats?: { totalTime?: number;
          // ...}` in embed's return). No alias exists, so use the field name
          // as the subsection heading and surface the inner fields. Pass any
          // originating alias name (e.g. `EmbedStats`) that TypeDoc flattened
          // as an ancestor hint so schema-scoped `.describe()` strings still
          // resolve for the nested fields.
          const inline =
            candidateType?.type === "array"
              ? candidateType.elementType
              : candidateType;
          if (inline?.type === "reflection" && inline.declaration?.children?.length >= 2) {
            const aliasAncestor =
              (prop.type?.type === "reference" &&
              typeof prop.type.name === "string"
                ? prop.type.name
                : null) ??
              (candidateType?.type === "reference" &&
              typeof candidateType.name === "string"
                ? candidateType.name
                : null) ??
              (inline?.type === "reference" &&
              typeof inline.name === "string"
                ? inline.name
                : null);
            const ancestorHints = aliasAncestor ? [aliasAncestor] : [];
            const expanded = resolveExpandedType(
              inline,
              prop.name,
              new Set([prop.name]),
              0,
              ancestorHints,
            );
            if (expanded) results.push(expanded);
          }
        }
      }
      return results;
    })(),
    throws: (() => {
      // TypeDoc strips `{ErrorType}` from @throws block tags. Parse the raw
      // source JSDoc so the Error column carries the explicit error code.
      const sourcePath =
        (decl?.sources?.[0]?.fullFileName ??
          (decl as any)?.sources?.[0]?.file?.fullFileName ??
          "") as string;
      if (sourcePath) {
        const raw = readFunctionThrowsTags(sourcePath, name);
        if (raw.length > 0) return raw;
      }
      // Fallback to whatever TypeDoc preserved when we can't read the source.
      return blockTags
        .filter((tag: any) => tag.tag === "@throws")
        .map((tag: any) => {
          const text = extractComment(tag.content);
          const match = text.match(/^\{([^}]+)\}\s*(.*)/);
          if (match) return { error: match[1], description: match[2] };
          return { error: text, description: "" };
        })
        .filter((t: any) => t.error);
    })(),
    examples: blockTags
      .filter((tag: any) => tag.tag === "@example")
      .map((tag: any) => extractComment(tag.content)) || [],
    deprecated: (() => {
      const depTag = blockTags.find((tag: any) => tag.tag === "@deprecated");
      if (depTag) return extractComment(depTag.content) || "This function is deprecated.";
      if (comment?.isDeprecated) return "This function is deprecated.";
      return undefined;
    })(),
  };
}

/**
 * Scope filter: only public functions re-exported from
 * `packages/sdk/client/api/index.ts` make it into the API summary.
 *
 * The single-page summary deliberately excludes auxiliary helpers
 * (`close`, `getLogger`, `getModelByName/Path/Src`, `definePlugin`,
 * `defineHandler`, `defineDuplexHandler`) — those live in `.d.ts` for
 * IDE/agent consumption.
 */
function isInClientApiScope(sourcePath: string): boolean {
  if (!sourcePath) return false;
  const normalized = sourcePath.replace(/\\/g, "/");
  if (!normalized.includes("/client/api/")) return false;
  if (normalized.endsWith("/client/api/index.ts")) return false;
  if (normalized.includes("/server/") || normalized.includes("/examples/")) return false;
  return true;
}

function extractApiFunctions(project: any): ApiFunction[] {
  const functions: ApiFunction[] = [];
  const allFunctions = project.getReflectionsByKind(ReflectionKind.Function) as DeclarationReflection[];
  for (const refl of allFunctions) {
    const decl = refl as DeclarationReflection;
    // Build a list of all callable signatures. TypeDoc puts overloads in
    // `decl.signatures`. The implementation signature (for functions that
    // have overloads) is synthesized by TypeDoc and appears as the last
    // entry — we show every declared overload in the signature block so the
    // reader sees all the declared shapes.
    const allSignatures = (
      decl.signatures?.length
        ? decl.signatures
        : decl.children?.filter((c: any) => c.kind === ReflectionKind.CallSignature) ?? []
    ) as SignatureReflection[];
    if (allSignatures.length === 0) continue;
    const sourcePath = (decl.sources?.[0]?.fullFileName ?? (decl as any).sources?.[0]?.file?.fullFileName ?? "") as string;
    if (!isInClientApiScope(sourcePath)) continue;
    functions.push(buildApiFunction(decl.name, decl, allSignatures[0], undefined, allSignatures));
  }
  return functions.sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );
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

    const methodProps = props.filter(
      (p: any) => p.type?.type === "reflection" && p.type.declaration?.signatures?.length > 0,
    );
    if (methodProps.length === 0) continue;

    const sourcePath = (decl.sources?.[0]?.fullFileName ?? (decl as any).sources?.[0]?.file?.fullFileName ?? "") as string;
    const normalizedPath = sourcePath.replace(/\\/g, "/");
    if (normalizedPath && (normalizedPath.includes("/server/") || normalizedPath.includes("/examples/"))) continue;
    // Object summary scope: only public, curated singletons. Today this is
    // just `profiler` from `packages/sdk/profiling/`. Adding more curated
    // objects here is a deliberate editorial decision — they show up on
    // the single-page summary, so the bar should be intentional.
    if (!normalizedPath.includes("/profiling/")) continue;

    const comment = decl.comment;
    const summary = comment?.summary;
    const blockTags = comment?.blockTags ?? [];

    const fields = props.map((p: any) => ({
      name: p.name,
      type: formatType(p.type),
      required: !p.flags?.isOptional,
      defaultValue: cleanDefaultValue(p.defaultValue) ?? readJsDocDefault(p.comment),
      description: extractComment(p.comment?.summary),
    }));

    // Per-method ApiFunction records: one for each callable property.
    const methods: ApiFunction[] = methodProps.map((p: any) => {
      const sig = p.type.declaration.signatures[0];
      return buildApiFunction(p.name, null, sig, p.comment);
    });

    // Build a pre-formatted object signature block, e.g.
    // `const profiler: { enable(options?: ...): void; ...; };`
    const objectSignature = buildObjectSignature(decl.name, methodProps, props);

    objects.push({
      name: decl.name,
      description: (() => {
        const moduleDoc = extractComment(summary) ? null : readModuleJsDoc(sourcePath);
        return extractComment(summary) || moduleDoc?.description || "No description available";
      })(),
      objectSignature,
      fields,
      children: [],
      methods,
      examples: (() => {
        const extracted = blockTags
          .filter((tag: any) => tag.tag === "@example")
          .map((tag: any) => extractComment(tag.content));
        if (extracted.length > 0) return extracted;
        return readModuleJsDoc(sourcePath)?.examples ?? [];
      })(),
    });
  }

  return objects.sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );
}

// ---------------------------------------------------------------------------
// Object signature builder (used by extractApiObjects above)
// ---------------------------------------------------------------------------

/**
 * Produce a pre-formatted TypeScript declaration summarizing an object's
 * shape, matching the style of hand-written samples:
 *
 *   const name: {
 *     method1(args): ret;
 *     method2(): ret;
 *     field: Type;
 *   };
 */
function buildObjectSignature(
  name: string,
  methodProps: any[],
  allProps: any[],
): string {
  const lines: string[] = [];
  for (const p of allProps) {
    const isMethod = methodProps.includes(p);
    if (isMethod) {
      const sig = p.type.declaration.signatures[0];
      const params = (sig.parameters || [])
        .map((arg: any) => `${arg.name}${arg.flags?.isOptional ? "?" : ""}: ${formatType(arg.type)}`)
        .join(", ");
      lines.push(`  ${p.name}(${params}): ${formatType(sig.type)};`);
    } else {
      lines.push(`  ${p.name}${p.flags?.isOptional ? "?" : ""}: ${formatType(p.type)};`);
    }
  }
  return `const ${name}: {\n${lines.join("\n")}\n};`;
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
// Sample prose fallback (read once per run, indexed by function/object name)
// ---------------------------------------------------------------------------

const sampleProseCache = new Map<string, SampleFunctionProse>();
const indexSummariesCache: { functions: Map<string, string>; objects: Map<string, string> } = {
  functions: new Map(),
  objects: new Map(),
};

/**
 * Zod description map built once per run from `packages/sdk/schemas/*.ts`.
 * Consulted whenever an expanded-type field has no TypeScript-level JSDoc
 * description to fill in from. Zod `.describe()` metadata is runtime-only so
 * it never shows up in TypeDoc reflections or TS compiler symbol comments;
 * we AST-scan the schema files directly to recover the strings.
 */
let zodDescriptions: ZodDescriptionMap = {
  bySchema: new Map(),
  byNameUnique: new Map(),
  conflicts: new Map(),
};

async function loadZodDescriptions(schemasDir: string): Promise<void> {
  try {
    zodDescriptions = await extractZodDescriptions(schemasDir);
    const uniqueCount = zodDescriptions.byNameUnique.size;
    const schemaCount = zodDescriptions.bySchema.size;
    const conflictCount = zodDescriptions.conflicts.size;
    console.log(
      `\u2713 Extracted Zod .describe() strings: ${uniqueCount} unique names ` +
        `across ${schemaCount} schemas` +
        (conflictCount > 0 ? ` (${conflictCount} ambiguous, skipped)` : ""),
    );
  } catch {
    // Schemas dir missing: leave map empty.
  }
}

/**
 * Resolve a property's description via the Zod .describe() map. Returns an
 * empty string when the property name isn't found or has conflicting
 * descriptions across multiple schemas.
 *
 * Caller should only use the result when the normal (TS comment / sample
 * prose / JSDoc) extraction path produced an empty description.
 */
/**
 * Lookup the `.describe()` string for a schema property.
 *
 * Resolution order:
 *   1. For each entry in `schemaHint` (in order), try
 *      `bySchema[hint][propertyName]`. The schema map is keyed by both the
 *      Zod schema variable name (e.g. `completionParamsSchema`) and every
 *      TypeScript type alias derived from it via `z.infer<typeof X>`
 *      (e.g. `CompletionParams`). Pass multiple hints when the caller can
 *      provide an ancestor chain — for example, when we're rendering the
 *      nested `history.role` subsection, the ancestors `["HistoryMessage",
 *      "CompletionParams"]` let us resolve a describe attached to the outer
 *      schema.
 *   2. `byNameUnique[propertyName]` — the global "field-name has exactly
 *      one unambiguous description across the SDK" fallback. **Disabled by
 *      default** because field names like `text`, `modelId`, `stats`, and
 *      `params` collide across schemas: e.g., `embed`'s `text` describe
 *      string has historically leaked onto `completion`'s return `text`
 *      field. Opt in with `allowGlobalFallback=true` only where leakage is
 *      acceptable.
 */
function lookupZodDescription(
  propertyName: string,
  schemaHint?: string | string[],
  allowGlobalFallback = false,
): string {
  if (!propertyName) return "";
  const hints: string[] = [];
  if (typeof schemaHint === "string") hints.push(schemaHint);
  else if (Array.isArray(schemaHint)) hints.push(...schemaHint.filter(Boolean));
  for (const h of hints) {
    const schemaMap = zodDescriptions.bySchema.get(h);
    const direct = schemaMap?.get(propertyName);
    if (direct) return direct;
  }
  if (allowGlobalFallback) {
    return zodDescriptions.byNameUnique.get(propertyName) ?? "";
  }
  return "";
}

/**
 * Load prose from hand-authored MDX samples into `sampleProseCache`. The
 * cache is keyed by function/object name (same as the output file name).
 * Silent no-op when `samplesDir` is undefined or missing.
 */
async function loadSampleProse(samplesDir: string | undefined): Promise<void> {
  sampleProseCache.clear();
  indexSummariesCache.functions.clear();
  indexSummariesCache.objects.clear();
  if (!samplesDir) return;
  try {
    const entries = await fs.readdir(samplesDir);
    for (const entry of entries) {
      if (!entry.endsWith(".mdx")) continue;
      const name = entry.replace(/\.mdx$/, "");
      const prose = await readSampleProse(samplesDir, name);
      if (prose) sampleProseCache.set(name, prose);
    }
    const summaries = await readIndexSummaries(samplesDir);
    indexSummariesCache.functions = summaries.functions;
    indexSummariesCache.objects = summaries.objects;
    console.log(
      `\u2713 Loaded prose from ${sampleProseCache.size} sample file(s), ` +
        `${summaries.functions.size} index summaries`,
    );
  } catch {
    // Samples dir missing/unreadable: fall back to SDK JSDoc only.
  }
}

/**
 * Apply sample prose as a fallback on top of the pipeline's TypeScript
 * extraction. Only empty fields in the extracted ApiFunction are filled from
 * the sample; existing JSDoc prose wins. The sample is matched by function
 * name (`fn.name`).
 */
function applySampleProseToFunction(fn: ApiFunction): void {
  // Index summary (curated separately from function-page description).
  const indexSummary = indexSummariesCache.functions.get(fn.name);
  if (indexSummary && !fn.summary) fn.summary = indexSummary;

  const prose = sampleProseCache.get(fn.name);
  if (!prose) return;
  mergeSampleProseIntoFunction(fn, prose);
}

/**
 * Merge a structured `SampleFunctionProse` into an `ApiFunction`. SDK JSDoc
 * (already on `fn`) always wins; sample prose fills blanks.
 *
 * Extracted from `applySampleProseToFunction` so that object method prose
 * (which comes from `prose.methods.get(name)` rather than the top-level
 * `sampleProseCache`) can reuse the same merge rules.
 */
function mergeSampleProseIntoFunction(
  fn: ApiFunction,
  prose: SampleFunctionProse,
): void {
  if (!fn.description || fn.description === "No description available") {
    if (prose.description) fn.description = prose.description;
  }

  if (!fn.leadParagraph && prose.leadParagraph) {
    fn.leadParagraph = prose.leadParagraph;
  }

  if (fn.returns && (!fn.returns.description || fn.returns.description.trim() === "")) {
    if (prose.returnsDescription) fn.returns.description = prose.returnsDescription;
  }

  for (const p of fn.parameters) {
    if (p.description && p.description.trim() !== "") continue;
    const fromSample = prose.parameters.get(p.name);
    if (fromSample) p.description = fromSample;
  }

  const expandedByName = new Map<string, Map<string, string>>();
  for (const exp of prose.expanded) expandedByName.set(exp.typeName, exp.fields);
  const applyToTree = (node: ExpandedType) => {
    const matches =
      expandedByName.get(node.typeName) ??
      expandedByName.get(node.typeName.toLowerCase());
    if (matches) {
      for (const f of node.fields) {
        if (f.description && f.description.trim() !== "") continue;
        const fromSample = matches.get(f.name);
        if (fromSample) f.description = fromSample;
      }
    }
    for (const child of node.children) applyToTree(child);
  };
  for (const exp of fn.expandedParams) applyToTree(exp);
  for (const exp of fn.expandedReturns) applyToTree(exp);

  for (const f of fn.returnFields) {
    if (f.description && f.description.trim() !== "") continue;
    const fromSample = prose.returnFields.get(f.name);
    if (fromSample) f.description = fromSample;
  }

  if (!fn.examples || fn.examples.length === 0) {
    if (prose.examples.length > 0) fn.examples = prose.examples.slice();
  }

  // Merge throws from samples using a fill-empty-only policy (consistent
  // with the rest of this function: "SDK JSDoc always wins"). Previously we
  // replaced `fn.throws` wholesale when the sample had any row, which could
  // silently discard errors the JSDoc declared but the sample didn't.
  if (prose.throws.length > 0) {
    const existing = new Map<string, { error: string; description: string }>();
    for (const t of fn.throws ?? []) existing.set(t.error, t);
    for (const s of prose.throws) {
      const current = existing.get(s.error);
      if (!current) {
        existing.set(s.error, { error: s.error, description: s.description });
      } else if (!current.description || current.description.trim() === "") {
        current.description = s.description;
      }
    }
    fn.throws = [...existing.values()];
  }
}

/**
 * Same as applySampleProseToFunction but for ApiObject. Applies top-level
 * description + methods (each method is an ApiFunction).
 */
function applySampleProseToObject(obj: ApiObject): void {
  const indexSummary = indexSummariesCache.objects.get(obj.name);
  if (indexSummary && !obj.summary) obj.summary = indexSummary;

  const prose = sampleProseCache.get(obj.name);
  if (!prose) return;

  if (!obj.description || obj.description === "No description available") {
    if (prose.description) obj.description = prose.description;
  }

  if (!obj.leadParagraph && prose.leadParagraph) {
    obj.leadParagraph = prose.leadParagraph;
  }

  for (const f of obj.fields) {
    if (f.description && f.description.trim() !== "") continue;
    const fromSample = prose.parameters.get(f.name) ?? prose.returnFields.get(f.name);
    if (fromSample) f.description = fromSample;
  }

  const expandedByName = new Map<string, Map<string, string>>();
  for (const exp of prose.expanded) expandedByName.set(exp.typeName, exp.fields);
  const applyToTree = (node: ExpandedType) => {
    const matches = expandedByName.get(node.typeName);
    if (matches) {
      for (const f of node.fields) {
        if (f.description && f.description.trim() !== "") continue;
        const fromSample = matches.get(f.name);
        if (fromSample) f.description = fromSample;
      }
    }
    for (const child of node.children) applyToTree(child);
  };
  for (const child of obj.children) applyToTree(child);

  if (obj.methods) {
    for (const m of obj.methods) {
      const summary = prose.methodSummaries.get(m.name);
      if (summary && !m.summary) m.summary = summary;

      const methodProse = prose.methods.get(m.name);
      if (methodProse) mergeSampleProseIntoFunction(m, methodProse);
    }

    // Reorder methods to match the sample's curated semantic order when the
    // sample provides one. TypeDoc's default order is alphabetical, but the
    // hand-written samples group methods by lifecycle / purpose. Methods not
    // listed in the sample are appended in their original (alphabetical) order.
    const sampleOrder = Array.from(prose.methodSummaries.keys());
    if (sampleOrder.length > 0) {
      const indexOf = new Map<string, number>();
      sampleOrder.forEach((name, idx) => indexOf.set(name, idx));
      obj.methods.sort((a, b) => {
        const aIn = indexOf.has(a.name);
        const bIn = indexOf.has(b.name);
        if (aIn && bIn) return indexOf.get(a.name)! - indexOf.get(b.name)!;
        if (aIn) return -1;
        if (bIn) return 1;
        // Both unlisted: tail-sort alphabetically with a fixed locale so the
        // ordering doesn't drift across machines with different default
        // locale settings.
        return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
      });
    }
  }

  if (!obj.examples || obj.examples.length === 0) {
    if (prose.examples.length > 0) obj.examples = prose.examples.slice();
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

/**
 * Read raw `@throws` block tags from the JSDoc immediately above a function
 * declaration. TypeDoc strips the `{ErrorType}` annotation from block tag
 * content, so we parse the raw source to recover the error name pairs.
 *
 * Returns entries like `{ error: "QvacErrorBase", description: "When ..." }`.
 * Falls back to a single-field entry (error only, empty description) when the
 * JSDoc tag has no `{...}` type annotation.
 */
function parseThrowsFromJsDoc(
  raw: string,
): Array<{ error: string; description: string }> {
  const inner = raw
    .replace(/^\/\*\*\s*/, "")
    .replace(/\s*\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n");

  const throwsRe = /@throws\s+(?:\{([^}]+)\}\s*)?([\s\S]*?)(?=\n@\w|$)/g;
  const entries: Array<{ error: string; description: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = throwsRe.exec(inner)) !== null) {
    const error = (m[1] ?? "").trim();
    const description = (m[2] ?? "").trim();
    if (!error && !description) continue;
    entries.push({
      error: error || description,
      description: error ? description : "",
    });
  }
  return entries;
}

function readFunctionThrowsTags(
  fileName: string,
  functionName: string,
): Array<{ error: string; description: string }> {
  const all = readFunctionThrowsTagsAllOverloads(fileName, functionName);
  if (all.length === 0) return [];
  // Concatenate every overload's @throws tags into a single function-level
  // list (back-compat: this is the function-level fallback used by the
  // top-level `fn.throws` field).
  const seen = new Set<string>();
  const merged: Array<{ error: string; description: string }> = [];
  for (const list of all) {
    for (const entry of list) {
      const key = `${entry.error}|${entry.description}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

/**
 * Return one `@throws` array per declared overload of `functionName`,
 * preserving order. Each entry is the throws list for one signature
 * (including the implementation signature, which is typically dropped
 * downstream because its signature text matches one of the overloads).
 *
 * Reads the raw source so the `{ErrorClass}` curly-brace token survives —
 * TypeDoc's parsed comment objects strip it.
 */
function readFunctionThrowsTagsAllOverloads(
  fileName: string,
  functionName: string,
): Array<Array<{ error: string; description: string }>> {
  if (!tsProgram) return [];
  const normalizedPath = fileName.replace(/\\/g, "/");
  const sourceFile = tsProgram.getSourceFile(normalizedPath);
  if (!sourceFile) return [];

  const fullText = sourceFile.getFullText();
  const positions: number[] = [];
  sourceFile.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      positions.push(node.pos);
    }
  });
  if (positions.length === 0) return [];

  return positions.map((pos) => {
    const commentRanges = ts.getLeadingCommentRanges(fullText, pos) ?? [];
    const jsdoc = commentRanges
      .reverse()
      .find(
        (r) =>
          r.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
          fullText.slice(r.pos, r.pos + 3) === "/**",
      );
    if (!jsdoc) return [];
    const raw = fullText.slice(jsdoc.pos, jsdoc.end);
    return parseThrowsFromJsDoc(raw);
  });
}

/**
 * Read the parameter TypeNodes a function was declared with (syntactically) so
 * the signature can be printed using the author's own type names — e.g. the
 * function `cancel(params: CancelParams): Promise<void>` is rendered using
 * `CancelParams` instead of the structurally-inlined discriminated union
 * TypeDoc's plugin produced. Returns `null` when the declaration isn't found
 * or doesn't use a simple TypeReference (e.g., anonymous inline types are
 * left alone so the structural form wins).
 *
 * Each returned entry has `{ name, syntactic, isReference }`:
 *  - `name` is the parameter identifier (e.g. "params")
 *  - `syntactic` is the verbatim type-node text as written in source
 *  - `isReference` is true when the type is a plain identifier reference
 *    (TypeReferenceNode with just a name). Callers should only substitute
 *    when `isReference` is true to avoid losing inline-type detail.
 */
function readFunctionParamTypes(
  fileName: string,
  functionName: string,
): Array<{ name: string; syntactic: string; isReference: boolean }> | null {
  const all = readFunctionParamTypesAllOverloads(fileName, functionName);
  if (!all || all.length === 0) return null;
  return all[0];
}

/**
 * Return per-overload syntactic param types. TypeScript overload declarations
 * look like:
 *
 *   export function loadModel(options: LoadModelOptions, rpcOptions?: RPCOptions): Promise<string>;
 *   export function loadModel(options: ReloadConfigOptions, rpcOptions?: RPCOptions): Promise<string>;
 *   export function loadModel(options: any, rpcOptions?: any): Promise<string> { ... }
 *
 * This helper returns one entry per declaration (overload signatures + the
 * implementation). Callers that want only overload signatures (skipping the
 * implementation body) can filter by whether the declaration has a body.
 */
function readFunctionParamTypesAllOverloads(
  fileName: string,
  functionName: string,
): Array<Array<{ name: string; syntactic: string; isReference: boolean }>> | null {
  if (!tsProgram) return null;
  const normalizedPath = fileName.replace(/\\/g, "/");
  const sourceFile = tsProgram.getSourceFile(normalizedPath);
  if (!sourceFile) return null;

  const targets: Array<ts.FunctionDeclaration | ts.VariableDeclaration> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      // Prefer overload declarations (no body) over the implementation — the
      // implementation params are typically widened `any | any | ...`.
      targets.push(node);
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === functionName &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          targets.push(decl);
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  if (targets.length === 0) return null;

  // Filter out the implementation signature when there ARE overload
  // signatures: TypeScript requires the implementation to come last and its
  // params are usually widened unions. Keep the implementation when it's
  // the only declaration.
  let candidates: typeof targets = targets;
  const overloadsOnly = targets.filter(
    (t) => ts.isFunctionDeclaration(t) && !t.body,
  );
  if (overloadsOnly.length > 0) {
    candidates = overloadsOnly;
  }

  const results: Array<Array<{ name: string; syntactic: string; isReference: boolean }>> = [];
  for (const target of candidates) {
    let params: readonly ts.ParameterDeclaration[] | undefined;
    if (ts.isFunctionDeclaration(target)) {
      params = target.parameters;
    } else {
      const init = (target as ts.VariableDeclaration).initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        params = init.parameters;
      }
    }
    if (!params) continue;

    const entry: Array<{ name: string; syntactic: string; isReference: boolean }> = [];
    for (const p of params) {
      if (!ts.isIdentifier(p.name)) continue;
      if (!p.type) continue;
      const syntactic = p.type.getText(sourceFile).trim();
      const isReference = ts.isTypeReferenceNode(p.type) && ts.isIdentifier(p.type.typeName);
      entry.push({ name: p.name.text, syntactic, isReference });
    }
    results.push(entry);
  }
  return results;
}

/**
 * Same shape for return types, one entry per declared overload.
 */
function readFunctionReturnTypesAllOverloads(
  fileName: string,
  functionName: string,
): Array<{ syntactic: string; isReference: boolean } | null> | null {
  if (!tsProgram) return null;
  const normalizedPath = fileName.replace(/\\/g, "/");
  const sourceFile = tsProgram.getSourceFile(normalizedPath);
  if (!sourceFile) return null;

  const targets: Array<ts.FunctionDeclaration | ts.VariableDeclaration> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      targets.push(node);
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === functionName &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          targets.push(decl);
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  if (targets.length === 0) return null;

  let candidates: typeof targets = targets;
  const overloadsOnly = targets.filter(
    (t) => ts.isFunctionDeclaration(t) && !t.body,
  );
  if (overloadsOnly.length > 0) candidates = overloadsOnly;

  return candidates.map((target) => {
    let returnNode: ts.TypeNode | undefined;
    if (ts.isFunctionDeclaration(target)) {
      returnNode = target.type;
    } else {
      const init = (target as ts.VariableDeclaration).initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        returnNode = init.type;
      }
    }
    if (!returnNode) return null;
    const syntactic = returnNode.getText(sourceFile).trim();
    const isReference = ts.isTypeReferenceNode(returnNode) && ts.isIdentifier(returnNode.typeName);
    return { syntactic, isReference };
  });
}

/**
 * Read the syntactic return type of a function declaration. Mirrors
 * readFunctionParamTypes but for the return annotation. Returns null when the
 * function has no explicit return type or the declaration isn't found.
 */
function readFunctionReturnType(
  fileName: string,
  functionName: string,
): { syntactic: string; isReference: boolean } | null {
  if (!tsProgram) return null;
  const normalizedPath = fileName.replace(/\\/g, "/");
  const sourceFile = tsProgram.getSourceFile(normalizedPath);
  if (!sourceFile) return null;

  let returnNode: ts.TypeNode | undefined;
  const visit = (node: ts.Node): void => {
    if (returnNode) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      returnNode = node.type;
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === functionName &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          returnNode = decl.initializer.type;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  if (!returnNode) return null;

  const syntactic = returnNode.getText(sourceFile).trim();
  const isReference = ts.isTypeReferenceNode(returnNode) && ts.isIdentifier(returnNode.typeName);
  return { syntactic, isReference };
}

function findTsTypeAlias(
  fileName: string,
  qualifiedName: string,
  pos?: number,
): ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined {
  if (!tsProgram) return undefined;

  // First try the specified file. When the caller's fileName is a function
  // source (e.g., `client/api/cancel.ts`) but the alias is declared in its
  // schema (`schemas/cancel.ts`), the direct lookup fails — fall back to a
  // whole-program scan below.
  const normalizedPath = fileName.replace(/\\/g, "/");
  const primary = tsProgram.getSourceFile(normalizedPath);
  const scan = (sourceFile: ts.SourceFile): ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined => {
    let found: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined;
    ts.forEachChild(sourceFile, (node) => {
      if (found) return;
      if (
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        node.name.text === qualifiedName
      ) {
        if (pos == null || Math.abs(node.pos - pos) < 50) {
          found = node;
        }
      }
    });
    return found;
  };

  if (primary) {
    const hit = scan(primary);
    if (hit) return hit;
  }

  // Whole-program fallback: scan every source file ignoring `pos`. Needed
  // for aliases that live in a sibling schemas file imported only as a
  // type, which TypeDoc's `_target.fileName` sometimes doesn't capture.
  for (const sf of tsProgram.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    let found: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined;
    ts.forEachChild(sf, (node) => {
      if (found) return;
      if (
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        node.name.text === qualifiedName
      ) {
        found = node;
      }
    });
    if (found) return found;
  }
  return undefined;
}

/**
 * Unwrap arrays and nullable unions to get the "meaningful" underlying type
 * for a property. Returns null when the type has no useful object shape to
 * drill into.
 */
/**
 * Detect a discriminated union of object types (e.g., from Zod's
 * `z.discriminatedUnion("op", [...])`) and return an array of its variants,
 * each labeled by the discriminator's literal value. Returns null when the
 * type isn't a union, is a union of primitives, or lacks a shared literal
 * discriminator.
 */
function splitDiscriminatedUnion(
  type: ts.Type,
  location: ts.Node,
): Array<{ label: string; type: ts.Type }> | null {
  if (!tsChecker) return null;
  if (!type.isUnion?.()) return null;

  const candidates = (type as ts.UnionType).types.filter((t) => {
    if (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) return false;
    if (!(t.flags & ts.TypeFlags.Object)) return false;
    return t.getProperties().length >= 1;
  });
  if (candidates.length < 2) return null;

  // Find the discriminator: a property that appears in every variant and
  // whose type is a string literal distinct per variant.
  const firstProps = candidates[0].getProperties().map((p) => p.name);
  let discriminator: string | null = null;
  for (const propName of firstProps) {
    const literalPerVariant: string[] = [];
    let ok = true;
    for (const variant of candidates) {
      const prop = variant.getProperty(propName);
      if (!prop) {
        ok = false;
        break;
      }
      const propType = tsChecker.getTypeOfSymbolAtLocation(prop, location);
      if (!propType.isStringLiteral?.()) {
        ok = false;
        break;
      }
      literalPerVariant.push((propType as ts.StringLiteralType).value);
    }
    if (ok && new Set(literalPerVariant).size === literalPerVariant.length) {
      discriminator = propName;
      break;
    }
  }

  if (!discriminator) return null;

  return candidates.map((variant) => {
    const discProp = variant.getProperty(discriminator!);
    const literalType = discProp
      ? tsChecker!.getTypeOfSymbolAtLocation(discProp, location)
      : null;
    const literal = literalType?.isStringLiteral?.()
      ? (literalType as ts.StringLiteralType).value
      : "";
    return { label: literal, type: variant };
  });
}

/**
 * Unwrap container-like named types (`Promise<T>`, `Readonly<T>`, `Awaited<T>`,
 * `Partial<T>`, `Required<T>`) so callers see the inner payload whose
 * properties matter for field tables. Returns null when no unwrap is needed.
 *
 * Separate from `unwrapContainerType` which handles `T[]` + nullable unions;
 * this one handles the named generic wrappers that `typeToString` prints as
 * `Promise<...>` etc. and whose payload is the "thing you actually have".
 */
function unwrapWrapperType(type: ts.Type): ts.Type | null {
  if (!tsChecker) return null;
  const wrapperNames = new Set([
    "Promise",
    "Readonly",
    "Awaited",
    "Partial",
    "Required",
  ]);
  const symbol = (type.aliasSymbol ?? type.symbol) as ts.Symbol | undefined;
  const name = symbol?.name;
  if (!name || !wrapperNames.has(name)) return null;
  const args =
    (type.aliasTypeArguments as readonly ts.Type[] | undefined) ??
    tsChecker.getTypeArguments(type as ts.TypeReference);
  if (!args || args.length === 0) return null;
  return args[0];
}

function unwrapContainerType(propType: ts.Type): ts.Type | null {
  if (!tsChecker) return null;
  let candidate: ts.Type = propType;

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

  if (candidate.isUnion?.()) {
    const meaningful = (candidate as ts.UnionType).types.filter(
      (t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
    );
    if (meaningful.length === 1) candidate = meaningful[0];
  }

  return candidate;
}

/**
 * Given a ts.Type for a property, try to resolve a named type to expand as a
 * child section. Returns the name and the underlying object type, or null.
 */
function resolveNamedChildType(
  propType: ts.Type,
): { name: string; objectType: ts.Type } | null {
  const candidate = unwrapContainerType(propType);
  if (!candidate) return null;

  const aliasName = candidate.aliasSymbol?.name;
  const symbolName = candidate.symbol?.name;
  const name = aliasName ?? symbolName;

  // Only expand named object types with their own property list. Skip
  // anonymous inline objects, intrinsics, utility types like Record<>, etc.
  if (!name || name === "__type" || name === "__object") return null;
  if (BUILTIN_TYPES.has(name)) return null;
  if (!isSdkOwnedType(candidate)) return null;

  const hasOwnProps = candidate.getProperties().length > 0;
  if (!hasOwnProps) return null;

  return { name, objectType: candidate };
}

/**
 * Return true when a type's declaration lives inside the SDK source tree
 * (i.e., we own it and can reasonably expand it). Returns false for generic
 * type parameters with no declared constraint, types from `node_modules/`,
 * and lib.d.ts types. Prevents runaway expansion into Zod's internal
 * `ZodType`/`$ZodTypeInternals` machinery when a function uses `TRequest`
 * or `TResponse` generic parameters.
 */
function isSdkOwnedType(type: ts.Type): boolean {
  const symbol = type.aliasSymbol ?? type.symbol;
  if (!symbol) return true;
  const decls = symbol.declarations ?? [];
  if (decls.length === 0) return true;
  // Type parameter declarations (e.g. `<TRequest extends ZodType>`): skip.
  for (const d of decls) {
    if (ts.isTypeParameterDeclaration(d)) return false;
  }
  for (const d of decls) {
    const file = d.getSourceFile().fileName.replace(/\\/g, "/");
    // Declarations inside node_modules or lib.d.ts files aren't ours to
    // document; they belong to the dependency authors.
    if (file.includes("/node_modules/")) return false;
    if (file.endsWith(".d.ts") && !file.includes("/packages/sdk/")) return false;
  }
  return true;
}

/**
 * Detect an anonymous inline object type (e.g., `{ a: string; b: number }`)
 * with 2+ own properties. Used to build unnamed child sections labeled by the
 * property name when no named alias exists (common for Zod-inferred types).
 * Returns null when the type is named, primitive, function, or too shallow.
 */
function resolveInlineObjectType(propType: ts.Type): ts.Type | null {
  if (!tsChecker) return null;
  const candidate = unwrapContainerType(propType);
  if (!candidate) return null;

  // Skip named types — those are handled by resolveNamedChildType.
  const aliasName = candidate.aliasSymbol?.name;
  const symbolName = candidate.symbol?.name;
  const name = aliasName ?? symbolName;
  if (name && name !== "__type" && name !== "__object") return null;
  if (name && BUILTIN_TYPES.has(name)) return null;
  // Guard against generic type parameters leaking in via constraints (e.g.,
  // `<T extends ZodType>` → expand ZodType internals). For purely anonymous
  // types (name `__type` or absent), `isSdkOwnedType` is intentionally not
  // consulted because Zod-inferred inline objects often appear synthesized
  // and look external even though their shape is SDK-declared.
  const symbol = candidate.aliasSymbol ?? candidate.symbol;
  const decls = symbol?.declarations ?? [];
  for (const d of decls) {
    if (ts.isTypeParameterDeclaration(d)) return null;
  }

  // Only expand real object types with an own property list. Skip intrinsics,
  // unions, functions, etc.
  if (!(candidate.flags & ts.TypeFlags.Object)) return null;
  if (candidate.getCallSignatures().length > 0) return null;
  if (candidate.getConstructSignatures().length > 0) return null;

  const props = candidate.getProperties();
  if (props.length < 2) return null;

  return candidate;
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

function extractTsProperties(
  type: ts.Type,
  location: ts.Node,
  schemaHint?: string | string[],
): TypeField[] | null {
  if (!tsChecker) return null;

  const unwrapped = unwrapWrapperType(type) ?? type;
  const rawProps = unwrapped.getProperties();
  if (!rawProps || rawProps.length === 0) return null;

  // Derive a schema hint chain. Caller-supplied hints win (outermost first).
  // Fall back to the TS type's own alias/symbol so `z.infer<typeof X>` ->
  // `X` naming lets `lookupZodDescription` resolve describes scoped to the
  // originating schema, with ancestor schemas appended as a fallback for
  // inline sub-objects that carry no schema of their own.
  const callerHints: string[] =
    typeof schemaHint === "string"
      ? [schemaHint]
      : Array.isArray(schemaHint)
        ? schemaHint.filter(Boolean)
        : [];
  const derived =
    unwrapped.aliasSymbol?.name ??
    (unwrapped.symbol?.name && unwrapped.symbol.name !== "__type"
      ? unwrapped.symbol.name
      : undefined);
  const derivedHintList = [
    ...callerHints,
    ...(derived && !callerHints.includes(derived) ? [derived] : []),
  ];

  // `getProperties()` returns properties in (roughly) alphabetical order.
  // Re-sort by source-declaration position so the rendered table matches
  // the author's intended ordering (matches Zod `z.object({...})` key
  // insertion order and the hand-written sample layout).
  const props = [...rawProps].sort((a, b) => {
    const posA = a.valueDeclaration?.getStart?.() ?? a.declarations?.[0]?.getStart?.() ?? 0;
    const posB = b.valueDeclaration?.getStart?.() ?? b.declarations?.[0]?.getStart?.() ?? 0;
    if (posA !== posB) return posA - posB;
    // Stable fallback: preserve the order getProperties gave us when both
    // declarations live at the same position (e.g. synthetic merged types).
    return rawProps.indexOf(a) - rawProps.indexOf(b);
  });

  const fields: TypeField[] = [];
  for (const prop of props) {
    const propType = tsChecker.getTypeOfSymbolAtLocation(prop, location);
    const typeStr = tsChecker.typeToString(propType);
    const isOptional = !!(prop.flags & ts.SymbolFlags.Optional);

    const comment = prop.getDocumentationComment(tsChecker);
    let description = comment.map((c) => c.text).join("").trim();

    // Fallback: Zod `.describe()` metadata isn't visible to the TS compiler
    // (it's a runtime method call), but it IS the Zod-idiomatic way to
    // document fields. When no TS-level JSDoc exists, consult the map of
    // .describe() strings harvested from schema source files — scoped to
    // the parent type chain so describes don't leak across unrelated schemas.
    if (!description) {
      description = lookupZodDescription(prop.name, derivedHintList);
    }

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
 * named child types referenced by its properties. `visited` prevents cycles
 * for named types. Anonymous inline object properties (e.g. Zod-inferred
 * nested shapes) are also expanded using the property name as the heading.
 *
 * `ancestorHints` carries the chain of enclosing schema names from outer to
 * inner. Inline sub-objects often have no Zod schema of their own (e.g. the
 * `history.role` object inside `completionParamsSchema`), so describes
 * attached under the outer schema are the only source of prose. Passing the
 * chain lets `lookupZodDescription` try the current type name first and then
 * fall back to each ancestor.
 */
function expandTsType(
  type: ts.Type,
  typeName: string,
  location: ts.Node,
  visited: Set<string>,
  depth: number,
  ancestorHints: string[] = [],
): ExpandedType | null {
  if (!tsChecker) return null;
  if (depth > 4) return null;

  // Discriminated union: expand each variant as its own child subsection so
  // every field in every variant surfaces in the generated table. Pattern
  // comes from `z.discriminatedUnion("op", [...])` which infers to a union
  // of object types sharing a literal discriminator property.
  const variants = splitDiscriminatedUnion(type, location);
  if (variants) {
    const variantChildren: ExpandedType[] = [];
    for (const v of variants) {
      const variantChild = expandTsType(
        v.type,
        v.label,
        location,
        new Set(visited),
        depth + 1,
        [typeName, ...ancestorHints],
      );
      if (variantChild) variantChildren.push(variantChild);
    }
    if (variantChildren.length > 0) {
      // The union itself has no direct "fields" — only the discriminator is
      // guaranteed across all variants — so represent it as a pure parent.
      return { typeName, fields: [], children: variantChildren };
    }
  }

  // Pass the expanded typeName as a schema hint so `lookupZodDescription`
  // resolves describes scoped to the originating Zod schema (e.g.,
  // `CompletionParams` -> `completionParamsSchema`). The ancestor chain is
  // appended so inline sub-objects still resolve describes attached to the
  // outer schema.
  const fields = extractTsProperties(type, location, [typeName, ...ancestorHints]);
  if (!fields || fields.length === 0) return null;

  const children: ExpandedType[] = [];
  const seen = new Set<string>();
  const rawChildProps = type.getProperties();
  const sortedChildProps = [...rawChildProps].sort((a, b) => {
    const posA = a.valueDeclaration?.getStart?.() ?? a.declarations?.[0]?.getStart?.() ?? 0;
    const posB = b.valueDeclaration?.getStart?.() ?? b.declarations?.[0]?.getStart?.() ?? 0;
    return posA - posB;
  });
  const nextAncestors = [typeName, ...ancestorHints];
  for (const prop of sortedChildProps) {
    const propType = tsChecker.getTypeOfSymbolAtLocation(prop, location);

    const named = resolveNamedChildType(propType);
    if (named) {
      if (visited.has(named.name) || seen.has(named.name)) continue;
      seen.add(named.name);
      const childVisited = new Set(visited);
      childVisited.add(named.name);
      const child = expandTsType(
        named.objectType,
        named.name,
        location,
        childVisited,
        depth + 1,
        nextAncestors,
      );
      if (child) children.push(child);
      continue;
    }

    const inline = resolveInlineObjectType(propType);
    if (inline) {
      // Use the property name itself as the sub-section heading, since the
      // type has no user-facing alias in the source. Recover any alias name
      // from the property type (or the inline candidate) and push it as an
      // extra ancestor hint so `.describe()` strings attached to the named
      // Zod schema (e.g. `RPCOptions` -> `rpcOptionsSchema`) still resolve
      // for the nested field rows. The rendered heading stays `prop.name`
      // to match the sample layout, only the lookup uses the alias chain.
      if (seen.has(prop.name)) continue;
      seen.add(prop.name);
      const aliasName =
        propType.aliasSymbol?.name ??
        (propType.symbol?.name && propType.symbol.name !== "__type"
          ? propType.symbol.name
          : undefined) ??
        inline.aliasSymbol?.name ??
        (inline.symbol?.name && inline.symbol.name !== "__type"
          ? inline.symbol.name
          : undefined);
      const childAncestors = aliasName
        ? [aliasName, ...nextAncestors]
        : nextAncestors;
      const child = expandTsType(
        inline,
        prop.name,
        location,
        visited,
        depth + 1,
        childAncestors,
      );
      if (child) children.push(child);
    }
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

/**
 * Pull an `@default` / `@defaultValue` JSDoc block tag value from a TypeDoc
 * comment, stripping surrounding backticks (TypeDoc renders inline code as
 * backtick-wrapped text in block tags).
 */
function readJsDocDefault(comment: any): string | undefined {
  const blockTags = comment?.blockTags;
  if (!Array.isArray(blockTags)) return undefined;
  const tag = blockTags.find(
    (t: any) => t?.tag === "@default" || t?.tag === "@defaultValue",
  );
  if (!tag) return undefined;
  const raw = extractComment(tag.content).trim();
  if (!raw) return undefined;
  return raw.replace(/^`+|`+$/g, "").trim();
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

/**
 * Walk a TypeDoc type reflection and produce a machine-readable
 * `StructuredType` breakdown. Lets downstream consumers (codegen, API
 * linters, alternate renderers) introspect the type without parsing the
 * stringified `type` form. Mirrors `formatType`'s shape cases.
 */
function buildStructuredType(type: any): StructuredType | undefined {
  if (!type) return undefined;
  if (type.type === "intrinsic") {
    return { kind: "primitive", name: type.name };
  }
  if (type.type === "literal") {
    const v = type.value;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) {
      return { kind: "literal", value: v };
    }
    return { kind: "unknown" };
  }
  if (type.type === "reference") {
    return { kind: "reference", name: type.name };
  }
  if (type.type === "union" && Array.isArray(type.types)) {
    return {
      kind: "union",
      variants: type.types
        .map((t: any) => buildStructuredType(t))
        .filter((v: StructuredType | undefined): v is StructuredType => v !== undefined),
    };
  }
  if (type.type === "intersection" && Array.isArray(type.types)) {
    return {
      kind: "intersection",
      parts: type.types
        .map((t: any) => buildStructuredType(t))
        .filter((v: StructuredType | undefined): v is StructuredType => v !== undefined),
    };
  }
  if (type.type === "array") {
    const elem = buildStructuredType(type.elementType);
    return elem ? { kind: "array", element: elem } : { kind: "array", element: { kind: "unknown" } };
  }
  if (type.type === "reflection" && type.declaration) {
    if (type.declaration.signatures) return { kind: "function" };
    return { kind: "object" };
  }
  return { kind: "unknown" };
}

/**
 * Build a `function name(p: T, ...): R;` signature using pre-resolved param
 * and return strings. Lets `buildApiFunction` substitute syntactic alias
 * names (e.g., `CancelParams`) in place of TypeDoc's structural inlines
 * without re-running through `formatType`.
 */
function buildSyntacticSignature(
  name: string,
  parameters: Array<{ name: string; type: string; required: boolean }>,
  returnType: string,
  sig: any,
): string {
  const rawParams = (sig.parameters || []) as any[];
  const parts = parameters.map((p, idx) => {
    const raw = rawParams[idx];
    const optional = raw?.flags?.isOptional ? "?" : "";
    return `${p.name}${optional}: ${p.type}`;
  });
  return `function ${name}(${parts.join(", ")}): ${returnType};`;
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
  ancestorHints: string[] = [],
): ExpandedType | null {
  if (depth > 4) return null;

  const props = extractTypeProperties(type, visited);
  if (!props || props.length === 0) return null;

  const expanded: ExpandedType = { typeName, fields: [], children: [] };
  const hintChain = [typeName, ...ancestorHints];

  for (const prop of props) {
    const tsDoc = extractComment(prop.comment?.summary);
    expanded.fields.push({
      name: prop.name,
      type: formatType(prop.type),
      required: !prop.flags?.isOptional,
      defaultValue: cleanDefaultValue(prop.defaultValue) ?? readJsDocDefault(prop.comment),
      description: tsDoc || lookupZodDescription(prop.name, hintChain),
    });

    const childTypeName = getResolvableTypeName(prop.type);
    if (childTypeName && !visited.has(childTypeName)) {
      const childVisited = new Set(visited);
      childVisited.add(childTypeName);
      const child = resolveExpandedType(
        prop.type,
        childTypeName,
        childVisited,
        depth + 1,
        hintChain,
      );
      if (child) expanded.children.push(child);
    }

    if (prop.type?.type === "array" && prop.type.elementType) {
      const elName = getResolvableTypeName(prop.type.elementType);
      if (elName && !visited.has(elName)) {
        const childVisited = new Set(visited);
        childVisited.add(elName);
        const child = resolveExpandedType(
          prop.type.elementType,
          elName,
          childVisited,
          depth + 1,
          hintChain,
        );
        if (child) expanded.children.push(child);
      }
    }
  }

  return expanded;
}

function extractTypeProperties(type: any, visited: Set<string>): any[] | null {
  if (!type) return null;

  if (type.type === "reference") {
    // Unwrap common container types whose payload is the meaningful object:
    // `Promise<T>` (function return values), `Readonly<T>`, `Partial<T>`,
    // `Required<T>`, `Awaited<T>`. Without this the Return table is empty
    // for every async function that returns an anonymous object shape.
    const name = type.name as string | undefined;
    const args = (type.typeArguments as any[] | undefined) ?? [];
    if (
      args.length > 0 &&
      name &&
      (name === "Promise" ||
        name === "Readonly" ||
        name === "Partial" ||
        name === "Required" ||
        name === "Awaited")
    ) {
      return extractTypeProperties(args[0], visited);
    }

    const refl = type.reflection ?? type.target;
    if (refl && typeof refl === "object") {
      if (refl.children) return refl.children;
      if (refl.type) return extractTypeProperties(refl.type, visited);
    }

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

  // Union types: for non-discriminated unions where all variants have the
  // same shape (e.g. `T | undefined`, `T | null`), return the non-null
  // variant's properties so optional returns still produce a field table.
  // Discriminated unions are handled separately (see resolveUnionVariants).
  if (type.type === "union" && type.types) {
    const nonNull = type.types.filter((t: any) => {
      if (t?.type === "intrinsic" && (t.name === "null" || t.name === "undefined")) return false;
      if (t?.type === "literal" && (t.value === null || t.value === undefined)) return false;
      return true;
    });
    if (nonNull.length === 1) {
      return extractTypeProperties(nonNull[0], visited);
    }
  }

  return null;
}

/**
 * Strip one layer of common wrapper types (`Promise<T>`, `Readonly<T>`,
 * `Partial<T>`, `Required<T>`, `Awaited<T>`) and union-with-undefined from
 * a TypeDoc reflection type, returning the payload type. Returns `null`
 * when the type isn't wrapped so callers can fall back to the original.
 */
function unwrapReturnWrapper(type: any): any | null {
  if (!type) return null;

  // Union with undefined / null: keep only the meaningful alternative.
  if (type.type === "union" && Array.isArray(type.types)) {
    const meaningful = type.types.filter(
      (t: any) =>
        !(
          (t?.type === "intrinsic" && (t.name === "undefined" || t.name === "null")) ||
          (t?.type === "literal" && (t.value === null))
        ),
    );
    if (meaningful.length === 1) {
      return unwrapReturnWrapper(meaningful[0]) ?? meaningful[0];
    }
  }

  if (type.type === "reference") {
    const name = type.name as string | undefined;
    const args = (type.typeArguments as any[] | undefined) ?? [];
    if (
      args.length > 0 &&
      name &&
      (name === "Promise" ||
        name === "Readonly" ||
        name === "Partial" ||
        name === "Required" ||
        name === "Awaited")
    ) {
      return unwrapReturnWrapper(args[0]) ?? args[0];
    }
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
