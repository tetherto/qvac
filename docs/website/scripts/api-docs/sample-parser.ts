/**
 * Sample prose parser.
 *
 * Reads hand-authored MDX samples from a caller-supplied directory and
 * extracts prose fields (function description, parameter descriptions,
 * expanded-type field descriptions, example code, throws entries).
 *
 * The extract phase uses this as a *fallback* source: SDK JSDoc always wins
 * when present, sample prose fills the gaps. The pipeline still renders
 * everything through the Nunjucks templates; samples are an input, not a
 * copy target.
 */

import * as fs from "fs/promises";
import * as path from "path";

export interface SampleThrowsEntry {
  error: string;
  description: string;
}

export interface SampleExpandedType {
  /** Type/section name, e.g., `HistoryMessage`, `RegistryItem`, or a dotted
   * parameter name like `params`. Matches the `###`/`####` heading in the MDX. */
  typeName: string;
  /** Maps field name -> description as written in the sample. */
  fields: Map<string, string>;
}

export interface SampleFunctionProse {
  /** Frontmatter `description:` value (stripped of surrounding quotes). */
  description: string;
  /** Maps top-level parameter name -> description from the Parameters table. */
  parameters: Map<string, string>;
  /** Expanded type subsections beneath the Parameters / Returns sections. */
  expanded: SampleExpandedType[];
  /** Example code blocks from the `## Example` / `## Examples` section. */
  examples: string[];
  /** Throws table rows (`## Throws` section). */
  throws: SampleThrowsEntry[];
  /** Parsed return-fields table when the sample has one below `## Returns`. */
  returnFields: Map<string, string>;
  /** Narrative prose directly under `## Returns`, before the field table. */
  returnsDescription: string;
  /** Narrative prose directly under the top-level frontmatter, before sections. */
  leadParagraph: string;
  /**
   * For object samples: summary strings from the `## Methods` table, keyed by
   * method name (e.g., `enable` → "Enables profiling and resets aggregated data").
   */
  methodSummaries: Map<string, string>;
  /**
   * For object samples: structured prose for each `### \`methodName()\``
   * subsection. Each entry has its own description / parameters / expanded
   * types / returns. Keyed by method name.
   */
  methods: Map<string, SampleFunctionProse>;
}

/**
 * Parse a single sample MDX file into structured prose. Returns `null` when
 * the file does not exist (so the caller can skip).
 */
export async function readSampleProse(
  samplesDir: string,
  name: string,
): Promise<SampleFunctionProse | null> {
  const samplePath = path.join(samplesDir, `${name}.mdx`);
  let raw: string;
  try {
    raw = await fs.readFile(samplePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parseSampleProse(raw);
}

/**
 * Parse `index.mdx` to extract per-function and per-object summaries from the
 * Functions / Object tables. The hand-written index contains curated summary
 * text that is often different (more concise) from the function page's own
 * description. Returns maps keyed by the linked target name.
 */
export async function readIndexSummaries(
  samplesDir: string,
): Promise<{ functions: Map<string, string>; objects: Map<string, string> }> {
  const functions = new Map<string, string>();
  const objects = new Map<string, string>();
  let raw: string;
  try {
    raw = await fs.readFile(path.join(samplesDir, "index.mdx"), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { functions, objects };
    }
    throw err;
  }
  const { body } = splitFrontmatter(raw);
  const sections = splitSections(body);
  const fnsSection = sections.find((s) => s.heading === "Functions");
  if (fnsSection) {
    for (const row of extractTableRows(fnsSection.content)) {
      if (row.length < 2) continue;
      const nameCell = stripCell(row[0]);
      const summary = stripCell(row[1]);
      // Match e.g. "[`close()`](./close)" → "close"
      const m = nameCell.match(/\[`(\w+)\(\)`\]/);
      if (m && summary) functions.set(m[1], summary);
    }
  }
  const objsSection = sections.find((s) => s.heading === "Object" || s.heading === "Objects");
  if (objsSection) {
    for (const row of extractTableRows(objsSection.content)) {
      if (row.length < 2) continue;
      const nameCell = stripCell(row[0]);
      const summary = stripCell(row[1]);
      const m = nameCell.match(/\[`(\w+)`\]/);
      if (m && summary) objects.set(m[1], summary);
    }
  }
  return { functions, objects };
}

/**
 * Pure-function parser (exported for testing). Walks an MDX source string and
 * returns structured prose. Tolerant of minor formatting variations found in
 * the hand-written samples.
 */
export function parseSampleProse(raw: string): SampleFunctionProse {
  const result: SampleFunctionProse = {
    description: "",
    parameters: new Map(),
    expanded: [],
    examples: [],
    throws: [],
    returnFields: new Map(),
    returnsDescription: "",
    leadParagraph: "",
    methodSummaries: new Map(),
    methods: new Map(),
  };

  const { body, frontmatter } = splitFrontmatter(raw);
  const fmDesc = frontmatter.match(/^description:\s*(?:"([^"]*)"|(.+))$/m);
  if (fmDesc) {
    result.description = (fmDesc[1] ?? fmDesc[2] ?? "").trim();
  }

  const sections = splitSections(body);

  // `## Parameters` — top-level param rows. Description is the last column.
  const paramsSection = sections.find((s) => s.heading === "Parameters");
  if (paramsSection) {
    for (const row of extractTableRows(paramsSection.content)) {
      const name = stripCell(row[0]);
      const desc = row.length > 0 ? stripCell(row[row.length - 1]) : "";
      if (name) result.parameters.set(stripAnchorLink(name), desc);
    }
    // Sub-sections (### `CompletionParams`, #### `HistoryMessage`, ...) in the
    // Parameters block describe nested types; their rows map field -> desc.
    for (const sub of paramsSection.subSections) {
      const typeName = extractBacktickedHeading(sub.heading);
      if (!typeName) continue;
      const fields = new Map<string, string>();
      for (const row of extractTableRows(sub.content)) {
        const fname = stripCell(row[0]);
        const fdesc = row.length > 0 ? stripCell(row[row.length - 1]) : "";
        if (fname) fields.set(stripAnchorLink(fname), fdesc);
      }
      if (fields.size > 0) result.expanded.push({ typeName, fields });
      for (const nested of sub.subSections) {
        const nestedName = extractBacktickedHeading(nested.heading);
        if (!nestedName) continue;
        const nestedFields = new Map<string, string>();
        for (const row of extractTableRows(nested.content)) {
          const fname = stripCell(row[0]);
          const fdesc = row.length > 0 ? stripCell(row[row.length - 1]) : "";
          if (fname) nestedFields.set(stripAnchorLink(fname), fdesc);
        }
        if (nestedFields.size > 0) {
          result.expanded.push({ typeName: nestedName, fields: nestedFields });
        }
      }
    }
  }

  // `## Returns` — narrative prose + field table + nested type subsections.
  const returnsSection = sections.find((s) => s.heading === "Returns");
  if (returnsSection) {
    result.returnsDescription = extractProseBeforeTable(returnsSection.content);
    for (const row of extractTableRows(returnsSection.content)) {
      const fname = stripCell(row[0]);
      const fdesc = row.length > 0 ? stripCell(row[row.length - 1]) : "";
      if (fname) result.returnFields.set(stripAnchorLink(fname), fdesc);
    }
    for (const sub of returnsSection.subSections) {
      const typeName = extractBacktickedHeading(sub.heading);
      if (!typeName) continue;
      const fields = new Map<string, string>();
      for (const row of extractTableRows(sub.content)) {
        const fname = stripCell(row[0]);
        const fdesc = row.length > 0 ? stripCell(row[row.length - 1]) : "";
        if (fname) fields.set(stripAnchorLink(fname), fdesc);
      }
      if (fields.size > 0) result.expanded.push({ typeName, fields });
    }
  }

  // `## Throws` — two-column table: Error | When.
  const throwsSection = sections.find((s) => s.heading === "Throws");
  if (throwsSection) {
    for (const row of extractTableRows(throwsSection.content)) {
      if (row.length < 2) continue;
      const error = stripCell(row[0]).replace(/^`|`$/g, "");
      const description = stripCell(row[1]);
      if (error) result.throws.push({ error, description });
    }
  }

  // `## Example` / `## Examples` — each fenced code block is one entry.
  for (const section of sections) {
    if (section.heading !== "Example" && section.heading !== "Examples") continue;
    const fenceRe = /```[\w-]*\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(section.content)) !== null) {
      const code = m[1].replace(/\n$/, "");
      if (code.trim()) result.examples.push(code);
    }
  }

  // Lead paragraph: prose between the top TypeScript signature block and the
  // first `## Parameters` / `## Returns` heading. Many samples use this for
  // extra prose (e.g., `transcribeStream.mdx` has "Yields text chunks as
  // they become available.").
  result.leadParagraph = extractLeadParagraph(body);

  // `## Methods` — summary table for object pages. Rows look like
  //   | [`enable()`](#enable) | Enables profiling and resets aggregated data |
  const methodsSection = sections.find((s) => s.heading === "Methods");
  if (methodsSection) {
    for (const row of extractTableRows(methodsSection.content)) {
      if (row.length < 2) continue;
      const nameCell = stripCell(row[0]);
      const summary = stripCell(row[1]);
      const m = nameCell.match(/\[`(\w+)\(\)`\]/);
      if (m && summary) result.methodSummaries.set(m[1], summary);
    }
  }

  // Per-method subsections: `### \`enable()\``. Some samples nest these under
  // `## Methods`, others put them at the top level — walk the tree so both
  // layouts work. Each one is parsed as its own mini-function (description
  // paragraph + Parameters + Returns + Example).
  const visitForMethods = (section: Section) => {
    const methodName = extractMethodName(section.heading);
    if (methodName && section.depth >= 3) {
      result.methods.set(methodName, parseMethodSection(section));
    }
    for (const sub of section.subSections) visitForMethods(sub);
  };
  for (const section of sections) visitForMethods(section);

  return result;
}

/**
 * Match an `### \`name()\`` heading and return the method name. Returns null
 * for anything that isn't a backticked callable heading.
 */
function extractMethodName(heading: string): string | null {
  const m = heading.match(/^`([A-Za-z_][\w]*)\(\)`$/);
  return m ? m[1] : null;
}

/**
 * Parse a per-method subsection (e.g., `### \`enable()\`` from `profiler.mdx`)
 * into the same SampleFunctionProse shape used by top-level functions.
 *
 * Expected layout (from hand-written samples):
 *
 *     ### `enable()`
 *
 *     ```ts
 *     function enable(options?: ProfilerRuntimeOptions): void
 *     ```
 *
 *     <description paragraph>
 *
 *     **Parameters**
 *
 *     | Name | Type | Required? | Description |
 *     ...
 *
 *     #### `ProfilerRuntimeOptions`
 *     | Field | Type | ... |
 *
 *     **Returns**
 *
 *     <prose>
 */
function parseMethodSection(section: Section): SampleFunctionProse {
  const result: SampleFunctionProse = {
    description: "",
    parameters: new Map(),
    expanded: [],
    examples: [],
    throws: [],
    returnFields: new Map(),
    returnsDescription: "",
    leadParagraph: "",
    methodSummaries: new Map(),
    methods: new Map(),
  };

  // Method descriptions live in the prose between the fenced signature and
  // the first **Parameters** / **Returns** marker. Extract via the same
  // helper used at the top level, treating **Parameters** as the stopper.
  result.description = extractMethodDescription(section.content);

  // Pseudo-sections: samples use bolded `**Parameters**` / `**Returns**` /
  // `**Example**` markers inside method subsections rather than `####`
  // headings. Split the content on these markers.
  const blocks = splitBoldMarkers(section.content);

  const paramsBlock = blocks.get("Parameters");
  if (paramsBlock) {
    for (const row of extractTableRows(paramsBlock)) {
      const name = stripCell(row[0]);
      const desc = row.length > 0 ? stripCell(row[row.length - 1]) : "";
      if (name) result.parameters.set(stripAnchorLink(name), desc);
    }
  }

  const returnsBlock = blocks.get("Returns");
  if (returnsBlock) {
    const narrative = extractProseBeforeTable(returnsBlock);
    // Ignore narratives that are just a backticked type (e.g., "`void`" or
    // "`boolean`"); those aren't prose — they're the type itself, which the
    // renderer emits separately. Keep narratives like "`boolean` — true if..."
    if (narrative && !/^`[^`]+`$/.test(narrative.trim())) {
      result.returnsDescription = narrative;
    }
    for (const row of extractTableRows(returnsBlock)) {
      const fname = stripCell(row[0]);
      const fdesc = row.length > 0 ? stripCell(row[row.length - 1]) : "";
      if (fname) result.returnFields.set(stripAnchorLink(fname), fdesc);
    }
  }

  for (const blockName of ["Example", "Examples"]) {
    const exampleBlock = blocks.get(blockName);
    if (!exampleBlock) continue;
    const fenceRe = /```[\w-]*\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(exampleBlock)) !== null) {
      const code = m[1].replace(/\n$/, "");
      if (code.trim()) result.examples.push(code);
    }
  }

  // Nested `#### \`TypeName\`` subsections under this method describe expanded
  // types (e.g., `#### \`ProfilerRuntimeOptions\`` under `### \`enable()\``).
  for (const sub of section.subSections) {
    const typeName = extractBacktickedHeading(sub.heading);
    if (!typeName) continue;
    const fields = new Map<string, string>();
    for (const row of extractTableRows(sub.content)) {
      const fname = stripCell(row[0]);
      const fdesc = row.length > 0 ? stripCell(row[row.length - 1]) : "";
      if (fname) fields.set(stripAnchorLink(fname), fdesc);
    }
    if (fields.size > 0) result.expanded.push({ typeName, fields });
  }

  return result;
}

/**
 * Extract the method description: prose between the first fenced signature
 * and the first bolded section marker (**Parameters**, **Returns**, etc.).
 */
function extractMethodDescription(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let afterFirstFence = false;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (!afterFirstFence) {
        inFence = !inFence;
        if (!inFence) afterFirstFence = true;
        continue;
      }
      break;
    }
    if (!afterFirstFence) continue;
    if (/^\*\*(Parameters|Returns|Example|Examples|Throws)\*\*/.test(line.trim())) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * Split a block of MDX on bolded markers like `**Parameters**`, `**Returns**`,
 * `**Example**` and return the block following each marker up to the next
 * marker or end. Used to parse per-method subsections.
 */
function splitBoldMarkers(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = content.split("\n");
  let current: string | null = null;
  let buf: string[] = [];
  const markerRe = /^\*\*(Parameters|Returns|Example|Examples|Throws)\*\*\s*$/;
  for (const line of lines) {
    const m = line.trim().match(markerRe);
    if (m) {
      if (current) result.set(current, buf.join("\n").trim());
      current = m[1];
      buf = [];
      continue;
    }
    if (current) buf.push(line);
  }
  if (current) result.set(current, buf.join("\n").trim());
  return result;
}

/**
 * Return the prose text that appears BEFORE any pipe-table in the given
 * section body. Strips the leading/trailing whitespace and inline code fences.
 */
function extractProseBeforeTable(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence && line.trim().startsWith("|")) break;
    out.push(line);
  }
  // Drop any remaining fenced code blocks and leading/trailing blank lines.
  return out
    .join("\n")
    .replace(/```[\s\S]*?```/g, "")
    .trim();
}

/**
 * Extract the paragraph that sits between the top `\`\`\`ts` signature block
 * and the first `##` heading. Returns an empty string when the sample has no
 * lead paragraph (most simple samples skip it).
 */
function extractLeadParagraph(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let afterFirstFence = false;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (!afterFirstFence) {
        inFence = !inFence;
        if (!inFence) afterFirstFence = true;
        continue;
      }
      inFence = !inFence;
    }
    if (!afterFirstFence) continue;
    if (inFence) continue;
    if (/^##\s/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { frontmatter: "", body: raw };
  return { frontmatter: match[1], body: match[2] };
}

interface Section {
  heading: string;
  depth: number;
  content: string;
  subSections: Section[];
}

/**
 * Split an MDX body into a tree of heading sections. The top-level list
 * contains `##` sections; each section's `subSections` contains any deeper
 * headings (`###`, `####`, ...) up to the next same-or-higher heading.
 */
function splitSections(body: string): Section[] {
  const lines = body.split("\n");
  const root: Section = { heading: "", depth: 1, content: "", subSections: [] };
  const stack: Section[] = [root];
  let buffer: string[] = [];
  let inFence = false;

  function flushBuffer() {
    const top = stack[stack.length - 1];
    top.content += (top.content ? "\n" : "") + buffer.join("\n");
    buffer = [];
  }

  for (const line of lines) {
    // Track code fences so we don't treat `# something` inside code as a heading.
    if (/^```/.test(line)) {
      inFence = !inFence;
      buffer.push(line);
      continue;
    }
    if (!inFence) {
      const headingMatch = line.match(/^(#{2,6})\s+(.*?)\s*$/);
      if (headingMatch) {
        flushBuffer();
        const depth = headingMatch[1].length;
        const heading = headingMatch[2].trim();
        // Pop stack to the parent of this depth.
        while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
          stack.pop();
        }
        const section: Section = { heading, depth, content: "", subSections: [] };
        const parent = stack[stack.length - 1] ?? root;
        parent.subSections.push(section);
        stack.push(section);
        continue;
      }
    }
    buffer.push(line);
  }
  flushBuffer();
  return root.subSections;
}

/**
 * Pull `\`Name\`` or just `Name` text out of a sub-section heading like
 * `\`CompletionParams\`` or `\`HistoryMessage\``. Returns null when the
 * heading doesn't look like a type name.
 */
function extractBacktickedHeading(heading: string): string | null {
  const m = heading.match(/^`?([A-Za-z_][\w.]*)`?(?:\(\))?$/);
  if (m) return m[1];
  // Some samples use `#### \`kvCache\`` (a field concept, not a type) — still
  // return the name so callers can key on it.
  const fallback = heading.replace(/`/g, "").trim();
  return fallback || null;
}

/**
 * Walk markdown pipe-table rows out of a block of MDX. Returns the body rows
 * (header and separator are dropped). Each row is an array of raw cell
 * contents (unescaped pipes inside inline code spans are handled).
 */
function extractTableRows(block: string): string[][] {
  const lines = block.split("\n");
  const rows: string[][] = [];
  let started = false;
  let skippedSeparator = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      if (started) break;
      continue;
    }
    if (!started) {
      // First row is the header; skip it.
      started = true;
      continue;
    }
    if (!skippedSeparator) {
      // Second row is the `| --- | ... |` separator; skip it.
      skippedSeparator = true;
      continue;
    }
    rows.push(splitPipeRow(trimmed));
  }
  return rows;
}

/**
 * Split a pipe-table row into cells. Handles escaped pipes (`\|`) and pipes
 * inside backtick-delimited code spans.
 */
function splitPipeRow(line: string): string[] {
  // Drop the leading and trailing pipes.
  const inner = line.replace(/^\|/, "").replace(/\|\s*$/, "");
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && inner[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

/**
 * Clean a markdown cell of surrounding whitespace and stray dashes ("—") that
 * hand-written samples use as placeholders.
 */
function stripCell(cell: string): string {
  const trimmed = cell.trim();
  if (trimmed === "—" || trimmed === "-") return "";
  return trimmed;
}

/**
 * Strip markdown link / backtick decoration around a name cell, e.g.
 * `` `params` ``, `params`, `[`params`](#params)` → `params`.
 */
function stripAnchorLink(cell: string): string {
  const linkMatch = cell.match(/^\[`?([^`\]]+?)`?\]\([^)]+\)$/);
  if (linkMatch) return linkMatch[1].trim();
  const bareLink = cell.match(/^\[([^\]]+)\]\([^)]+\)$/);
  if (bareLink) return bareLink[1].replace(/`/g, "").trim();
  return cell.replace(/`/g, "").trim();
}
