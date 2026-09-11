#!/usr/bin/env bun
/**
 * Phase 4 of qv-docs-update — deterministic routing from changed source paths
 * to candidate documentation pages and sections.
 *
 * Usage:
 *   bun run route-docs-targets.ts < source-change-set.json
 *   bun run route-docs-targets.ts --input source-change-set.json [--repo <path>]
 *
 * Reads the SOURCE_CHANGE_SET emitted by collect-source-changes.sh and emits a
 * JSON candidate set grouped by page.
 *
 * This is lookup, not heuristics. Each of R1, R2 and R4 resolves a binding that
 * already exists in the content — a literal `file=` directive, an API-summary
 * anchor, a command heading — so a hit is a fact about the repo, not a guess.
 * R3 is the declared fallback and says so in its output.
 *
 * The candidates are NOT the targets. Every candidate here still has to survive
 * the Phase 4 filter, where the model reads the section and states which claim
 * went stale. Routing wide is cheap; that filter is the real gate.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Router = "R1" | "R2" | "R3" | "R4";

interface ChangedFile {
  path: string;
  bucket: string;
  status: string;
}

interface SourceChangeSet {
  state: string;
  base: { ref: string; sha: string; short: string };
  strong_evidence: boolean;
  buckets: string[];
  file_count: number;
  files: ChangedFile[];
}

interface Candidate {
  /** Page path relative to `content/docs/`. */
  page: string;
  /** Enclosing heading text, or null when the hit is page-level (R3). */
  section: string | null;
  /** Heading depth (2 for `##`, 3 for `###`), or null for page-level hits. */
  sectionLevel: number | null;
  via: Router;
  /** The source path that produced the hit. */
  source: string;
  /** Human-readable evidence: the literal binding that matched. */
  evidence: string;
  /** 1-based line in the page where the binding was found, when applicable. */
  line: number | null;
}

interface Unrouted {
  source: string;
  bucket: string;
  status: string;
  reason: string;
  /** Set when the source is a new public symbol with no page — the
   *  NEW_CAPABILITY_PAGE signal. */
  newSymbol?: string;
}

interface Discarded {
  page: string;
  source: string;
  via: Router;
  reason: string;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let inputPath: string | null = null;
let repoRoot: string | null = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--input") inputPath = args[++i] ?? null;
  else if (a === "--repo") repoRoot = args[++i] ?? null;
  else if (a === "-h" || a === "--help") {
    console.log("usage: route-docs-targets.ts [--input <file>] [--repo <path>]");
    process.exit(0);
  } else {
    console.error(`route-docs-targets: unknown argument: ${a}`);
    process.exit(2);
  }
}

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
// .cursor/skills/qv-docs-update/scripts -> repo root is four levels up.
const REPO = repoRoot ?? path.resolve(SCRIPT_DIR, "..", "..", "..", "..");

const DOCS_CONTENT = path.join(REPO, "docs", "website", "content", "docs");
const API_BARREL = path.join(REPO, "packages", "sdk", "src", "client", "api", "index.ts");
const ROUTING_MAP = path.join(SKILL_DIR, "references", "routing-map.yaml");

// ---------------------------------------------------------------------------
// Scope — mirrors references/docs-scope.md. Kept in code because the scope gate
// has to run without a model in the loop; docs-scope.md is the prose that
// explains it and the two must be changed together.
// ---------------------------------------------------------------------------

const ALLOWLIST_PREFIXES = [
  "ai-capabilities/",
  "cli/",
  "configuration/",
  "models/",
  "p2p-capabilities/",
  "runtime/",
];

const ALLOWLIST_FILES = new Set([
  "introduction.mdx",
  "js-ts-sdk.mdx",
  "python-sdk.mdx",
  "system-requirements.mdx",
]);

/** Editable only as an append, and only in NEW_CAPABILITY_PAGE. */
const RESTRICTED_FILES = new Set(["index.mdx"]);

function scopeOf(page: string): "allowed" | "restricted" | "denied" {
  if (ALLOWLIST_PREFIXES.some((p) => page.startsWith(p))) return "allowed";
  if (ALLOWLIST_FILES.has(page)) return "allowed";
  if (RESTRICTED_FILES.has(page)) return "restricted";
  return "denied";
}

// ---------------------------------------------------------------------------
// Page index — read every allowlisted MDX once, keep its lines and headings
// ---------------------------------------------------------------------------

interface Heading {
  line: number; // 0-based
  level: number;
  text: string;
}

interface Page {
  /** Relative to `content/docs/`. */
  rel: string;
  lines: string[];
  headings: Heading[];
}

const HEADING_RE = /^(#{2,6})\s+(.*\S)\s*$/;
const FENCE_RE = /^```/;

function loadPages(): Page[] {
  const pages: Page[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.name.endsWith(".mdx")) continue;

      const rel = path.relative(DOCS_CONTENT, abs).split(path.sep).join("/");
      // `reference/**` is generated; never a routing target. Skipping it here
      // rather than at scope-check time keeps the ~2000-line API summary out of
      // every grep.
      if (rel.startsWith("reference/")) continue;
      if (scopeOf(rel) === "denied") continue;

      const lines = fs.readFileSync(abs, "utf-8").split("\n");
      pages.push({ rel, lines, headings: collectHeadings(lines) });
    }
  };

  walk(DOCS_CONTENT);
  pages.sort((a, b) => a.rel.localeCompare(b.rel));
  return pages;
}

/**
 * Headings outside fenced code blocks. The fence check matters: several pages
 * embed shell transcripts and MDX samples whose lines start with `#`, and a
 * comment line in a bash block would otherwise be read as a section.
 */
function collectHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = line.match(HEADING_RE);
    if (m) headings.push({ line: i, level: m[1]!.length, text: m[2]! });
  }

  return headings;
}

/** Deepest heading at or above `line`. This is the section a hit belongs to. */
function enclosingHeading(page: Page, line: number): Heading | null {
  let found: Heading | null = null;
  for (const h of page.headings) {
    if (h.line <= line) found = h;
    else break;
  }
  return found;
}

/**
 * Breadcrumb for a heading, so a report reads `Examples › Usage` rather than a
 * bare `Usage` that appears on four different pages.
 */
function headingPath(page: Page, heading: Heading): string {
  const trail: string[] = [heading.text];
  let level = heading.level;

  for (let i = page.headings.indexOf(heading) - 1; i >= 0 && level > 2; i--) {
    const h = page.headings[i]!;
    if (h.level < level) {
      trail.unshift(h.text);
      level = h.level;
    }
  }

  return trail.join(" › ");
}

// ---------------------------------------------------------------------------
// Shared hit recording
// ---------------------------------------------------------------------------

const candidates: Candidate[] = [];
const discarded: Discarded[] = [];
const unrouted: Unrouted[] = [];

/** Deduplicate on page + section + router + source. */
const seen = new Set<string>();

function record(page: Page, line: number, via: Router, source: string, evidence: string) {
  const scope = scopeOf(page.rel);
  if (scope === "denied") {
    discarded.push({
      page: page.rel,
      source,
      via,
      reason: "outside the docs-scope allowlist (read-only for this skill)",
    });
    return;
  }
  if (scope === "restricted") {
    discarded.push({
      page: page.rel,
      source,
      via,
      reason:
        "append-only surface, writable only in NEW_CAPABILITY_PAGE (see docs-scope.md)",
    });
    return;
  }

  const heading = line >= 0 ? enclosingHeading(page, line) : null;
  const section = heading ? headingPath(page, heading) : null;
  const key = `${page.rel}|${section ?? ""}|${via}|${source}`;
  if (seen.has(key)) return;
  seen.add(key);

  candidates.push({
    page: page.rel,
    section,
    sectionLevel: heading?.level ?? null,
    via,
    source,
    evidence,
    line: line >= 0 ? line + 1 : null,
  });
}

// ---------------------------------------------------------------------------
// R1 — examples router (exact, highest priority)
//
// Every page that shows code references the example file by literal path; no
// page inlines a full example. So the directive IS the binding, and a match has
// no false-positive mode.
// ---------------------------------------------------------------------------

function referencePathsFor(sourcePath: string): string[] {
  const paths = [sourcePath];

  // A TS example is also shown in its transpiled form on the JavaScript tab.
  // The JS fence points at dist/, which is a build artefact of the same .ts, so
  // touching the .ts must also route the page that references the .js.
  const tsMatch = sourcePath.match(/^packages\/sdk\/examples\/(.+)\.ts$/);
  if (tsMatch) {
    paths.push(`packages/sdk/dist/examples/${tsMatch[1]}.js`);
  }

  return paths;
}

/** `completion_events.py` <-> `completion-events.ts`: convention, not a guarantee. */
function tsPairForPythonExample(sourcePath: string): string | null {
  const m = sourcePath.match(/^packages\/sdk-python\/examples\/(.+)\.py$/);
  if (!m) return null;
  const kebab = m[1]!.split("/").map((seg) => seg.replace(/_/g, "-")).join("/");
  return `packages/sdk/examples/${kebab}.ts`;
}

function runR1(pages: Page[], files: ChangedFile[]) {
  const examples = files.filter((f) => f.bucket === "examples");

  for (const file of examples) {
    let hits = 0;

    for (const refPath of referencePathsFor(file.path)) {
      const needle = `file=<rootDir>/${refPath}`;
      for (const page of pages) {
        for (let i = 0; i < page.lines.length; i++) {
          if (page.lines[i]!.includes(needle)) {
            record(page, i, "R1", file.path, needle);
            hits++;
          }
        }
      }
    }

    if (hits > 0) continue;

    // No page references this example yet. For a Python example the TS sibling
    // is the best remaining signal: if a page already shows the TS tab, that is
    // where the Python tab belongs.
    const tsPair = tsPairForPythonExample(file.path);
    if (tsPair && fs.existsSync(path.join(REPO, tsPair))) {
      let pairHits = 0;
      for (const refPath of referencePathsFor(tsPair)) {
        const needle = `file=<rootDir>/${refPath}`;
        for (const page of pages) {
          for (let i = 0; i < page.lines.length; i++) {
            if (page.lines[i]!.includes(needle)) {
              record(
                page,
                i,
                "R1",
                file.path,
                `TS sibling ${tsPair} referenced here — candidate for a Python tab`,
              );
              pairHits++;
            }
          }
        }
      }
      if (pairHits > 0) continue;
    }

    // A new example with no page reference and no referenced sibling. R2 does
    // NOT recover it: R2 reads the `api/` barrel, and never looks at which
    // functions an example calls. R3 may still place it if the routing map
    // declares its area; otherwise Phase 4 asks, and the answer becomes a map
    // entry.
    unrouted.push({
      source: file.path,
      bucket: file.bucket,
      status: file.status,
      reason:
        file.status === "A"
          ? "new example; no page references it yet, so the destination section must be named by hand"
          : "example is not referenced by any page in scope",
    });
  }
}

// ---------------------------------------------------------------------------
// R2 — symbol router
//
// packages/sdk/src/client/api/ holds one file per public function, kebab-cased.
// Pages link those functions as `/reference/api#<symbol-lowercase>`.
// ---------------------------------------------------------------------------

function kebabToCamel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Module basename -> the public symbols the barrel re-exports from it.
 *
 * The barrel is the authority, not the filename. Deriving the symbol by
 * kebab-to-camel gets the common case right and the important cases wrong:
 * `completion-stream.ts` exports `completion` (so the anchor is `#completion`,
 * never `#completionstream`), `rag.ts` exports nine `rag*` functions, and
 * `transcribe.ts` exports both `transcribe` and `transcribeStream`. Reading the
 * barrel keeps R2 a lookup instead of a guess.
 *
 * Type-only re-exports (`type FinetuneHandle`) are dropped: the API summary
 * anchors functions, so a type would only ever add a phantom miss.
 */
function loadBarrelMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!fs.existsSync(API_BARREL)) return map;

  const src = fs.readFileSync(API_BARREL, "utf-8");

  // `export { a, b as c, type D } from './module'`, brace list possibly
  // spanning lines. The barrel mixes both specifier styles for the same
  // directory — line 56 re-exports `audioGen` from `@/client/api/audio-gen` —
  // so accept the alias too. Missing one makes its module look unexported,
  // which suppresses the new-capability signal downstream.
  for (const m of src.matchAll(
    /export\s*\{([^}]*)\}\s*from\s*['"](?:\.\/|@\/client\/api\/)([^'"]+)['"]/g,
  )) {
    const module = path.basename(m[2]!, ".js").replace(/\.ts$/, "");
    const symbols: string[] = [];

    for (const raw of m[1]!.split(",")) {
      const part = raw.trim();
      if (!part || part.startsWith("type ")) continue;
      // `original as alias` — the alias is the public name.
      const alias = part.match(/\bas\s+([A-Za-z0-9_$]+)/);
      symbols.push(alias ? alias[1]! : part);
    }

    if (symbols.length > 0) {
      map.set(module, [...(map.get(module) ?? []), ...symbols]);
    }
  }

  // `export * from './module'` names no symbols, so the filename convention is
  // the only signal left for those.
  for (const m of src.matchAll(
    /export\s+\*\s+from\s*['"](?:\.\/|@\/client\/api\/)([^'"]+)['"]/g,
  )) {
    const module = path.basename(m[1]!, ".js").replace(/\.ts$/, "");
    if (!map.has(module)) map.set(module, [kebabToCamel(module)]);
  }

  return map;
}

function runR2(pages: Page[], files: ChangedFile[]) {
  const barrel = loadBarrelMap();
  const apiFiles = files.filter((f) => f.bucket === "api");

  for (const file of apiFiles) {
    const module = path.basename(file.path, ".ts");
    if (module === "index") continue; // the barrel itself is bucket `surface`

    const fromBarrel = barrel.get(module);
    // Not in the barrel: either a brand-new module the developer has not
    // exported yet, or an internal helper that happens to sit in api/. Fall
    // back to the filename so the miss is still reported by name.
    const symbols = fromBarrel ?? [kebabToCamel(module)];
    const isExported = fromBarrel !== undefined;

    for (const symbol of symbols) {
      const anchor = `/reference/api#${symbol.toLowerCase()}`;
      let hits = 0;

      for (const page of pages) {
        for (let i = 0; i < page.lines.length; i++) {
          if (page.lines[i]!.includes(anchor)) {
            record(page, i, "R2", file.path, anchor);
            hits++;
          }
        }
      }

      // Secondary pass: a symbol that is LINKED but not to its API anchor.
      //
      // The anchor is the primary binding, but it is not the only authored one.
      // `text-generation.mdx` writes
      // [`batchCompletion()`](/ai-capabilities/batch-processing) and carries a
      // whole paragraph on how that function shares `parallel` slots — a claim
      // that goes stale like any other. Anchor-only matching misses it, and R3
      // never recovers the page: the fallback only picks up files the exact
      // routers could not resolve, and this file WAS resolved by R2 — just onto
      // a different page. Without this pass the page is missed silently.
      //
      // This stays a lookup rather than the loose name-grep the design
      // rejected: it matches a markdown link whose text is the symbol, so the
      // author deliberately pointed at it. Recorded with distinct evidence so
      // the report shows it is the weaker of the two bindings.
      const linkedForm = `[\`${symbol}(`;
      for (const page of pages) {
        for (let i = 0; i < page.lines.length; i++) {
          const line = page.lines[i]!;
          if (line.includes(linkedForm) && !line.includes(anchor)) {
            record(
              page,
              i,
              "R2",
              file.path,
              `${symbol}() linked without its API anchor — weaker binding than ${anchor}`,
            );
            hits++;
          }
        }
      }

      if (hits > 0) continue;

      // No page links this symbol. A NEW file exporting it is the
      // NEW_CAPABILITY_PAGE signal; anything else is a documentation gap.
      const isNew = file.status === "A";

      unrouted.push({
        source: file.path,
        bucket: file.bucket,
        status: file.status,
        newSymbol: isNew && isExported ? symbol : undefined,
        reason:
          isNew && isExported
            ? `new exported symbol ${symbol}() and no page links ${anchor} — candidate NEW_CAPABILITY_PAGE`
            : isNew
              ? `new module exporting ${symbol}(), not re-exported from the api barrel — confirm it is meant to be public`
              : `no page links ${anchor}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// R4 — CLI command router (exact)
//
// packages/cli/src/ has one folder per command area, and each command has its
// own `### `qvac <command>`` heading in cli/index.mdx.
// ---------------------------------------------------------------------------

/** Command folder -> the command line as written in the docs heading. */
const CLI_COMMANDS: Record<string, string> = {
  "bundle-sdk": "qvac bundle sdk",
  serve: "qvac serve",
  configure: "qvac configure",
  openai: "qvac openai spec",
  doctor: "qvac doctor",
  verify: "qvac verify",
};

/**
 * Narrative sections of cli/index.mdx that describe a command outside the
 * `## Reference` block. A behaviour change can invalidate a claim there while
 * the reference heading stays correct, so they route as extra candidates.
 */
const CLI_NARRATIVE_SECTIONS: Record<string, string[]> = {
  serve: ["HTTP server"],
  configure: ["Interactive config generator"],
  "bundle-sdk": ["SDK bundling"],
  doctor: ["System requirements check"],
};

function runR4(pages: Page[], files: ChangedFile[]) {
  const cliFiles = files.filter((f) => f.bucket === "cli-command");
  const cliIndex = pages.find((p) => p.rel === "cli/index.mdx");

  const folders = new Map<string, ChangedFile[]>();
  for (const file of cliFiles) {
    const m = file.path.match(/^packages\/cli\/src\/([^/]+)\//);
    if (!m) continue;
    const folder = m[1]!;
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder)!.push(file);
  }

  for (const [folder, folderFiles] of folders) {
    // A folder absent from CLI_COMMANDS is, in practice, a command added after
    // that map was written: every folder under src/ is a command today, and the
    // framework folder (src/cli/) is bucketed `cli-infra` before it gets here.
    // The convention is `qvac <folder>`, so fall back to it and keep the new
    // command inside R4 (acceptance scenario Q). The map still earns its keep
    // for the commands whose name does not follow the folder — `bundle-sdk` is
    // `qvac bundle sdk`, `openai` is `qvac openai spec`. If a non-command
    // folder ever appears, it routes to `## Reference` and the Phase 4 filter
    // drops it: no claim there went stale.
    const command = CLI_COMMANDS[folder] ?? `qvac ${folder}`;
    const representative = folderFiles[0]!.path;

    if (!cliIndex) continue;

    // A command the routing map declares undocumented is a decision, not a
    // gap. Honouring it here is what stops R4 and R3 from contradicting each
    // other — R4 asking for a heading that R3 says should not exist.
    const declaration = declaredUndocumented(`packages/cli/src/${folder}/`);
    if (declaration) {
      discarded.push({
        page: "cli/index.mdx",
        source: `packages/cli/src/${folder}/`,
        via: "R4",
        reason: `routing-map.yaml declares ${declaration} as not documented`,
      });
      continue;
    }

    // The command's own reference heading.
    const headingNeedle = `\`${command}\``;
    const refHeading = cliIndex.headings.find(
      (h) => h.text.includes(headingNeedle) && h.level === 3,
    );

    if (refHeading) {
      record(cliIndex, refHeading.line, "R4", representative, `### ${refHeading.text}`);
    } else {
      // A new command folder with no heading. This is NOT a new page — the CLI
      // documents commands as sections of one page (acceptance scenario Q).
      // The destination is deterministic, so route it instead of asking: a new
      // command always becomes a `###` heading under `## Reference`.
      const reference = cliIndex.headings.find(
        (h) => h.level === 2 && h.text.trim() === "Reference",
      );

      if (reference) {
        record(
          cliIndex,
          reference.line,
          "R4",
          representative,
          `new command with no \`${command}\` heading yet — add one under "## Reference"`,
        );
      } else {
        unrouted.push({
          source: `packages/cli/src/${folder}/`,
          bucket: "cli-command",
          status: folderFiles[0]!.status,
          reason: `no \`${command}\` heading in cli/index.mdx and no "## Reference" section to add one under`,
        });
      }
    }

    // Narrative sections that also describe this command.
    for (const sectionName of CLI_NARRATIVE_SECTIONS[folder] ?? []) {
      const h = cliIndex.headings.find((x) => x.text === sectionName && x.level === 2);
      if (h) {
        record(
          cliIndex,
          h.line,
          "R4",
          representative,
          `## ${sectionName} (narrative section describing ${command})`,
        );
      }
    }

    // `serve` additionally owns a whole docs subtree.
    if (folder === "serve") {
      for (const page of pages) {
        if (!page.rel.startsWith("cli/http-server/")) continue;
        record(page, -1, "R4", representative, "cli/http-server/** owned by `qvac serve`");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// R3 — area fallback (declared; runs per file, for paths R1/R2/R4 left unrouted)
// ---------------------------------------------------------------------------

interface MapEntry {
  source: string;
  pages: string[];
}

/**
 * Minimal parser for the constrained shape routing-map.yaml is documented to
 * have: a flat sequence of `- source: <glob>` / `pages: [<glob>, ...]`. Written
 * by hand so the skill's scripts stay dependency-free — they run from
 * .cursor/skills/, which has no package.json to install a YAML library into.
 */
function loadRoutingMap(): MapEntry[] {
  if (!fs.existsSync(ROUTING_MAP)) return [];

  const entries: MapEntry[] = [];
  let current: MapEntry | null = null;

  for (const raw of fs.readFileSync(ROUTING_MAP, "utf-8").split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;

    const sourceMatch = line.match(/^-\s*source:\s*(\S+)\s*$/);
    if (sourceMatch) {
      if (current) entries.push(current);
      current = { source: sourceMatch[1]!, pages: [] };
      continue;
    }

    const pagesMatch = line.match(/^\s+pages:\s*\[(.*)\]\s*$/);
    if (pagesMatch && current) {
      current.pages = pagesMatch[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  if (current) entries.push(current);
  return entries;
}

let routingMapCache: MapEntry[] | null = null;

function routingMap(): MapEntry[] {
  routingMapCache ??= loadRoutingMap();
  return routingMapCache;
}

/**
 * The `source` glob of a matching `pages: []` entry, or null. An empty page
 * list is a positive declaration that the path is not documented, and both R3
 * and R4 have to respect it or they contradict each other.
 */
function declaredUndocumented(sourcePath: string): string | null {
  const entry = routingMap().find(
    (e) => e.pages.length === 0 && globToRegExp(e.source).test(sourcePath),
  );
  return entry?.source ?? null;
}

/** Glob support limited to what the map uses: `**` and a single-segment `*`. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${body}$`);
}

function runR3(pages: Page[], files: ChangedFile[], routedSources: Set<string>) {
  const map = routingMap();

  for (const file of files) {
    if (file.bucket === "internal") continue;
    // Per-FILE fallback, not per-run. An earlier design gated R3 on the whole
    // run finding nothing, which measured badly: in a backtest over merged
    // commits it was the single largest source of misses. A commit that
    // touches an example (R1 hits) and a config module (only R3 covers it)
    // would silently drop the configuration page, because R1's hit suppressed
    // R3 for every file. Exact routers still win per file — a file they
    // resolved never reaches here.
    if (routedSources.has(file.path)) continue;

    const entry = map.find((e) => globToRegExp(e.source).test(file.path));

    if (!entry) {
      // R1/R2/R4 may already have reported this path and said why it did not
      // route. Repeating it here would present one problem as two.
      if (unrouted.some((u) => u.source === file.path)) continue;

      unrouted.push({
        source: file.path,
        bucket: file.bucket,
        status: file.status,
        reason:
          "no exact binding and no routing-map.yaml entry — name the page that covers this topic, and the answer becomes a new map entry",
      });
      continue;
    }

    // An explicit empty list is a declaration, not a miss. Recorded as a
    // discard so the report shows the decision was consulted.
    if (entry.pages.length === 0) {
      discarded.push({
        page: "(none)",
        source: file.path,
        via: "R3",
        reason: `routing-map.yaml declares ${entry.source} as not documented`,
      });
      continue;
    }

    for (const pageGlob of entry.pages) {
      const re = globToRegExp(pageGlob);
      const matches = pages.filter((p) => re.test(p.rel));

      if (matches.length === 0) {
        discarded.push({
          page: pageGlob,
          source: file.path,
          via: "R3",
          reason: "routing-map.yaml entry matches no page in scope",
        });
        continue;
      }

      for (const page of matches) {
        record(page, -1, "R3", file.path, `routing-map.yaml: ${entry.source} → ${pageGlob}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function readInput(): SourceChangeSet {
  const raw = inputPath
    ? fs.readFileSync(inputPath, "utf-8")
    : fs.readFileSync(0, "utf-8");
  return JSON.parse(raw) as SourceChangeSet;
}

function main() {
  const changeSet = readInput();

  if (changeSet.state === "NO_SOURCE_CHANGE" || changeSet.state === "NO_DOCS_IMPACT") {
    console.log(
      JSON.stringify(
        { state: changeSet.state, base: changeSet.base, pages: [], candidates: [], unrouted: [], discarded: [] },
        null,
        2,
      ),
    );
    return;
  }

  const pages = loadPages();

  // R1 and R4 first — the two exact routers with the strongest bindings — then
  // R2. R3 then picks up only the files none of them could resolve, so it
  // stays a fallback without letting one file's exact hit hide another file
  // that only the area map covers.
  runR1(pages, changeSet.files);
  runR4(pages, changeSet.files);
  runR2(pages, changeSet.files);

  const exactRouterHits = candidates.length;
  const routedSources = new Set(candidates.map((c) => c.source));
  runR3(pages, changeSet.files, routedSources);

  // An exact router can report a file unrouted and R3 can then place it — a
  // Python example with no `file=` directive and no TS sibling is the common
  // case. Reporting both would make Phase 4 ask which page covers a topic the
  // run just routed. A route is an answer; unrouted is the absence of one, so
  // the candidate wins.
  const resolvedSources = new Set(candidates.map((c) => c.source));
  const stillUnrouted = unrouted.filter((u) => !resolvedSources.has(u.source));

  // Group by page: the unit a reviewer opens.
  const byPage = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!byPage.has(c.page)) byPage.set(c.page, []);
    byPage.get(c.page)!.push(c);
  }

  const newSymbols = stillUnrouted.filter((u) => u.newSymbol).map((u) => u.newSymbol!);

  // Advisory only. The skill owns the state machine; the router reports the
  // signals it can see.
  let state = "DOCS_UPDATE_REQUIRED";
  if (byPage.size === 0 && newSymbols.length > 0) state = "NEW_CAPABILITY_PAGE";
  else if (byPage.size === 0 && stillUnrouted.length > 0) state = "HUMAN_INPUT_REQUIRED";
  else if (byPage.size === 0) state = "NO_DOCS_IMPACT";

  console.log(
    JSON.stringify(
      {
        state,
        base: changeSet.base,
        r3_used: exactRouterHits === 0 && candidates.length > 0,
        // Informative only. High page counts are allowed and never block; the
        // gate against wide routing is the per-candidate filter, not a count.
        high_page_count: byPage.size > 4,
        new_capability_symbols: newSymbols,
        pages: [...byPage.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([page, hits]) => ({ page, targets: hits })),
        unrouted: stillUnrouted,
        discarded,
      },
      null,
      2,
    ),
  );
}

main();
