/**
 * TSDoc completeness audit for SDK exported functions.
 *
 * Checks every exported function for:
 *   - @param tags covering all parameters
 *   - @returns tag (skipped for void / Promise<void>)
 *   - @throws tag when the function body contains throw statements
 *
 * Standalone:  bun run scripts/api-docs/audit-tsdoc.ts [--strict]
 * Programmatic: import { auditTsDoc, bootstrapProject } from "./audit-tsdoc.js"
 */

import { readFileSync } from "node:fs";
import * as path from "path";
import ts from "typescript";
import { Application, ReflectionKind } from "typedoc";
import type {
  DeclarationReflection,
  SignatureReflection,
  ProjectReflection,
} from "typedoc";
import type { AuditDiagnostic, AuditOptions, AuditResult } from "./types.js";

// ---------------------------------------------------------------------------
// TypeDoc bootstrap (shared by CLI + tests)
// ---------------------------------------------------------------------------

export async function bootstrapProject(
  sdkPath: string,
): Promise<ProjectReflection> {
  const entryPoint = path.join(sdkPath, "index.ts").replace(/\\/g, "/");
  const tsconfigPath = path.join(sdkPath, "tsconfig.json").replace(/\\/g, "/");

  const app = await Application.bootstrapWithPlugins({
    entryPoints: [entryPoint],
    tsconfig: tsconfigPath,
    excludePrivate: true,
    excludeProtected: true,
    excludeExternals: true,
    skipErrorChecking: true,
  });

  const project = await app.convert();
  if (!project) throw new Error("TypeDoc failed to convert project");
  return project;
}

// ---------------------------------------------------------------------------
// Core audit
// ---------------------------------------------------------------------------

export async function auditTsDoc(
  project: ProjectReflection,
  _sdkPath: string,
  options: AuditOptions = {},
): Promise<AuditResult> {
  const allFunctions = project.getReflectionsByKind(
    ReflectionKind.Function,
  ) as DeclarationReflection[];

  const diagnostics: AuditDiagnostic[] = [];

  for (const decl of allFunctions) {
    const sig = (decl.signatures?.[0] ??
      decl.children?.find(
        (c: any) => c.kind === ReflectionKind.CallSignature,
      )) as SignatureReflection | undefined;
    if (!sig) continue;

    const sourcePath = (decl.sources?.[0]?.fullFileName ??
      (decl as any).sources?.[0]?.file?.fullFileName ??
      "") as string;
    const normalizedPath = sourcePath.replace(/\\/g, "/");
    if (
      normalizedPath &&
      (normalizedPath.includes("/server/") ||
        normalizedPath.includes("/examples/"))
    )
      continue;

    const comment = decl.comment ?? (sig as any).comment;
    const blockTags =
      comment?.blockTags ?? (sig as any).comment?.blockTags ?? [];

    const params: any[] = (sig as any).parameters || [];
    const missingParams: string[] = [];
    for (const p of params) {
      if (!commentText(p.comment?.summary)) missingParams.push(p.name);
    }

    const retType = (sig as any).type;
    const hasReturnsDoc =
      blockTags.some((t: any) => t.tag === "@returns") ||
      !!commentText((comment as any)?.returns);
    const missingReturns = !isVoidReturn(retType) && !hasReturnsDoc;

    const hasThrowsDoc = blockTags.some((t: any) => t.tag === "@throws");
    const bodyHasThrow = sourcePath
      ? detectThrow(sourcePath, decl.name)
      : false;
    const missingThrows = bodyHasThrow && !hasThrowsDoc;

    diagnostics.push({
      functionName: decl.name,
      missingParams,
      missingReturns,
      missingThrows,
      bodyHasThrow,
    });
  }

  diagnostics.sort((a, b) => a.functionName.localeCompare(b.functionName));

  const complete = diagnostics.filter(
    (d) =>
      d.missingParams.length === 0 && !d.missingReturns && !d.missingThrows,
  ).length;

  const result: AuditResult = {
    diagnostics,
    total: diagnostics.length,
    complete,
    completenessPercent:
      diagnostics.length > 0
        ? Math.round((complete / diagnostics.length) * 1000) / 10
        : 100,
  };

  if (!options.quiet) printTable(result);

  return result;
}

// ---------------------------------------------------------------------------
// Table output
// ---------------------------------------------------------------------------

function printTable(result: AuditResult): void {
  const { diagnostics, total, complete, completenessPercent } = result;
  const nameWidth = Math.max(
    "Function".length,
    ...diagnostics.map((d) => d.functionName.length),
  );
  const col = 10;
  const lineWidth = nameWidth + 2 + col * 3 + 6;

  console.log("");
  console.log("TSDoc Completeness Audit");
  console.log("=".repeat(lineWidth));
  console.log(
    "Function".padEnd(nameWidth) +
      "  " +
      "@param".padEnd(col) +
      "@returns".padEnd(col) +
      "@throws".padEnd(col) +
      "Status",
  );
  console.log("-".repeat(lineWidth));

  for (const d of diagnostics) {
    const paramOk = d.missingParams.length === 0;
    const isPass = paramOk && !d.missingReturns && !d.missingThrows;

    console.log(
      d.functionName.padEnd(nameWidth) +
        "  " +
        (paramOk ? "OK" : "MISSING").padEnd(col) +
        (d.missingReturns ? "MISSING" : "OK").padEnd(col) +
        (d.bodyHasThrow
          ? d.missingThrows
            ? "MISSING"
            : "OK"
          : "n/a"
        ).padEnd(col) +
        (isPass ? "PASS" : "WARN"),
    );
  }

  console.log("=".repeat(lineWidth));
  console.log(
    `Total: ${total} functions | ${complete} complete | ` +
      `${total - complete} with gaps | ${completenessPercent}% complete`,
  );

  const gaps = diagnostics.filter(
    (d) => d.missingParams.length > 0 || d.missingReturns || d.missingThrows,
  );
  if (gaps.length > 0) {
    console.log("");
    console.log("Details:");
    for (const d of gaps) {
      const issues: string[] = [];
      if (d.missingParams.length > 0)
        issues.push(`@param missing: ${d.missingParams.join(", ")}`);
      if (d.missingReturns) issues.push("@returns missing");
      if (d.missingThrows) issues.push("@throws missing (body has throw)");
      console.log(`  ${d.functionName}: ${issues.join("; ")}`);
    }
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Throw detection via TypeScript compiler API
// ---------------------------------------------------------------------------

const sourceFileCache = new Map<string, ts.SourceFile>();

function detectThrow(filePath: string, functionName: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  let sf = sourceFileCache.get(normalized);
  if (!sf) {
    try {
      const content = readFileSync(filePath, "utf-8");
      sf = ts.createSourceFile(
        normalized,
        content,
        ts.ScriptTarget.Latest,
        true,
      );
      sourceFileCache.set(normalized, sf);
    } catch {
      return false;
    }
  }

  let body: ts.Node | undefined;

  ts.forEachChild(sf, (node) => {
    if (body) return;

    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      body = node.body;
      return;
    }

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === functionName &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) ||
            ts.isFunctionExpression(decl.initializer))
        ) {
          body = decl.initializer.body;
        }
      }
    }
  });

  if (!body) return false;
  return walkForThrow(body);
}

function walkForThrow(node: ts.Node): boolean {
  if (ts.isThrowStatement(node)) return true;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  )
    return false;
  return ts.forEachChild(node, walkForThrow) ?? false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function commentText(nodes: any): string {
  if (!nodes) return "";
  if (Array.isArray(nodes)) return nodes.map((n: any) => n.text || "").join("");
  return nodes.text || "";
}

function isVoidReturn(type: any): boolean {
  if (!type) return true;
  if (type.type === "intrinsic" && type.name === "void") return true;
  if (type.type === "reference" && type.name === "Promise") {
    const args = type.typeArguments ?? [];
    return (
      args.length === 1 &&
      args[0]?.type === "intrinsic" &&
      args[0]?.name === "void"
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain = process.argv[1]
  ?.replace(/\\/g, "/")
  .endsWith("/audit-tsdoc.ts");

if (isMain) {
  const strict = process.argv.includes("--strict");
  const sdkPath = path.resolve(
    process.env.SDK_PATH ||
      path.join(process.cwd(), "..", "..", "packages", "sdk"),
  );

  console.log(`Auditing TSDoc for SDK at: ${sdkPath}`);
  const project = await bootstrapProject(sdkPath);
  const result = await auditTsDoc(project, sdkPath);

  if (strict && result.complete < result.total) {
    console.error(
      `\nStrict mode: ${result.total - result.complete} function(s) have TSDoc gaps. Failing.`,
    );
    process.exit(1);
  }
}
