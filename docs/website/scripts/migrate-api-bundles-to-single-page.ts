#!/usr/bin/env bun
/**
 * One-time migration: convert per-function MDX bundles into single-file API
 * summaries that match the new single-page format.
 *
 * Source layouts (read in priority order — first hit wins per version):
 *   - content/docs/(latest)/sdk/api/        (current latest source-of-truth)
 *   - content/docs/v0.9.0/sdk/api/          (frozen previous bundles)
 *   - content/docs/v0.8.0/sdk/api/
 *   - content/docs/v0.7.0/sdk/api/
 *
 * Target layout (single MDX per version):
 *   - content/docs/sdk/api/index.mdx        (latest)
 *   - content/docs/sdk/api/v<X.Y.Z>.mdx     (older)
 *
 * In addition, all non-API content under `content/docs/(latest)/` is moved
 * verbatim to bare-path locations (e.g. `content/docs/(latest)/about-qvac/`
 * → `content/docs/about-qvac/`). The `(latest)/` parens convention and the
 * frozen versioned bundle folders are deleted entirely.
 *
 * The migration is intentionally lossy: per-function parameter tables,
 * return-field tables, expanded type subsections, shared-types pages, and
 * constants pages are dropped. Those details live in the SDK's `.d.ts` for
 * IDE/agent consumption.
 *
 * Usage:
 *   bun run scripts/migrate-api-bundles-to-single-page.ts
 *   bun run scripts/migrate-api-bundles-to-single-page.ts --dry-run
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_WEBSITE_DIR = path.resolve(SCRIPT_DIR, "..");
const CONTENT_DIR = path.join(DOCS_WEBSITE_DIR, "content", "docs");

interface FunctionEntry {
  name: string;
  description: string;
  signature: string;
  throws: Array<{ error: string; description: string }>;
  examples: string[];
  deprecated?: string;
}

interface ObjectEntry {
  name: string;
  description: string;
  shape: string;
  methods: Array<{ name: string; description: string }>;
  example?: string;
}

interface ErrorEntry {
  name: string;
  code: number;
  summary: string;
}

interface VersionBundle {
  /** Display label that appears in the page heading. */
  label: string;
  /** Source folder under `content/docs/`. */
  sourceFolder: string;
  /** Output filename under `content/docs/sdk/api/`. */
  outputFile: string;
}

const VERSION_BUNDLES: VersionBundle[] = [
  {
    label: "v0.9.1",
    sourceFolder: "(latest)",
    outputFile: "index.mdx",
  },
  {
    label: "v0.8.0",
    sourceFolder: "v0.8.0",
    outputFile: "v0.8.0.mdx",
  },
  {
    label: "v0.7.0",
    sourceFolder: "v0.7.0",
    outputFile: "v0.7.0.mdx",
  },
];

// ---------------------------------------------------------------------------
// Frontmatter / section parsing helpers (lightweight; no heavy MDX parser)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;

function parseFrontmatter(source: string): { fm: Record<string, string>; body: string } {
  const m = source.match(FRONTMATTER_RE);
  if (!m) return { fm: {}, body: source };
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fm[kv[1]] = value;
  }
  return { fm, body: source.slice(m[0].length) };
}

/** Return the body of an `## Heading` section, or null if missing. */
function getSection(body: string, heading: RegExp | string): string | null {
  const escaped =
    typeof heading === "string"
      ? heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : heading.source;
  const re = new RegExp(`^##\\s+(${escaped})\\s*$([\\s\\S]*?)(?=^##\\s+|\\z)`, "m");
  const m = body.match(re);
  return m ? m[2].trim() : null;
}

/** Extract every code block (any language) in priority order. */
function extractCodeBlocks(body: string, lang?: RegExp): string[] {
  const re = /^```(\w+)?\s*\n([\s\S]*?)^```\s*$/gm;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (lang && !lang.test(m[1] ?? "")) continue;
    blocks.push(m[2].replace(/\s+$/, ""));
  }
  return blocks;
}

/**
 * The leading `ts` code block of a function MDX is the signature. We extract
 * the body between the frontmatter and the first `## Heading` so that nested
 * code blocks under e.g. `## Throws` aren't mis-identified.
 */
function getLeadingCodeBlock(body: string, lang: RegExp): string | null {
  const headingIdx = body.search(/^##\s+/m);
  const lead = headingIdx === -1 ? body : body.slice(0, headingIdx);
  const blocks = extractCodeBlocks(lead, lang);
  return blocks.length > 0 ? blocks[0] : null;
}

/** Parse `<Callout type="warn" title="Deprecated">…</Callout>` if present. */
function parseDeprecated(body: string): string | undefined {
  const m = body.match(
    /<Callout\s+type="warn"\s+title="Deprecated">\s*([\s\S]*?)\s*<\/Callout>/i,
  );
  return m ? m[1].trim() : undefined;
}

/**
 * Strip nested `### TypeName` / `#### TypeName` sub-section bodies that the
 * legacy template generated under `## Throws`. The new format only keeps the
 * top-level rows.
 */
function trimNestedHeadings(text: string): string {
  const idx = text.search(/^###?\s+/m);
  return idx === -1 ? text : text.slice(0, idx).trim();
}

/** Parse the `## Throws` table into structured rows. */
function parseThrowsTable(body: string): Array<{ error: string; description: string }> {
  const section = getSection(body, "Throws");
  if (!section) return [];
  const trimmed = trimNestedHeadings(section);
  const rows: Array<{ error: string; description: string }> = [];
  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("|")) continue;
    if (/^\|\s*-+/.test(line)) continue;
    if (/^\|\s*Error\s*\|/i.test(line)) continue;
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length < 2) continue;
    const error = cells[0].replace(/^`|`$/g, "").trim();
    const desc = cells[1] === "—" ? "" : cells[1];
    if (error) rows.push({ error, description: desc });
  }
  return rows;
}

/** Extract every code block in `## Example` / `## Examples`. */
function parseExamples(body: string): string[] {
  const section = getSection(body, /Examples?/) ?? "";
  return extractCodeBlocks(section, /^(typescript|ts|js|javascript)?$/);
}

// ---------------------------------------------------------------------------
// Per-MDX → entry conversion
// ---------------------------------------------------------------------------

/** Function pages we want to drop (out of scope for the new summary). */
const EXCLUDED_FUNCTION_NAMES = new Set([
  "close",
  "defineDuplexHandler",
  "defineHandler",
  "definePlugin",
  "getLogger",
  "getModelByName",
  "getModelByPath",
  "getModelBySrc",
]);

function parseFunctionMdx(filename: string, source: string): FunctionEntry | null {
  const { fm, body } = parseFrontmatter(source);

  // Title in legacy MDX is `<name>( )`. Extract the name from the filename
  // since it's authoritative and matches the export.
  const name = path.basename(filename, ".mdx");
  if (EXCLUDED_FUNCTION_NAMES.has(name)) return null;

  const description = (fm.description ?? "").trim();
  const signature = (getLeadingCodeBlock(body, /^(ts|typescript)$/) ?? "").trim();
  if (!signature) {
    console.warn(`  ⚠️  ${filename}: no signature code block found; skipping`);
    return null;
  }
  const throws = parseThrowsTable(body);
  const examples = parseExamples(body);
  const deprecated = parseDeprecated(body);

  return {
    name,
    description,
    signature,
    throws,
    examples,
    deprecated,
  };
}

function parseProfilerMdx(source: string): ObjectEntry | null {
  const { fm, body } = parseFrontmatter(source);
  const description = (fm.description ?? "").trim();
  const shape = (getLeadingCodeBlock(body, /^(ts|typescript)$/) ?? "").trim();
  if (!shape) return null;

  // The legacy profiler page has a `## Methods` table — parse name + summary.
  const methodsSection = getSection(body, "Methods");
  const methods: Array<{ name: string; description: string }> = [];
  if (methodsSection) {
    const trimmed = trimNestedHeadings(methodsSection);
    for (const line of trimmed.split("\n")) {
      if (!line.startsWith("|")) continue;
      if (/^\|\s*-+/.test(line)) continue;
      if (/^\|\s*Method\s*\|/i.test(line)) continue;
      const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
      if (cells.length < 2) continue;
      // Method cell typically reads `[\`name()\`](#name)` or `\`name()\``.
      const link = cells[0].match(/`([^`]+)`/);
      const name = (link ? link[1] : cells[0]).replace(/\(\)$/, "");
      methods.push({ name: `${name}()`, description: cells[1] });
    }
  }

  const examples = parseExamples(body);
  return {
    name: "profiler",
    description,
    shape,
    methods,
    example: examples[0],
  };
}

function parseErrorsMdx(source: string): { client: ErrorEntry[]; server: ErrorEntry[] } {
  const { body } = parseFrontmatter(source);
  return {
    client: parseErrorsTable(getSection(body, /Client\s+errors/) ?? ""),
    server: parseErrorsTable(getSection(body, /Server\s+errors/) ?? ""),
  };
}

function parseErrorsTable(section: string): ErrorEntry[] {
  const rows: ErrorEntry[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    if (/^\|\s*-+/.test(line)) continue;
    if (/^\|\s*Error\s*\|/i.test(line)) continue;
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length < 3) continue;
    const name = cells[0].replace(/^`|`$/g, "").trim();
    const code = parseInt(cells[1], 10);
    if (!name || Number.isNaN(code)) continue;
    rows.push({ name, code, summary: cells[2] });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Bundle directory → single-page MDX
// ---------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readBundleDir(dir: string): Promise<{
  functions: FunctionEntry[];
  objects: ObjectEntry[];
  errors: { client: ErrorEntry[]; server: ErrorEntry[] };
} | null> {
  if (!(await fileExists(dir))) return null;

  const entries = await fs.readdir(dir);
  const functions: FunctionEntry[] = [];
  const objects: ObjectEntry[] = [];
  let errors: { client: ErrorEntry[]; server: ErrorEntry[] } = { client: [], server: [] };

  for (const entry of entries) {
    if (!entry.endsWith(".mdx")) continue;
    if (entry === "index.mdx" || entry === "shared-types.mdx" || entry === "constants.mdx") {
      continue;
    }
    const full = path.join(dir, entry);
    const content = await fs.readFile(full, "utf-8");

    if (entry === "errors.mdx") {
      errors = parseErrorsMdx(content);
      continue;
    }
    if (entry === "profiler.mdx") {
      const obj = parseProfilerMdx(content);
      if (obj) objects.push(obj);
      continue;
    }
    const fn = parseFunctionMdx(entry, content);
    if (fn) functions.push(fn);
  }

  functions.sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );
  return { functions, objects, errors };
}

function buildScopeSummary(
  functions: FunctionEntry[],
  objects: ObjectEntry[],
): string {
  const objectClause =
    objects.length === 0
      ? ""
      : objects.length === 1
        ? ` plus the \`${objects[0].name}\` object`
        : ` plus ${objects.length} objects`;
  return `${functions.length} functions in \`packages/sdk/client/api/\`${objectClause}`;
}

function escapeTableCell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderSinglePage(
  label: string,
  bundle: { functions: FunctionEntry[]; objects: ObjectEntry[]; errors: { client: ErrorEntry[]; server: ErrorEntry[] } },
): string {
  const lines: string[] = [];
  lines.push(`---`);
  lines.push(`title: API Summary — ${label}`);
  lines.push(
    `description: One-page reference of all public functions and objects exported by @qvac/sdk`,
  );
  lines.push(`---`);
  lines.push(``);
  lines.push(`> Auto-generated from \`.d.ts\` declarations and TSDoc comments.`);
  lines.push(`>`);
  lines.push(`> For per-parameter and per-field details, hover symbols in your IDE or open`);
  lines.push(`> \`node_modules/@qvac/sdk/dist\`. This page is intentionally a high-level index.`);
  lines.push(`>`);
  lines.push(`> **Fields shown**: description, signature, throws, examples, deprecation.`);
  lines.push(`> **Fields intentionally omitted**: parameter descriptions, return field descriptions`);
  lines.push(`> (covered by IDE hover and \`.d.ts\` declarations).`);
  lines.push(`>`);
  lines.push(`> **Scope**: ${buildScopeSummary(bundle.functions, bundle.objects)}.`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`## Functions`);
  lines.push(``);

  for (const fn of bundle.functions) {
    lines.push(`### \`${fn.name}\``);
    lines.push(``);
    if (fn.deprecated) {
      lines.push(`> ⚠️ **Deprecated**: ${fn.deprecated}`);
      lines.push(``);
    }
    if (fn.description) {
      lines.push(fn.description);
      lines.push(``);
    }
    lines.push(`**Signature**:`);
    lines.push(``);
    lines.push("```ts");
    lines.push(fn.signature);
    lines.push("```");
    lines.push(``);
    if (fn.throws.length > 0) {
      lines.push(`**Throws**:`);
      lines.push(``);
      for (const t of fn.throws) {
        lines.push(`- \`${t.error}\` — ${t.description || "—"}`);
      }
      lines.push(``);
    }
    if (fn.examples.length > 0) {
      lines.push(fn.examples.length > 1 ? `**Examples**:` : `**Example**:`);
      lines.push(``);
      for (const ex of fn.examples) {
        lines.push("```ts");
        lines.push(ex);
        lines.push("```");
        lines.push(``);
      }
    }
    lines.push(`---`);
    lines.push(``);
  }

  if (bundle.objects.length > 0) {
    lines.push(`## Objects`);
    lines.push(``);
    for (const obj of bundle.objects) {
      lines.push(`### \`${obj.name}\``);
      lines.push(``);
      if (obj.description) {
        lines.push(obj.description);
        lines.push(``);
      }
      if (obj.shape) {
        lines.push(`**Shape**:`);
        lines.push(``);
        lines.push("```ts");
        lines.push(obj.shape);
        lines.push("```");
        lines.push(``);
      }
      if (obj.methods.length > 0) {
        lines.push(`**Methods**:`);
        lines.push(``);
        for (const m of obj.methods) {
          lines.push(`- **\`${m.name}\`** — ${m.description}`);
        }
        lines.push(``);
      }
      if (obj.example) {
        lines.push(`**Example**:`);
        lines.push(``);
        lines.push("```ts");
        lines.push(obj.example);
        lines.push("```");
        lines.push(``);
      }
      lines.push(`---`);
      lines.push(``);
    }
  }

  lines.push(`## Errors`);
  lines.push(``);
  lines.push(`Public error codes thrown across the SDK. Catch via \`instanceof QvacErrorBase\``);
  lines.push(`and read \`error.code\` / \`error.cause\`. Code ranges:`);
  lines.push(`50,001–52,000 (client) and 52,001–54,000 (server).`);
  lines.push(``);

  if (bundle.errors.client.length > 0) {
    lines.push(`### Client errors`);
    lines.push(``);
    lines.push(`| Error | Code | Summary |`);
    lines.push(`| --- | --- | --- |`);
    for (const e of bundle.errors.client) {
      lines.push(`| \`${e.name}\` | ${e.code} | ${escapeTableCell(e.summary || "—")} |`);
    }
    lines.push(``);
  }
  if (bundle.errors.server.length > 0) {
    lines.push(`### Server errors`);
    lines.push(``);
    lines.push(`| Error | Code | Summary |`);
    lines.push(`| --- | --- | --- |`);
    for (const e of bundle.errors.server) {
      lines.push(`| \`${e.name}\` | ${e.code} | ${escapeTableCell(e.summary || "—")} |`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Non-API content move: (latest)/<x>/... -> <x>/...
// ---------------------------------------------------------------------------

async function moveLatestNonApiContent(dryRun: boolean): Promise<void> {
  const latestDir = path.join(CONTENT_DIR, "(latest)");
  if (!(await fileExists(latestDir))) {
    console.log("  ⏭️  No (latest)/ folder to move");
    return;
  }

  const entries = await fs.readdir(latestDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(latestDir, entry.name);
    const targetPath = path.join(CONTENT_DIR, entry.name);

    if (entry.name === "sdk") {
      // sdk/ subtree is special: api/ is being replaced (skip it), but
      // examples/, getting-started/, tutorials/ move verbatim.
      const sdkSrc = path.join(latestDir, "sdk");
      const sdkTgt = path.join(CONTENT_DIR, "sdk");
      const sdkChildren = await fs.readdir(sdkSrc, { withFileTypes: true });
      for (const child of sdkChildren) {
        if (child.name === "api") continue; // handled separately by API generation
        const srcChild = path.join(sdkSrc, child.name);
        const tgtChild = path.join(sdkTgt, child.name);
        console.log(
          `  ${dryRun ? "[dry-run] " : ""}move ${path.relative(CONTENT_DIR, srcChild)} → ${path.relative(CONTENT_DIR, tgtChild)}`,
        );
        if (!dryRun) {
          await fs.mkdir(path.dirname(tgtChild), { recursive: true });
          await fs.rm(tgtChild, { recursive: true, force: true });
          await fs.rename(srcChild, tgtChild);
        }
      }
      continue;
    }

    console.log(
      `  ${dryRun ? "[dry-run] " : ""}move ${path.relative(CONTENT_DIR, sourcePath)} → ${path.relative(CONTENT_DIR, targetPath)}`,
    );
    if (!dryRun) {
      await fs.rm(targetPath, { recursive: true, force: true });
      await fs.rename(sourcePath, targetPath);
    }
  }
}

async function deleteLegacyFolders(dryRun: boolean): Promise<void> {
  const targets = [
    path.join(CONTENT_DIR, "(latest)"),
    path.join(CONTENT_DIR, "v0.7.0"),
    path.join(CONTENT_DIR, "v0.8.0"),
    path.join(CONTENT_DIR, "v0.9.0"),
    path.join(CONTENT_DIR, "dev"),
    path.join(CONTENT_DIR, ".latest-api-backup"),
  ];
  for (const t of targets) {
    if (!(await fileExists(t))) continue;
    console.log(
      `  ${dryRun ? "[dry-run] " : ""}delete ${path.relative(CONTENT_DIR, t)}`,
    );
    if (!dryRun) {
      await fs.rm(t, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  console.log(`📦 Migrating per-function MDX bundles to single-page format`);
  console.log(`   Content root: ${CONTENT_DIR}`);
  console.log(`   Mode: ${dryRun ? "DRY RUN (no writes)" : "WRITE"}`);
  console.log("");

  console.log(`🔄 Generating versioned API summaries...`);
  for (const bundle of VERSION_BUNDLES) {
    const sourceDir = path.join(CONTENT_DIR, bundle.sourceFolder, "sdk", "api");
    const result = await readBundleDir(sourceDir);
    if (!result) {
      console.log(`  ⏭️  ${bundle.sourceFolder} — source not found, skipping`);
      continue;
    }
    const mdx = renderSinglePage(bundle.label, result);
    const outputPath = path.join(CONTENT_DIR, "sdk", "api", bundle.outputFile);
    console.log(
      `  ${dryRun ? "[dry-run] " : ""}write ${path.relative(CONTENT_DIR, outputPath)} ` +
        `(${result.functions.length} functions, ${result.objects.length} objects, ` +
        `${result.errors.client.length + result.errors.server.length} errors)`,
    );
    if (!dryRun) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, mdx, "utf-8");
    }
  }

  console.log("");
  console.log(`🔄 Moving non-API (latest)/ content to bare paths...`);
  await moveLatestNonApiContent(dryRun);

  console.log("");
  console.log(`🧹 Deleting legacy folders...`);
  await deleteLegacyFolders(dryRun);

  console.log("");
  console.log(`✅ Migration complete${dryRun ? " (dry run)" : ""}.`);
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
