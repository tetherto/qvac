#!/usr/bin/env bun
/**
 * Validate all code examples in the docs website.
 *
 * Usage: bun run scripts/test-code-examples.ts
 *
 * Checks:
 *   1. File import references (file=<rootDir>/...) resolve to existing files
 *   2. SDK examples type-check against current SDK types
 *   3. Prebuild transpilation produces expected .js output
 *   4. Inline TS/JS code blocks parse without syntax errors
 */

import * as fs from "fs/promises";
import * as path from "path";
import { execFileSync, execSync } from "child_process";
import { glob } from "glob";
import ts from "typescript";

const DOCS_DIR = process.cwd();
const MONOREPO_ROOT = path.resolve(DOCS_DIR, "../..");
const LATEST_CONTENT = path.join(DOCS_DIR, "content", "docs", "(latest)");
const SDK_DIR = path.join(MONOREPO_ROOT, "packages", "sdk");

const FILE_REF_RE = /file=<rootDir>\/([\S]+)/g;
const FENCE_OPEN_RE = /^```(\w+)?(.*)/;
const FENCE_CLOSE_RE = /^```\s*$/;

const SYNTAX_LANGS = new Set(["ts", "typescript", "js", "javascript"]);

interface CheckResult {
  name: string;
  passed: boolean;
  skipped: boolean;
  total: number;
  failures: string[];
}

interface CodeBlock {
  lang: string;
  content: string;
  file: string;
  line: number;
}

async function findMdxFiles(): Promise<string[]> {
  return glob("**/*.mdx", { cwd: LATEST_CONTENT, absolute: true });
}

// ---------------------------------------------------------------------------
// Check 1 — file=<rootDir>/... references point to real files
// ---------------------------------------------------------------------------

async function checkFileReferences(): Promise<CheckResult> {
  const failures: string[] = [];
  let total = 0;

  for (const mdxPath of await findMdxFiles()) {
    const content = await fs.readFile(mdxPath, "utf-8");
    const rel = path.relative(DOCS_DIR, mdxPath);

    for (const match of content.matchAll(FILE_REF_RE)) {
      total++;
      const refPath = match[1]!;
      const abs = path.join(MONOREPO_ROOT, refPath);

      try {
        await fs.access(abs);
      } catch {
        failures.push(`${rel}: missing file ${refPath}`);
        continue;
      }

      if (refPath.includes("/dist/examples/") && refPath.endsWith(".js")) {
        const srcPath = refPath
          .replace("/dist/examples/", "/examples/")
          .replace(/\.js$/, ".ts");
        try {
          await fs.access(path.join(MONOREPO_ROOT, srcPath));
        } catch {
          failures.push(`${rel}: compiled .js exists but source .ts missing (${srcPath})`);
        }
      }
    }
  }

  return { name: "File import references", passed: failures.length === 0, skipped: false, total, failures };
}

// ---------------------------------------------------------------------------
// Check 2 — SDK examples type-check via tsc --noEmit in packages/sdk
// ---------------------------------------------------------------------------

async function checkSdkTypecheck(): Promise<CheckResult> {
  const failures: string[] = [];

  try {
    execSync("npx tsc --version", { cwd: SDK_DIR, stdio: "pipe", timeout: 15_000 });
  } catch {
    return {
      name: "SDK examples type-check",
      passed: false,
      skipped: true,
      total: 0,
      failures: ["tsc not available in packages/sdk (run: cd packages/sdk && bun install)"],
    };
  }

  try {
    execSync("npx tsc --noEmit", { cwd: SDK_DIR, stdio: "pipe", timeout: 120_000 });
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    const output = [e.stdout?.toString(), e.stderr?.toString()].filter(Boolean).join("\n");
    const errorLines = output
      .split("\n")
      .filter((l) => l.includes("error TS"))
      .slice(0, 20);
    failures.push(...(errorLines.length > 0 ? errorLines : [`tsc exited with code ${e.status}`]));
  }

  return { name: "SDK examples type-check", passed: failures.length === 0, skipped: false, total: 1, failures };
}

// ---------------------------------------------------------------------------
// Check 3 — prebuild:examples produces .js for every source .ts
// ---------------------------------------------------------------------------

async function checkPrebuild(): Promise<CheckResult> {
  const failures: string[] = [];

  const examplesDir = path.join(SDK_DIR, "examples");
  const tsFiles = await glob("**/*.ts", { cwd: examplesDir });

  if (tsFiles.length === 0) {
    return {
      name: "Prebuild transpilation",
      passed: false,
      skipped: false,
      total: 1,
      failures: ["No .ts files found in packages/sdk/examples/"],
    };
  }

  const outDir = path.join(SDK_DIR, "dist", "examples");
  const tscArgs = [
    "tsc",
    "--noCheck", "--noResolve", "--skipLibCheck",
    "--module", "ESNext",
    "--target", "ESNext",
    "--rootDir", examplesDir,
    "--outDir", outDir,
    ...tsFiles.map((f) => path.join(examplesDir, f)),
  ];

  try {
    execFileSync("npx", tscArgs, { cwd: DOCS_DIR, stdio: "pipe", timeout: 60_000 });
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    const output = [e.stdout?.toString(), e.stderr?.toString()].filter(Boolean).join("\n").slice(0, 500);
    return {
      name: "Prebuild transpilation",
      passed: false,
      skipped: false,
      total: 1,
      failures: [`prebuild:examples failed:\n${output}`],
    };
  }

  let total = 0;
  for (const tsFile of tsFiles) {
    total++;
    const jsFile = tsFile.replace(/\.ts$/, ".js");
    try {
      await fs.access(path.join(outDir, jsFile));
    } catch {
      failures.push(`no compiled output for examples/${tsFile} (expected dist/examples/${jsFile})`);
    }
  }

  return { name: "Prebuild transpilation", passed: failures.length === 0, skipped: false, total, failures };
}

// ---------------------------------------------------------------------------
// Check 4 — inline TS/JS code blocks parse without syntax errors
// ---------------------------------------------------------------------------

const MIN_LINES = 3;
const DIFF_REMOVE_RE = /\/\/\s*\[!code\s*--\]/;
const DIFF_ADD_RE = /\/\/\s*\[!code\s*\+\+\]/;
const DIFF_HIGHLIGHT_RE = /\/\/\s*\[!code\s*(highlight|focus|warning|error)\]/;

function preprocessBlock(lines: string[]): string[] {
  return lines
    .filter((l) => !DIFF_REMOVE_RE.test(l))
    .map((l) => l.replace(DIFF_ADD_RE, "").replace(DIFF_HIGHLIGHT_RE, ""));
}

function shouldSkip(lines: string[]): boolean {
  if (lines.length < MIN_LINES) return true;
  if (lines.some((l) => l.includes("\u2014"))) return true; // em dash — pseudo-code
  if (lines.some((l) => /\.\.\.(?!\s*\w)/.test(l))) return true; // placeholder ellipsis (not spread)
  const firstCode = lines.find((l) => l.trim() && !l.trim().startsWith("//"));
  if (firstCode && firstCode.trim() === "{") return true; // bare object literal (data shape)
  return false;
}

function extractInlineBlocks(content: string, filePath: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = content.split("\n");
  let inside = false;
  let lang = "";
  let body: string[] = [];
  let startLine = 0;
  let isImport = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (!inside) {
      if (line.startsWith("```")) {
        const m = line.match(FENCE_OPEN_RE);
        if (m) {
          inside = true;
          lang = (m[1] || "").toLowerCase();
          isImport = line.includes("file=");
          body = [];
          startLine = i + 1;
        }
      }
    } else if (FENCE_CLOSE_RE.test(line)) {
      if (!isImport && SYNTAX_LANGS.has(lang)) {
        const processed = preprocessBlock(body);
        if (!shouldSkip(processed) && processed.length > 0) {
          blocks.push({ lang, content: processed.join("\n"), file: filePath, line: startLine });
        }
      }
      inside = false;
    } else {
      body.push(line);
    }
  }

  return blocks;
}

function syntaxCheck(block: CodeBlock): string | null {
  const isTS = block.lang === "ts" || block.lang === "typescript";
  const sourceFile = ts.createSourceFile(
    isTS ? "check.tsx" : "check.js",
    block.content,
    ts.ScriptTarget.Latest,
    true,
    isTS ? ts.ScriptKind.TSX : ts.ScriptKind.JS,
  );

  const diags = (sourceFile as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] })
    .parseDiagnostics;

  if (diags && diags.length > 0) {
    const d = diags[0]!;
    const pos = sourceFile.getLineAndCharacterOfPosition(d.start!);
    const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
    return `${block.file}:${block.line + pos.line}: ${msg}`;
  }

  return null;
}

async function checkInlineSyntax(): Promise<CheckResult> {
  const failures: string[] = [];
  let total = 0;

  for (const mdxPath of await findMdxFiles()) {
    const content = await fs.readFile(mdxPath, "utf-8");
    const rel = path.relative(DOCS_DIR, mdxPath);

    for (const block of extractInlineBlocks(content, rel)) {
      total++;
      const err = syntaxCheck(block);
      if (err) failures.push(err);
    }
  }

  return { name: "Inline code block syntax", passed: failures.length === 0, skipped: false, total, failures };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Docs Code Examples Test ===\n");

  const checks = [checkFileReferences, checkSdkTypecheck, checkPrebuild, checkInlineSyntax];
  const results: CheckResult[] = [];

  for (let i = 0; i < checks.length; i++) {
    const result = await checks[i]!();
    results.push(result);

    console.log(`--- Check ${i + 1}: ${result.name} ---`);

    if (result.skipped) {
      console.log(`  SKIP  ${result.failures[0] ?? "skipped"}\n`);
    } else if (result.passed) {
      console.log(`  PASS  ${result.total} checked\n`);
    } else {
      console.log(`  FAIL  ${result.failures.length} failure(s) / ${result.total} checked`);
      for (const f of result.failures) {
        console.log(`    - ${f}`);
      }
      console.log();
    }
  }

  const ran = results.filter((r) => !r.skipped);
  const passed = ran.filter((r) => r.passed).length;
  const skipped = results.filter((r) => r.skipped).length;
  const skipNote = skipped > 0 ? `, ${skipped} skipped` : "";
  console.log(`=== Summary: ${passed}/${ran.length} checks passed${skipNote} ===`);

  if (passed < ran.length) process.exit(1);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
