/**
 * Zod `.describe()` extractor.
 *
 * Walks TypeScript source files under a given directory and harvests the
 * human-readable description string attached to every Zod schema property
 * via a `.describe("...")` call. Produces both a per-schema map (keyed by
 * the schema variable name) and a global name-based map (for properties
 * whose name is unique across all scanned schemas — the common case).
 *
 * Used by `extract.ts` as a supplementary description source. The TypeScript
 * type checker never sees `.describe()` because it's a runtime method call,
 * so the inferred `z.infer<typeof X>` type propagates no description. This
 * module closes that gap without requiring additional JSDoc in the SDK.
 */

import * as fs from "fs/promises";
import * as path from "path";
import ts from "typescript";

export interface ZodDescriptionMap {
  /**
   * Per-schema map keyed by both the Zod schema variable name (e.g.
   * `completionParamsSchema`) AND every TypeScript type alias derived from
   * it via `z.infer<typeof X>` / `z.input<typeof X>` (e.g. `CompletionParams`).
   * Use this when the caller can identify which schema the property came
   * from (e.g., via the inferred type alias's `_target`). Lookups are
   * normalized by the caller via `lookupZodDescription` so that either the
   * schema variable name or the TypeScript type alias name resolves.
   */
  bySchema: Map<string, Map<string, string>>;
  /**
   * Global map: `propertyName -> description`. Only populated when a given
   * property name resolves to exactly one description across all schemas
   * (i.e., no conflicts). Properties with multiple conflicting descriptions
   * are omitted to avoid picking the wrong one.
   *
   * **Do not use as a fallback without explicit opt-in.** Field names like
   * `text`, `modelId`, and `params` collide across SDK schemas, so a single
   * `.describe()` in one schema would incorrectly leak into every other
   * surface that happens to expose a same-named field. `lookupZodDescription`
   * only consults this map when the caller sets `allowGlobalFallback=true`,
   * which should be reserved for contexts where cross-context leakage is
   * acceptable. Most call sites should pass a `schemaHint` instead.
   */
  byNameUnique: Map<string, string>;
  /** Property names seen with more than one distinct description. */
  conflicts: Map<string, Set<string>>;
}

/**
 * Walk a directory of Zod schema files and return a merged description map.
 * Non-TS files, `index.ts` barrels, and files that don't contain any Zod
 * schemas are silently skipped.
 */
export async function extractZodDescriptions(
  schemasDir: string,
): Promise<ZodDescriptionMap> {
  const bySchema = new Map<string, Map<string, string>>();
  const byNameAll = new Map<string, Set<string>>();

  let entries: string[];
  try {
    entries = await fs.readdir(schemasDir);
  } catch {
    return { bySchema, byNameUnique: new Map(), conflicts: new Map() };
  }

  // Sort deterministically: fs.readdir order varies by platform/filesystem,
  // and when two schema files export variables with the same name we want
  // the "winner" for the bySchema map to be stable across machines.
  entries.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

  const typeAliases: Array<{ alias: string; schema: string }> = [];
  const propSchemaRefs: Array<{ propName: string; schema: string }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".d.ts")) continue;
    const full = path.join(schemasDir, entry);
    const raw = await fs.readFile(full, "utf-8").catch(() => null);
    if (!raw) continue;

    const source = ts.createSourceFile(
      full,
      raw,
      ts.ScriptTarget.Latest,
      true,
    );
    collectFromSourceFile(source, bySchema, byNameAll);
    collectTypeAliases(source, typeAliases);
    collectPropertySchemaRefs(source, propSchemaRefs);
  }

  // Mirror each Zod schema's description map under the TypeScript type
  // alias names derived from it (e.g., `type CompletionParams = z.infer<typeof
  // completionParamsSchema>` → bySchema.CompletionParams === bySchema.completionParamsSchema).
  // This lets callers in extract.ts hint with the TS type name (which is
  // what TypeDoc surfaces) and still resolve the corresponding .describe()
  // strings without a manual conversion table.
  for (const { alias, schema } of typeAliases) {
    const src = bySchema.get(schema);
    if (src && !bySchema.has(alias)) {
      bySchema.set(alias, src);
    }
  }

  // Mirror schemas under property-name-like keys as a last-resort lookup.
  // Intersections like `Omit<X, "a"> & { y: Y }` flatten property types in
  // TypeScript's inferred form, so the `Y` alias symbol may be lost by the
  // time extract.ts receives the property type. We fall back to matching on
  // the property's own name by convention: `rpcOptionsSchema` → key
  // `rpcOptions` (drop trailing "Schema", lowercase first char), so when
  // extract.ts hints with the property name it still resolves the describes
  // attached to the originating schema. Only added for schemas whose
  // convention-derived name isn't already taken, to avoid collisions.
  for (const [schemaName, map] of [...bySchema.entries()]) {
    const derived = propNameFromSchemaVar(schemaName);
    if (derived && !bySchema.has(derived)) {
      bySchema.set(derived, map);
    }
  }

  // Also expose each schema under every property name that uses it. E.g.
  // `rpcOptionsSchema.profiling: perCallProfilingSchema.optional()` adds
  // `profiling` → perCallProfilingSchema's map. This lets extract.ts
  // resolve nested fields via the inline section heading (which uses the
  // property name) when the property type's TypeScript alias symbol has
  // been flattened through an intersection. Only add when the target key
  // isn't already populated, so dedicated schemas keep priority.
  for (const { propName, schema } of propSchemaRefs) {
    const src = bySchema.get(schema);
    if (src && !bySchema.has(propName)) {
      bySchema.set(propName, src);
    }
  }

  const byNameUnique = new Map<string, string>();
  const conflicts = new Map<string, Set<string>>();
  for (const [name, descs] of byNameAll) {
    if (descs.size === 1) {
      byNameUnique.set(name, [...descs][0]);
    } else {
      conflicts.set(name, descs);
    }
  }
  return { bySchema, byNameUnique, conflicts };
}

/**
 * Derive a property-name-like key from a Zod schema variable name following
 * the SDK convention `<prop>Schema` or `<Prop>Schema`. Returns `null` when
 * the input doesn't match the convention so the caller can skip adding an
 * alias.
 *
 * Examples:
 *   rpcOptionsSchema      -> rpcOptions
 *   completionParamsSchema -> completionParams
 *   embedParamsSchema     -> embedParams
 *   foo                    -> null (no `Schema` suffix)
 */
function propNameFromSchemaVar(schemaVar: string): string | null {
  if (!schemaVar.endsWith("Schema")) return null;
  const stripped = schemaVar.slice(0, -"Schema".length);
  if (!stripped) return null;
  return stripped[0].toLowerCase() + stripped.slice(1);
}

/**
 * Scan a source file for property assignments of the shape
 * `<propName>: <otherSchema>.optional()` (or similar Zod method chains)
 * inside object literals. Each match records an alias
 * `propName -> otherSchema` so `extractZodDescriptions` can expose the
 * referenced schema's describes under the property name used at the call
 * site. Example: `rpcOptionsSchema.profiling: perCallProfilingSchema.optional()`
 * → `profiling -> perCallProfilingSchema`.
 *
 * The first rule is "first writer wins": the first occurrence of a given
 * property name is recorded, subsequent conflicting ones are ignored. This
 * avoids later occurrences clobbering an earlier semantic match.
 */
function collectPropertySchemaRefs(
  source: ts.SourceFile,
  out: Array<{ propName: string; schema: string }>,
): void {
  const seen = new Set<string>();
  const record = (propName: string, schema: string) => {
    if (seen.has(propName)) return;
    seen.add(propName);
    out.push({ propName, schema });
  };

  const extractSchemaRef = (expr: ts.Node): string | null => {
    let current: ts.Node = expr;
    // Walk the chain: `schema.optional().default(x).describe("...")` reaches
    // the bare identifier at the head.
    while (true) {
      if (ts.isParenthesizedExpression(current)) {
        current = current.expression;
        continue;
      }
      if (ts.isCallExpression(current)) {
        current = current.expression;
        continue;
      }
      if (ts.isPropertyAccessExpression(current)) {
        current = current.expression;
        continue;
      }
      break;
    }
    if (ts.isIdentifier(current) && /Schema$/.test(current.text)) {
      return current.text;
    }
    return null;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const nameNode = node.name;
      let propName: string | null = null;
      if (ts.isIdentifier(nameNode)) propName = nameNode.text;
      else if (ts.isStringLiteral(nameNode)) propName = nameNode.text;
      if (propName) {
        const schema = extractSchemaRef(node.initializer);
        if (schema) record(propName, schema);
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
}

/**
 * Scan a source file for `export type X = z.infer<typeof Y>` (or `z.input`)
 * declarations. Each match records an alias `X -> Y` so the caller can
 * populate `bySchema` with both the Zod schema variable name and the
 * TypeScript type alias surfaced by TypeDoc.
 */
function collectTypeAliases(
  source: ts.SourceFile,
  out: Array<{ alias: string; schema: string }>,
): void {
  ts.forEachChild(source, (node) => {
    if (!ts.isTypeAliasDeclaration(node)) return;
    const aliasName = node.name.text;
    const t = node.type;
    if (!ts.isTypeReferenceNode(t)) return;
    if (!ts.isQualifiedName(t.typeName) && !ts.isIdentifier(t.typeName)) return;

    const head = ts.isQualifiedName(t.typeName)
      ? t.typeName.left
      : t.typeName;
    const tail = ts.isQualifiedName(t.typeName)
      ? t.typeName.right.text
      : t.typeName.text;
    const isZ =
      (ts.isIdentifier(head) && head.text === "z") ||
      (tail !== "infer" && tail !== "input");
    if (!isZ) return;
    if (tail !== "infer" && tail !== "input") return;

    const arg = t.typeArguments?.[0];
    if (!arg) return;

    // `typeof X` is parsed as a TypeQueryNode referencing `X`.
    if (!ts.isTypeQueryNode(arg)) return;
    const ref = arg.exprName;
    const schemaName = ts.isIdentifier(ref) ? ref.text : null;
    if (!schemaName) return;
    out.push({ alias: aliasName, schema: schemaName });
  });
}

/**
 * Walk every top-level `export const xSchema = ...` declaration in a source
 * file. When the initializer is a Zod object schema, descend into its
 * property list and record any `.describe()` calls found.
 */
function collectFromSourceFile(
  source: ts.SourceFile,
  bySchema: Map<string, Map<string, string>>,
  byNameAll: Map<string, Set<string>>,
): void {
  ts.forEachChild(source, (node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      if (!decl.initializer) continue;
      const schemaName = decl.name.text;
      const map = new Map<string, string>();
      collectFromExpression(decl.initializer, map);
      if (map.size > 0) {
        bySchema.set(schemaName, map);
        for (const [propName, desc] of map) {
          const bucket = byNameAll.get(propName) ?? new Set<string>();
          bucket.add(desc);
          byNameAll.set(propName, bucket);
        }
      }
    }
  });
}

/**
 * Descend an expression looking for `z.object({ ... })` / `.extend({...})` /
 * `.merge({...})` argument lists. For each property assignment found, record
 * the property's `.describe()` description (if any) and recurse into its
 * initializer to handle nested `z.object()` blocks.
 *
 * Silently returns for expressions that don't match any Zod-shape pattern.
 */
function collectFromExpression(
  expr: ts.Node,
  map: Map<string, string>,
): void {
  if (ts.isCallExpression(expr)) {
    // z.object({...}), schema.extend({...}), schema.merge({...})
    const callee = expr.expression;
    let calleeName: string | null = null;
    if (ts.isPropertyAccessExpression(callee)) {
      calleeName = callee.name.text;
    } else if (ts.isIdentifier(callee)) {
      calleeName = callee.text;
    }
    if (
      calleeName === "object" ||
      calleeName === "extend" ||
      calleeName === "merge" ||
      calleeName === "partial" ||
      calleeName === "pick" ||
      calleeName === "omit"
    ) {
      for (const arg of expr.arguments) {
        if (ts.isObjectLiteralExpression(arg)) {
          collectPropertiesFromObjectLiteral(arg, map);
        }
      }
    }
    // Recurse into the receiver so things like `baseSchema.extend({...})`
    // also pick up the `baseSchema` half (if it's inline) and any chained
    // `.describe()` calls.
    collectFromExpression(expr.expression, map);
    for (const arg of expr.arguments) collectFromExpression(arg, map);
    return;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    collectFromExpression(expr.expression, map);
    return;
  }
  if (ts.isParenthesizedExpression(expr)) {
    collectFromExpression(expr.expression, map);
    return;
  }
  // Pass through other wrappers without losing data.
  ts.forEachChild(expr, (child) => collectFromExpression(child, map));
}

/**
 * For each property in a Zod object literal's shape (`{ name: z.string()... }`),
 * extract the description if its initializer chain contains `.describe("...")`,
 * and recurse into any nested `z.object({...})` to gather inner descriptions.
 */
function collectPropertiesFromObjectLiteral(
  obj: ts.ObjectLiteralExpression,
  map: Map<string, string>,
): void {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    let name: string | null = null;
    if (ts.isIdentifier(prop.name)) name = prop.name.text;
    else if (ts.isStringLiteral(prop.name)) name = prop.name.text;
    if (!name) continue;

    const desc = findDescribeInChain(prop.initializer);
    if (desc != null) {
      map.set(name, desc);
    }
    // Nested z.object(...) still need their inner descriptions collected so
    // they're available when the extractor walks deeper into the inferred
    // type tree.
    collectFromExpression(prop.initializer, map);
  }
}

/**
 * Walk a Zod method chain (`z.string().optional().describe("text")`) and
 * return the string literal passed to the outermost `.describe()` call, if
 * any. Handles nested parentheses, `.nullable()`, `.default()`, and other
 * chain methods.
 */
function findDescribeInChain(expr: ts.Node): string | null {
  let current: ts.Node = expr;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (!ts.isCallExpression(current)) break;
    const callee = current.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "describe") {
      const arg = current.arguments[0];
      if (arg && ts.isStringLiteral(arg)) return arg.text;
      if (arg && ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
    }
    // Walk up the chain (left-hand side of the dot access).
    if (ts.isPropertyAccessExpression(callee)) {
      current = callee.expression;
      continue;
    }
    break;
  }
  return null;
}
