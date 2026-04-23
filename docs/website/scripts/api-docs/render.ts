/**
 * Rendering phase: reads extracted api-data.json and produces MDX files.
 * Page-level assembly uses Nunjucks templates in scripts/api-docs/templates/.
 * Complex sub-section helpers (expanded type tables, error tables) are
 * registered as Nunjucks globals/filters so templates can call them.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "node:url";
import nunjucks from "nunjucks";
import type { ApiData, ApiFunction, ApiObject, ApiType, ExpandedType, TypeField, ErrorEntry } from "./types.js";
import { readErrorOverrides, type SampleErrorOverride } from "./sample-parser.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(SCRIPT_DIR, "templates");

export interface RenderOptions {
  versionLabel: string;
  /**
   * Absolute path to the hand-written samples directory (e.g.,
   * `content/docs/(latest)/sdk/api`). When provided, the renderer uses
   * sample-curated content (error summaries, etc.) as an override source on
   * top of extracted data. Omit for purely generative runs.
   */
  samplesDir?: string;
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
  env.addFilter("leadingAliasName", leadingAliasName);
  env.addFilter("lower", (s: string) => s.toLowerCase());
  env.addFilter("replace", (s: string, from: string, to: string) =>
    s.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), to),
  );

  env.addGlobal("renderExpandedTypes", renderExpandedTypes);
  env.addGlobal("renderErrorTable", renderErrorTable);
  env.addGlobal("renderParamRow", renderParamRow);
  env.addGlobal("renderObjectMethod", renderObjectMethod);

  return env;
}

// ---------------------------------------------------------------------------
// Filters — each replicates logic formerly inlined in generate-api-docs.ts
// ---------------------------------------------------------------------------

/**
 * Collapse newlines and runs of whitespace into single spaces, so multi-line
 * JSDoc descriptions render as a single logical line in GFM pipe tables.
 */
function collapseWhitespace(str: string): string {
  return str.replace(/\s+/g, " ").trim();
}

/** Escape backslashes, pipes, and braces for error-table cells. */
export function escapeTable(str: string): string {
  return collapseWhitespace(str)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[{}]/g, "\\$&");
}

/**
 * Escape backslashes, braces, and pipes for type strings and descriptions
 * inside parameter / field tables. Also collapses newlines so multi-line
 * prose fits in a single table cell without breaking the row.
 */
export function escapeTableLight(str: string): string {
  return collapseWhitespace(str)
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\|/g, "\\|");
}

/** Extract the first sentence from a block of text, on a single line. */
export function firstSentence(text: string): string {
  const normalized = collapseWhitespace(text);
  const match = normalized.match(/^[^.!?]+[.!?]/);
  return match ? match[0] : normalized;
}

/**
 * Extract the leading PascalCase type identifier from a type expression, used
 * to render a `### TypeName` subsection heading below `## Returns` when the
 * return type is a named alias (matches the sample convention).
 *
 * Examples:
 *   "RegistryItem | undefined" -> "RegistryItem"
 *   "ProfilerExport"           -> "ProfilerExport"
 *   "Promise<void>"            -> "" (built-in wrapper, no anchor)
 *   "Record<string, X>"        -> "" (built-in generic)
 *   "{ foo: string }"          -> "" (inline structural type)
 */
export function leadingAliasName(type: string): string {
  if (!type) return "";
  const trimmed = type.trim();
  const match = trimmed.match(/^([A-Z][A-Za-z0-9_]+)(\b|$)/);
  if (!match) return "";
  const name = match[1];
  const builtin = new Set([
    "Promise", "Array", "Record", "Partial", "Readonly", "Required",
    "Pick", "Omit", "Map", "Set", "Date", "RegExp", "Error",
    "AsyncGenerator", "AsyncIterable", "AsyncIterator", "Iterable",
    "Iterator", "Function", "Object", "String", "Number", "Boolean",
  ]);
  if (builtin.has(name)) return "";
  // Only treat as an alias anchor when the name is followed by end-of-string,
  // whitespace, or a `|` union marker. Generic wrappers like `Foo<T>` don't
  // match the convention sampled in the hand-written files.
  const after = trimmed.slice(name.length).trim();
  if (after === "" || after.startsWith("|")) return name;
  return "";
}

/** Convert a string to a URL-safe anchor slug. */
export function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Strip leading `function ` keyword and escape backslashes and pipes for table display. */
export function formatShortSignature(sig: string): string {
  return sig
    .replace(/^function\s+/, "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

/**
 * Escape a string for safe embedding in a single-line YAML frontmatter value.
 * Collapses newlines/whitespace runs and escapes backslashes and double-quotes.
 */
export function escapeQuotes(str: string): string {
  return collapseWhitespace(str)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

/** Strip surrounding code fences from an example string. */
export function stripFence(str: string): string {
  return str.replace(/^```\w*\n?/, "").replace(/\n?```\s*$/, "");
}

// ---------------------------------------------------------------------------
// Globals — sub-section rendering helpers used by templates
// ---------------------------------------------------------------------------

export function renderExpandedTypes(types: ExpandedType[], baseDepth: number): string {
  const sections: string[] = [];

  for (const expanded of types) {
    const heading = "#".repeat(Math.min(baseDepth, 5));
    const hasDefaults = expanded.fields.some((f) => f.defaultValue != null);

    // Discriminated-union parent: no shared fields, only per-variant children.
    // Emit the heading alone (so the union's anchor still resolves) and let
    // the recursive call render each variant as a nested subsection.
    if (expanded.fields.length === 0 && expanded.children.length > 0) {
      sections.push(`${heading} \`${expanded.typeName}\``);
      sections.push(renderExpandedTypes(expanded.children, baseDepth + 1));
      continue;
    }

    const header = hasDefaults
      ? `| Field | Type | Required? | Default | Description |\n| --- | --- | :---: | --- | --- |`
      : `| Field | Type | Required? | Description |\n| --- | --- | :---: | --- |`;

    const rows = expanded.fields
      .map((f) => {
        const typeStr = escapeTableLight(f.type);
        const req = f.required ? "\u2713" : "\u2717";
        const desc = escapeTableLight(f.description || "\u2014");
        if (hasDefaults) {
          const def = f.defaultValue ? `\`${escapeTableLight(f.defaultValue)}\`` : "\u2014";
          return `| ${f.name} | \`${typeStr}\` | ${req} | ${def} | ${desc} |`;
        }
        return `| ${f.name} | \`${typeStr}\` | ${req} | ${desc} |`;
      })
      .join("\n");

    sections.push(`${heading} \`${expanded.typeName}\`\n\n${header}\n${rows}`);

    if (expanded.children.length > 0) {
      sections.push(renderExpandedTypes(expanded.children, baseDepth + 1));
    }
  }

  return sections.join("\n\n");
}

export interface ApiParameter {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
  description: string;
}

/**
 * Render a single parameter row for the top-level Parameters table.
 * Emits plain markdown without Nunjucks whitespace artifacts. Links to an
 * expanded type section when the parameter's type name matches one of the
 * already-expanded types.
 */
export function renderParamRow(
  p: ApiParameter,
  expandedParams: ExpandedType[],
  hasDefaults: boolean,
): string {
  const typeStr = escapeTableLight(p.type);
  const anchor = slugify(p.type);
  const hasExpansion = expandedParams.some(
    (e) => e.typeName.toLowerCase() === p.type.toLowerCase(),
  );
  const typeCell = hasExpansion
    ? `[\`${typeStr}\`](#${anchor})`
    : `\`${typeStr}\``;
  const req = p.required ? "\u2713" : "\u2717";
  const desc = escapeTableLight(p.description || "No description");
  if (hasDefaults) {
    const def = p.defaultValue ? `\`${escapeTableLight(p.defaultValue)}\`` : "\u2014";
    return `| ${p.name} | ${typeCell} | ${req} | ${def} | ${desc} |`;
  }
  return `| ${p.name} | ${typeCell} | ${req} | ${desc} |`;
}

/**
 * Render a single object method as a markdown subsection, mirroring the
 * per-function layout in `function-page.njk` but scoped under a heading at
 * `headingDepth` (typically 3 for top-level methods of an object page).
 *
 * Returns a self-contained markdown block. Logical "blocks" (heading, code
 * fence, paragraph, table) are separated by a single blank line; lines inside
 * a block (table rows, code contents) are joined with `\n` only.
 */
export function renderObjectMethod(
  fn: ApiFunction,
  headingDepth: number = 3,
): string {
  const heading = "#".repeat(Math.min(headingDepth, 5));
  const blocks: string[] = [];

  blocks.push(`${heading} \`${fn.name}()\``);

  if (fn.deprecated) {
    blocks.push(
      `<Callout type="warn" title="Deprecated">\n${fn.deprecated}\n</Callout>`,
    );
  }

  blocks.push(
    ["```ts", fn.signature.replace(/^function\s+/, "function ").replace(/;\s*$/, ""), "```"].join("\n"),
  );

  if (fn.description) {
    blocks.push(sanitizeText(fn.description));
  }

  if (fn.parameters.length > 0) {
    const hasDefaults = fn.parameters.some((p) => p.defaultValue != null);
    const tableLines: string[] = [];
    tableLines.push("**Parameters**");
    tableLines.push("");
    if (hasDefaults) {
      tableLines.push("| Name | Type | Required? | Default | Description |");
      tableLines.push("| --- | --- | :---: | --- | --- |");
    } else {
      tableLines.push("| Name | Type | Required? | Description |");
      tableLines.push("| --- | --- | :---: | --- |");
    }
    for (const p of fn.parameters) {
      tableLines.push(renderParamRow(p, fn.expandedParams, hasDefaults));
    }
    blocks.push(tableLines.join("\n"));
  } else {
    blocks.push("**Parameters**\n\nNo parameters.");
  }

  if (fn.expandedParams.length > 0) {
    blocks.push(renderExpandedTypes(fn.expandedParams, headingDepth + 1));
  }

  const returnType = fn.returns?.type || "unknown";
  const returnDesc = sanitizeText(fn.returns?.description || "");
  const returnsBlock: string[] = ["**Returns**", ""];
  if (returnDesc) {
    // If the description already begins with a backticked type (e.g.,
    // "`boolean` — true if...") or a linked type (e.g., "[`Foo`](#foo) —
    // ..."), use it verbatim — the prose already names the return type.
    // Otherwise prepend the return type so the user sees it next to the prose.
    const startsWithType =
      /^`[^`]+`(\s*—|\s*$)/.test(returnDesc) ||
      /^\[`[^`]+`\]\([^)]+\)(\s*—|\s*:|\s*$)/.test(returnDesc);
    if (startsWithType) {
      returnsBlock.push(returnDesc);
    } else {
      returnsBlock.push(`\`${returnType}\` — ${returnDesc}`);
    }
  } else {
    returnsBlock.push(`\`${returnType}\``);
  }
  if (fn.returnFields.length > 0) {
    // Promote the return-type field table under a `#### TypeName` heading
    // when the return type is a named alias — matches the sample structure
    // seen in profiler's exportJSON → ProfilerExport section.
    const alias = leadingAliasName(returnType);
    blocks.push(returnsBlock.join("\n"));
    const tableLines: string[] = [];
    if (alias) {
      const subHeading = "#".repeat(Math.min(headingDepth + 1, 6));
      tableLines.push(`${subHeading} \`${alias}\``);
      tableLines.push("");
    }
    tableLines.push("| Field | Type | Description |");
    tableLines.push("| --- | --- | --- |");
    for (const f of fn.returnFields) {
      tableLines.push(
        `| ${f.name} | \`${escapeTableLight(f.type)}\` | ${escapeTableLight(f.description || "\u2014")} |`,
      );
    }
    blocks.push(tableLines.join("\n"));
  } else {
    blocks.push(returnsBlock.join("\n"));
  }

  if (fn.expandedReturns.length > 0) {
    blocks.push(renderExpandedTypes(fn.expandedReturns, headingDepth + 1));
  }

  if (fn.throws && fn.throws.length > 0) {
    const throwsLines: string[] = [];
    throwsLines.push("**Throws**");
    throwsLines.push("");
    throwsLines.push("| Error | When |");
    throwsLines.push("| --- | --- |");
    for (const t of fn.throws) {
      throwsLines.push(
        `| \`${escapeTableLight(t.error)}\` | ${escapeTableLight(t.description || "\u2014")} |`,
      );
    }
    blocks.push(throwsLines.join("\n"));
  }

  if (fn.examples && fn.examples.length > 0) {
    for (const ex of fn.examples) {
      blocks.push(["```typescript", stripFence(ex), "```"].join("\n"));
    }
  }

  return blocks.join("\n\n");
}

export function renderErrorTable(entries: ErrorEntry[]): string {
  return `| Error | Code | Summary |
| --- | --- | --- |
${entries.map((e) => `| \`${e.name}\` | ${e.code} | ${escapeTable(e.summary)} |`).join("\n")}`;
}

// ---------------------------------------------------------------------------
// Data sanitization — replace "undefined" artifacts in prose fields only,
// leaving type signatures and code examples intact.
// ---------------------------------------------------------------------------

function sanitizeText(text: string): string {
  return text === "undefined" || text === "null" ? "\u2014" : text;
}

/**
 * Rewrite same-page `#typename` anchors to `../shared-types#typename` when
 * the referenced type lives on the shared-types page. Without this, Returns
 * descriptions like `[\`RegistryItem\`](#registryitem)` would be broken
 * links because the `### RegistryItem` subsection on the function page is
 * suppressed (it lives on shared-types.mdx instead).
 */
function rewriteSharedTypeAnchors(
  fn: ApiFunction,
  sharedTypeNames: Set<string>,
): void {
  if (sharedTypeNames.size === 0) return;
  const rewrite = (s: string | undefined): string | undefined => {
    if (!s) return s;
    // Match `](#name)` but NOT `](../shared-types#name)` (already cross-linked).
    return s.replace(/\]\(#([a-zA-Z][a-zA-Z0-9_-]*)\)/g, (full, anchor) => {
      // The MDX anchor for `### \`Name\`` is `name` (lowercase, no backticks).
      // Match against shared-type names case-insensitively.
      for (const t of sharedTypeNames) {
        if (t.toLowerCase() === anchor.toLowerCase()) {
          return `](../shared-types#${anchor})`;
        }
      }
      return full;
    });
  };
  if (fn.returns) fn.returns.description = rewrite(fn.returns.description) ?? "";
  for (const p of fn.parameters) p.description = rewrite(p.description) ?? "";
  for (const f of fn.returnFields) f.description = rewrite(f.description) ?? "";
}

function sanitizeFunctionData(fn: ApiFunction): void {
  fn.description = sanitizeText(fn.description);
  if (fn.returns) {
    fn.returns.description = sanitizeText(fn.returns.description);
  }
  for (const p of fn.parameters) {
    p.description = sanitizeText(p.description);
  }
  for (const f of fn.returnFields) {
    f.description = sanitizeText(f.description);
  }
}

/**
 * Invert every function's `throws` array into a `errorName -> [functionName]`
 * map, then render `errors.*.thrownBy` as a comma-joined list of backticked
 * function-call strings (`loadModel()`, `completion()`, ...).
 *
 * When `sampleOverrides` is provided (from a hand-written `errors.mdx`
 * sample), its curated `summary` and `thrownBy` labels override the
 * automated scan. This is how curated non-function labels like "Internal
 * RPC layer" or "Any API call (during SDK initialization)" get through —
 * they can't be produced by scanning public function JSDoc.
 */
function annotateErrorsWithThrowers(
  apiData: ApiData,
  sampleOverrides?: Map<string, SampleErrorOverride>,
): void {
  const errorToFunctions = new Map<string, string[]>();
  for (const fn of apiData.functions) {
    if (!fn.throws) continue;
    for (const t of fn.throws) {
      if (!t.error) continue;
      const list = errorToFunctions.get(t.error) ?? [];
      if (!list.includes(fn.name)) list.push(fn.name);
      errorToFunctions.set(t.error, list);
    }
  }

  const format = (entry: ErrorEntry) => {
    const override = sampleOverrides?.get(entry.name);
    if (override) {
      if (override.summary) entry.summary = override.summary;
      if (override.thrownBy) {
        entry.thrownBy = override.thrownBy;
        return;
      }
    }
    const throwers = errorToFunctions.get(entry.name);
    if (!throwers || throwers.length === 0) return;
    const sorted = throwers.slice().sort();
    entry.thrownBy = sorted.map((n) => `\`${n}()\``).join(", ");
  };
  for (const e of apiData.errors.client) format(e);
  for (const e of apiData.errors.server) format(e);
}

/**
 * For each public API surface (function or object), collect the set of
 * PascalCase type names it references. Used by `collectReferencedTypes` to
 * find types that cross 2+ surfaces (truly shared) vs types referenced by a
 * single surface (already documented inline in that page).
 */
function collectTypeReferencesPerSurface(apiData: ApiData): Map<string, Set<string>> {
  const builtin = new Set([
    "Array", "Promise", "Record", "Partial", "Readonly", "Required",
    "Pick", "Omit", "Map", "Set", "Date", "RegExp", "Error",
    "AsyncGenerator", "AsyncIterable", "AsyncIterator", "Iterable",
    "Iterator", "Function", "Object", "String", "Number", "Boolean",
  ]);
  const nameRe = /\b([A-Z][A-Za-z0-9_]+)\b/g;

  const extractNames = (s: string | undefined, target: Set<string>) => {
    if (!s) return;
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(s)) !== null) {
      const name = m[1];
      if (!builtin.has(name)) target.add(name);
    }
  };
  const collectExpanded = (nodes: ExpandedType[], target: Set<string>) => {
    for (const n of nodes) {
      target.add(n.typeName);
      for (const f of n.fields) extractNames(f.type, target);
      collectExpanded(n.children, target);
    }
  };

  const result = new Map<string, Set<string>>();
  for (const fn of apiData.functions) {
    const set = new Set<string>();
    extractNames(fn.signature, set);
    for (const p of fn.parameters) extractNames(p.type, set);
    extractNames(fn.returns?.type, set);
    for (const f of fn.returnFields) extractNames(f.type, set);
    collectExpanded(fn.expandedParams, set);
    collectExpanded(fn.expandedReturns, set);
    result.set(`fn:${fn.name}`, set);
  }
  if (apiData.objects) {
    for (const obj of apiData.objects) {
      const set = new Set<string>();
      extractNames(obj.objectSignature, set);
      for (const f of obj.fields) extractNames(f.type, set);
      collectExpanded(obj.children, set);
      if (obj.methods) {
        for (const m of obj.methods) {
          extractNames(m.signature, set);
          for (const p of m.parameters) extractNames(p.type, set);
          extractNames(m.returns?.type, set);
          for (const f of m.returnFields) extractNames(f.type, set);
          collectExpanded(m.expandedParams, set);
          collectExpanded(m.expandedReturns, set);
        }
      }
      result.set(`obj:${obj.name}`, set);
    }
  }
  return result;
}

/**
 * Walk every function/object and collect the names of types referenced by
 * 2+ public API surfaces. Single-surface types live inline on their owning
 * page (function.mdx) and are NOT duplicated in shared-types; this mirrors
 * the hand-authored sample convention where `shared-types.mdx` only hosts
 * genuinely cross-cutting types (RPCOptions, PerCallProfiling, RegistryItem).
 *
 * Transitive children of multi-surface types are still pulled in — so
 * `PerCallProfiling` (nested inside `RPCOptions`) surfaces alongside its
 * parent even if it's only named through it.
 */
function collectReferencedTypes(apiData: ApiData): Set<string> {
  const perSurface = collectTypeReferencesPerSurface(apiData);
  const count = new Map<string, number>();
  for (const names of perSurface.values()) {
    for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  }
  const multiReferenced = new Set<string>();
  for (const [name, c] of count) {
    if (c >= 2) multiReferenced.add(name);
  }

  // Transitive closure: pull in any type referenced from a multi-referenced
  // type's definition (e.g. `PerCallProfiling` inside `RPCOptions`).
  const typesByName = new Map<string, ApiType>();
  for (const t of apiData.types ?? []) typesByName.set(t.name, t);

  const expanded = new Set<string>(multiReferenced);
  const stack = Array.from(multiReferenced);
  while (stack.length > 0) {
    const current = stack.pop()!;
    const type = typesByName.get(current);
    if (!type) continue;
    const builtin = new Set([
      "Array", "Promise", "Record", "Partial", "Readonly", "Required",
      "Pick", "Omit", "Map", "Set", "Date", "RegExp", "Error",
    ]);
    const re = /\b([A-Z][A-Za-z0-9_]+)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(type.definition)) !== null) {
      const n = m[1];
      if (!builtin.has(n) && !expanded.has(n)) {
        expanded.add(n);
        stack.push(n);
      }
    }
  }

  return expanded;
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

  // Precompute the set of types that will live on `shared-types.mdx`.
  // Function pages use this to decide between emitting a `### TypeName`
  // subsection (local, for single-use types) vs. a cross-page link
  // (`../shared-types#name` — for truly shared types) in the Returns
  // section. Keeps the sample pattern where `RegistryItem` is defined once
  // and linked from every consumer.
  const sharedTypeNames = new Set<string>();
  if (apiData.types && apiData.types.length > 0) {
    const referenced = collectReferencedTypes(apiData);
    for (const t of apiData.types) {
      if (referenced.has(t.name)) sharedTypeNames.add(t.name);
    }
  }

  const env = createEnv();
  env.addGlobal("sharedTypeNames", Array.from(sharedTypeNames));
  await fs.mkdir(outputDir, { recursive: true });

  await Promise.all(
    apiData.functions.map(async (fn) => {
      sanitizeFunctionData(fn);
      rewriteSharedTypeAnchors(fn, sharedTypeNames);
      const mdx = env.render("function-page.njk", { fn }).trim();
      if (!mdx.startsWith("---")) {
        throw new Error(
          `Generated invalid MDX for ${fn.name} (missing frontmatter)`,
        );
      }
      await fs.writeFile(
        path.join(outputDir, `${fn.name}.mdx`),
        mdx + "\n",
        "utf-8",
      );
    }),
  );
  console.log(`\u2713 Generated ${apiData.functions.length} function MDX files`);

  if (apiData.objects && apiData.objects.length > 0) {
    await Promise.all(
      apiData.objects.map(async (obj) => {
        if (obj.methods) {
          for (const m of obj.methods) sanitizeFunctionData(m);
        }
        const mdx = env.render("object-page.njk", { obj }).trim();
        await fs.writeFile(
          path.join(outputDir, `${obj.name}.mdx`),
          mdx + "\n",
          "utf-8",
        );
      }),
    );
    console.log(`\u2713 Generated ${apiData.objects.length} object MDX files`);
  }

  if (apiData.types && apiData.types.length > 0) {
    // Filter the exhaustive type dump to only types actually referenced by
    // generated function/object pages. Prevents the shared-types page from
    // becoming a 1000+ line kitchen sink when the SDK exports dozens of
    // internal types that no public API surface references. `sharedTypeNames`
    // was precomputed above for the function-page short-circuit.
    const filteredTypes = apiData.types.filter((t) => sharedTypeNames.has(t.name));
    const typesToRender = filteredTypes.length > 0 ? filteredTypes : apiData.types;

    const typesMdx = env
      .render("shared-types.njk", {
        types: typesToRender,
        versionLabel: options.versionLabel,
      })
      .trim();
    await fs.writeFile(
      path.join(outputDir, "shared-types.mdx"),
      typesMdx + "\n",
      "utf-8",
    );
    // Remove any stale `types.mdx` left over from an earlier pipeline version
    // that used that filename.
    await fs
      .rm(path.join(outputDir, "types.mdx"), { force: true })
      .catch(() => {});
    console.log(
      `\u2713 Generated shared-types.mdx (${typesToRender.length} type definitions; ${apiData.types.length - typesToRender.length} unreferenced types filtered)`,
    );
  }

  if (apiData.constants && apiData.constants.length > 0) {
    const constantsMdx = env
      .render("constants-page.njk", {
        constants: apiData.constants,
      })
      .trim();
    await fs.writeFile(
      path.join(outputDir, "constants.mdx"),
      constantsMdx + "\n",
      "utf-8",
    );
    console.log(
      `\u2713 Generated constants.mdx (${apiData.constants.length} value constants)`,
    );
  }

  const indexMdx = env
    .render("index-page.njk", {
      functions: apiData.functions,
      objects: apiData.objects ?? [],
      constants: apiData.constants ?? [],
      versionLabel: options.versionLabel,
    })
    .trim();
  await fs.writeFile(
    path.join(outputDir, "index.mdx"),
    indexMdx + "\n",
    "utf-8",
  );
  console.log("\u2713 Generated index.mdx");

  if (apiData.errors.client.length > 0 || apiData.errors.server.length > 0) {
    const sampleOverrides = options.samplesDir
      ? await readErrorOverrides(options.samplesDir)
      : undefined;
    annotateErrorsWithThrowers(apiData, sampleOverrides);
    const errorsMdx = env
      .render("errors-page.njk", { errors: apiData.errors })
      .trim();
    await fs.writeFile(
      path.join(outputDir, "errors.mdx"),
      errorsMdx + "\n",
      "utf-8",
    );
    console.log(
      `\u2713 Generated errors.mdx (${apiData.errors.client.length} client + ${apiData.errors.server.length} server errors)`,
    );
  } else {
    console.log("\u26a0\ufe0f  No error codes found, skipping errors.mdx");
  }
}
