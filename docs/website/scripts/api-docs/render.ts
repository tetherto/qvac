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
  env.addFilter("lower", (s: string) => s.toLowerCase());
  env.addFilter("replace", (s: string, from: string, to: string) =>
    s.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), to),
  );

  env.addGlobal("renderExpandedTypes", renderExpandedTypes);
  env.addGlobal("renderErrorTable", renderErrorTable);
  env.addGlobal("renderParamRow", renderParamRow);

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
          return `| \`${f.name}\` | \`${typeStr}\` | ${req} | ${def} | ${desc} |`;
        }
        return `| \`${f.name}\` | \`${typeStr}\` | ${req} | ${desc} |`;
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
    return `| \`${p.name}\` | ${typeCell} | ${req} | ${def} | ${desc} |`;
  }
  return `| \`${p.name}\` | ${typeCell} | ${req} | ${desc} |`;
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
      sanitizeFunctionData(fn);
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
    const typesMdx = env
      .render("shared-types.njk", {
        types: apiData.types,
        versionLabel: options.versionLabel,
      })
      .trim();
    await fs.writeFile(
      path.join(outputDir, "types.mdx"),
      typesMdx + "\n",
      "utf-8",
    );
    console.log(
      `\u2713 Generated types.mdx (${apiData.types.length} type definitions)`,
    );
  }

  const indexMdx = env
    .render("index-page.njk", {
      functions: apiData.functions,
      objects: apiData.objects ?? [],
      versionLabel: options.versionLabel,
    })
    .trim();
  await fs.writeFile(path.join(outputDir, "index.mdx"), indexMdx + "\n", "utf-8");
  console.log("\u2713 Generated index.mdx");

  if (apiData.errors.client.length > 0 || apiData.errors.server.length > 0) {
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
