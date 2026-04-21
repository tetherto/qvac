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
import { copySampleIfExists, type PassthroughSummary } from "./sample-passthrough.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(SCRIPT_DIR, "templates");

export interface RenderOptions {
  versionLabel: string;
  /**
   * Directory containing hand-authored MDX samples. For each output file,
   * if a matching sample exists, it is copied verbatim to the output
   * directory instead of being rendered from scratch. When omitted, every
   * file is rendered via the Nunjucks templates.
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
    ["```typescript", fn.signature.replace(/^function\s+/, "function "), "```"].join("\n"),
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
    returnsBlock.push(`\`${returnType}\` — ${returnDesc}`);
  } else {
    returnsBlock.push(`\`${returnType}\``);
  }
  if (fn.returnFields.length > 0) {
    returnsBlock.push("");
    returnsBlock.push("| Field | Type | Description |");
    returnsBlock.push("| --- | --- | --- |");
    for (const f of fn.returnFields) {
      returnsBlock.push(
        `| \`${f.name}\` | \`${escapeTableLight(f.type)}\` | ${escapeTableLight(f.description || "\u2014")} |`,
      );
    }
  }
  blocks.push(returnsBlock.join("\n"));

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
): Promise<PassthroughSummary> {
  const raw = await fs.readFile(dataPath, "utf-8");
  const apiData: ApiData = JSON.parse(raw);

  const env = createEnv();
  await fs.mkdir(outputDir, { recursive: true });

  const samplesDir = options.samplesDir;
  const summary: PassthroughSummary = { copied: [], generated: [] };

  /**
   * Write a single output MDX file. If a matching sample exists under
   * `samplesDir`, copy it verbatim. Otherwise call `renderFn()` to produce
   * the content and write it.
   *
   * `sampleName` is the filename (without `.mdx`) to look for in
   * `samplesDir`; `outputName` is the filename (without `.mdx`) to write in
   * `outputDir`. They default to the same value but may differ (e.g., the
   * pipeline's internal `types` maps to the sample's `shared-types`).
   */
  async function writeSampleOrRender(
    sampleName: string,
    outputName: string,
    renderFn: () => Promise<string> | string,
  ): Promise<void> {
    if (samplesDir) {
      const copied = await copySampleIfExists(
        samplesDir,
        outputDir,
        sampleName,
        outputName,
      );
      if (copied) {
        summary.copied.push(outputName);
        return;
      }
    }
    const content = await renderFn();
    await fs.writeFile(
      path.join(outputDir, `${outputName}.mdx`),
      content,
      "utf-8",
    );
    summary.generated.push(outputName);
  }

  await Promise.all(
    apiData.functions.map((fn) =>
      writeSampleOrRender(fn.name, fn.name, () => {
        sanitizeFunctionData(fn);
        const mdx = env.render("function-page.njk", { fn }).trim();
        if (!mdx.startsWith("---")) {
          throw new Error(
            `Generated invalid MDX for ${fn.name} (missing frontmatter)`,
          );
        }
        return mdx + "\n";
      }),
    ),
  );

  if (apiData.objects && apiData.objects.length > 0) {
    await Promise.all(
      apiData.objects.map((obj) =>
        writeSampleOrRender(obj.name, obj.name, () => {
          if (obj.methods) {
            for (const m of obj.methods) sanitizeFunctionData(m);
          }
          const mdx = env.render("object-page.njk", { obj }).trim();
          return mdx + "\n";
        }),
      ),
    );
  }

  if (apiData.types && apiData.types.length > 0) {
    // Sample uses `shared-types.mdx`; pipeline's internal name is `types`.
    // Prefer the `shared-types` sample if it exists; otherwise fall back to
    // generating `types.mdx` so the sidebar/link target stays valid.
    const sampleExists =
      samplesDir !== undefined &&
      (await copySampleIfExists(samplesDir, outputDir, "shared-types", "shared-types"));
    if (sampleExists) {
      summary.copied.push("shared-types");
      // Remove any stale `types.mdx` from a previous run without a sample,
      // so the sample's file naming is the only one present.
      await fs
        .rm(path.join(outputDir, "types.mdx"), { force: true })
        .catch(() => {});
    } else {
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
      summary.generated.push("types");
    }
  }

  await writeSampleOrRender("index", "index", () => {
    const mdx = env
      .render("index-page.njk", {
        functions: apiData.functions,
        objects: apiData.objects ?? [],
        versionLabel: options.versionLabel,
      })
      .trim();
    return mdx + "\n";
  });

  if (apiData.errors.client.length > 0 || apiData.errors.server.length > 0) {
    await writeSampleOrRender("errors", "errors", () => {
      const mdx = env
        .render("errors-page.njk", { errors: apiData.errors })
        .trim();
      return mdx + "\n";
    });
  } else {
    console.log("\u26a0\ufe0f  No error codes found, skipping errors.mdx");
  }

  const total = summary.copied.length + summary.generated.length;
  if (samplesDir) {
    console.log(
      `\u2713 Copied ${summary.copied.length} sample(s) from ${samplesDir}`,
    );
    if (summary.generated.length > 0) {
      console.log(
        `\u2713 Generated ${summary.generated.length} page(s) without a sample: ${summary.generated.join(", ")}`,
      );
    }
  } else {
    console.log(`\u2713 Generated ${total} MDX files`);
  }

  return summary;
}
