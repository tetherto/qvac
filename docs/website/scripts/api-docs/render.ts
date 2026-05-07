/**
 * Rendering phase: reads extracted api-data.json and produces a single
 * API-summary MDX file (functions + objects + folded errors).
 *
 * The output target is one of:
 *   - `content/docs/sdk/api/index.mdx`  (latest version)
 *   - `content/docs/sdk/api/v<X.Y.Z>.mdx`  (frozen older version)
 *
 * Page assembly uses a single Nunjucks template at
 * `scripts/api-docs/templates/single-page.njk`.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "node:url";
import nunjucks from "nunjucks";
import type { ApiData, ApiFunction } from "./types.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(SCRIPT_DIR, "templates");

export interface RenderOptions {
  /** Display label shown in the page heading (e.g. "v0.9.1" or "v0.9.1 (latest)"). */
  versionLabel: string;
  /**
   * Absolute path of the file to write (parent directory will be created
   * automatically). Examples:
   *   - .../content/docs/sdk/api/index.mdx
   *   - .../content/docs/sdk/api/v0.8.0.mdx
   */
  outputFile: string;
}

// ---------------------------------------------------------------------------
// Nunjucks environment
// ---------------------------------------------------------------------------

function createEnv(): nunjucks.Environment {
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader(TEMPLATE_DIR),
    { autoescape: false, trimBlocks: true, lstripBlocks: true },
  );

  env.addFilter("escapeTableLight", escapeTableLight);
  env.addFilter("firstSentence", firstSentence);
  env.addFilter("stripFence", stripFence);

  return env;
}

// ---------------------------------------------------------------------------
// Filters — used by single-page.njk
// ---------------------------------------------------------------------------

/**
 * Collapse newlines and runs of whitespace into single spaces, so multi-line
 * JSDoc descriptions render as a single logical line in GFM pipe tables.
 */
function collapseWhitespace(str: string): string {
  return str.replace(/\s+/g, " ").trim();
}

/**
 * Escape backslashes, braces, and pipes for type strings and descriptions
 * inside the errors / methods table cells. Also collapses newlines so
 * multi-line prose fits in a single table cell without breaking the row.
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

/** Strip surrounding code fences from an example string. */
export function stripFence(str: string): string {
  return str.replace(/^```\w*\n?/, "").replace(/\n?```\s*$/, "");
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
  options: RenderOptions,
): Promise<void> {
  const raw = await fs.readFile(dataPath, "utf-8");
  const apiData: ApiData = JSON.parse(raw);

  const env = createEnv();
  await fs.mkdir(path.dirname(options.outputFile), { recursive: true });

  for (const fn of apiData.functions) sanitizeFunctionData(fn);
  if (apiData.objects) {
    for (const obj of apiData.objects) {
      if (obj.methods) {
        for (const m of obj.methods) sanitizeFunctionData(m);
      }
    }
  }

  // Build the "Scope" callout line: `<N> functions in
  // packages/sdk/client/api/ plus the <object> object`.
  const objectCount = apiData.objects?.length ?? 0;
  const objectClause =
    objectCount === 0
      ? ""
      : objectCount === 1
        ? ` plus the \`${apiData.objects![0].name}\` object`
        : ` plus ${objectCount} objects`;
  const scopeSummary = `${apiData.functions.length} functions in \`packages/sdk/client/api/\`${objectClause}`;

  const mdx = env
    .render("single-page.njk", {
      functions: apiData.functions,
      objects: apiData.objects ?? [],
      errors: apiData.errors,
      versionLabel: options.versionLabel,
      scopeSummary,
    })
    .trim();

  if (!mdx.startsWith("---")) {
    throw new Error(
      `Generated invalid MDX (missing frontmatter) for ${options.outputFile}`,
    );
  }

  await fs.writeFile(options.outputFile, mdx + "\n", "utf-8");
  console.log(
    `\u2713 Generated ${path.basename(options.outputFile)} ` +
      `(${apiData.functions.length} functions, ${objectCount} objects, ` +
      `${apiData.errors.client.length + apiData.errors.server.length} errors)`,
  );
}
