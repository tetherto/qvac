// ESM script to rewrite TS path aliases (e.g. "@/..." ) to relative paths in dist
// Run after `tsc` emits JS. Uses `tsconfig.json` paths + outDir to compute targets.

import { promises as fsp } from "fs";
import fs from "fs";
import path from "path";
import ts from "typescript";

const projectRoot = process.cwd();

async function readTsConfigJson(filePath) {
  const result = ts.readConfigFile(filePath, (p) => fs.readFileSync(p, "utf8"));
  if (result.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(result.error.messageText, "\n"),
    );
  }
  return result.config;
}

function normalizeToPosix(p) {
  return p.split(path.sep).join("/");
}

function ensureDotSlash(p) {
  if (!p.startsWith(".") && !p.startsWith("/")) return `./${p}`;
  return p;
}

function fileExists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function* walk(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else {
      yield fullPath;
    }
  }
}

function matchPathMapping(specifier, pathsMap) {
  // Return array of candidate source paths (relative to tsconfig baseUrl)
  // Try exact keys first, then wildcard matches in insertion order
  if (Object.prototype.hasOwnProperty.call(pathsMap, specifier)) {
    return pathsMap[specifier];
  }
  const candidates = [];
  for (const [key, targets] of Object.entries(pathsMap)) {
    if (!key.includes("*")) continue;
    // Convert key like '@/*' to regex
    const [prefix, suffix] = key.split("*");
    if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
      const middle = specifier.slice(
        prefix.length,
        specifier.length - suffix.length,
      );
      for (const target of targets) {
        candidates.push(target.replaceAll("*", middle));
      }
    }
  }
  return candidates.length > 0 ? candidates : null;
}

function toJsCandidate(distRoot, sourceRel, targetExtension = ".js") {
  // sourceRel is like './server/rpc' or './index.ts'
  let withoutDot = sourceRel.startsWith("./") ? sourceRel.slice(2) : sourceRel;
  let distCandidate = path.join(distRoot, withoutDot);

  const tryFiles = [];
  if (distCandidate.endsWith(".ts") || distCandidate.endsWith(".tsx")) {
    const replacement = targetExtension === ".d.ts" ? ".d.ts" : ".js";
    tryFiles.push(distCandidate.replace(/\.(ts|tsx)$/i, replacement));
  } else {
    tryFiles.push(`${distCandidate}${targetExtension}`);
  }

  const indexFile = targetExtension === ".d.ts" ? "index.d.ts" : "index.js";
  tryFiles.push(path.join(distCandidate, indexFile));

  for (const f of tryFiles) {
    if (fileExists(f)) return f;
  }

  // Special handling for directory imports - if distCandidate is a directory with an index file
  if (dirExists(distCandidate)) {
    const indexPath = path.join(distCandidate, indexFile);
    if (fileExists(indexPath)) {
      return indexPath;
    }
  }

  // Fallback to first candidate even if not exists
  return tryFiles[0];
}

function resolveAliasToRelative(specifier, fromFile, cfg) {
  const { baseUrl, outDir, paths } = cfg;
  const distRoot = path.resolve(projectRoot, outDir);
  const targetExtension = fromFile.endsWith(".d.ts") ? ".d.ts" : ".js";

  // Try tsconfig paths mapping
  if (paths) {
    const mapped = matchPathMapping(specifier, paths);
    if (mapped && mapped.length > 0) {
      const candidates = mapped.map((m) =>
        toJsCandidate(distRoot, m, targetExtension),
      );
      const target = candidates.find((c) => fileExists(c)) || candidates[0];
      let rel = path.relative(path.dirname(fromFile), target);
      // For .d.ts files, remove the .d.ts extension from the relative path
      if (fromFile.endsWith(".d.ts") && rel.endsWith(".d.ts")) {
        rel = rel.slice(0, -5); // Remove ".d.ts"
      }
      return ensureDotSlash(normalizeToPosix(rel));
    }
  }

  // Generic '@/foo/bar' -> 'dist/foo/bar(.js|/index.js)'
  const stripped = specifier.replace(/^@\//, "");
  const target = toJsCandidate(distRoot, `./${stripped}`, targetExtension);
  let rel = path.relative(path.dirname(fromFile), target);
  // For .d.ts files, remove the .d.ts extension from the relative path
  if (fromFile.endsWith(".d.ts") && rel.endsWith(".d.ts")) {
    rel = rel.slice(0, -5); // Remove ".d.ts"
  }
  return ensureDotSlash(normalizeToPosix(rel));
}

function fixDirectoryImports(code, filePath, cfg) {
  const { outDir } = cfg;
  const distRoot = path.resolve(projectRoot, outDir);
  const targetExtension = filePath.endsWith(".d.ts") ? ".d.ts" : ".js";

  // Fix static imports that don't have .js extension
  let updated = code.replace(
    /(from\s*["'])(\.\/[^"']*?)(?<!\.js|\.d\.ts)(["'])/g,
    (match, prefix, importPath, suffix) => {
      const resolvedPath = path.resolve(path.dirname(filePath), importPath);
      const indexFile = targetExtension === ".d.ts" ? "index.d.ts" : "index.js";

      // Check if this is a directory with an index file
      if (
        dirExists(resolvedPath) &&
        fileExists(path.join(resolvedPath, indexFile))
      ) {
        const extension = targetExtension === ".d.ts" ? "" : ".js";
        return `${prefix}${importPath}/index${extension}${suffix}`;
      }

      // Check if this is a file that needs .js extension
      const fileWithJs = `${resolvedPath}.js`;
      const fileWithDts = `${resolvedPath}.d.ts`;
      if (fileExists(fileWithJs) || fileExists(fileWithDts)) {
        const extension = targetExtension === ".d.ts" ? "" : ".js";
        return `${prefix}${importPath}${extension}${suffix}`;
      }

      return match;
    },
  );

  // Fix external package sub-path imports that don't have .js extension
  updated = updated.replace(
    /(from\s*["'])(@\w+\/[^\/"']+\/[^"']*?)(?<!\.js|\.d\.ts)(["'])/g,
    (match, prefix, importPath, suffix) => {
      // Add .js extension to external package sub-paths
      const extension = targetExtension === ".d.ts" ? "" : ".js";
      return `${prefix}${importPath}${extension}${suffix}`;
    },
  );

  // Fix dynamic imports that don't have .js extension
  updated = updated.replace(
    /(import\s*\(\s*["'])(\.\/[^"']*?)(?<!\.js|\.d\.ts)(["']\s*\))/g,
    (match, prefix, importPath, suffix) => {
      const resolvedPath = path.resolve(path.dirname(filePath), importPath);
      const indexFile = targetExtension === ".d.ts" ? "index.d.ts" : "index.js";

      // Check if this is a directory with an index file
      if (
        dirExists(resolvedPath) &&
        fileExists(path.join(resolvedPath, indexFile))
      ) {
        const extension = targetExtension === ".d.ts" ? "" : ".js";
        return `${prefix}${importPath}/index${extension}${suffix}`;
      }

      // Check if this is a file that needs .js extension
      const fileWithJs = `${resolvedPath}.js`;
      const fileWithDts = `${resolvedPath}.d.ts`;
      if (fileExists(fileWithJs) || fileExists(fileWithDts)) {
        const extension = targetExtension === ".d.ts" ? "" : ".js";
        return `${prefix}${importPath}${extension}${suffix}`;
      }

      return match;
    },
  );

  // Fix external package sub-path dynamic imports that don't have .js extension
  updated = updated.replace(
    /(import\s*\(\s*["'])(@\w+\/[^\/"']+\/[^"']*?)(?<!\.js|\.d\.ts)(["']\s*\))/g,
    (match, prefix, importPath, suffix) => {
      // Add .js extension to external package sub-paths
      const extension = targetExtension === ".d.ts" ? "" : ".js";
      return `${prefix}${importPath}${extension}${suffix}`;
    },
  );

  return updated;
}

async function processFile(filePath, cfg) {
  const content = await fsp.readFile(filePath, "utf8");
  let updated = content;

  const replaceStaticFrom = (code) =>
    code.replace(/(from\s*["'])(@\/[^"']+)(["'])/g, (m, p1, spec, p3) => {
      const rel = resolveAliasToRelative(spec, filePath, cfg);
      return `${p1}${rel}${p3}`;
    });

  const replaceBareImport = (code) =>
    code.replace(/(^|\n)\s*import\s*["'](@\/[^"']+)["']/g, (m, p0, spec) => {
      const rel = resolveAliasToRelative(spec, filePath, cfg);
      return `${p0}import "${rel}"`;
    });

  const replaceExportFrom = (code) =>
    code.replace(
      /(export\s+[^;]*?from\s*["'])(@\/[^"']+)(["'])/g,
      (m, p1, spec, p3) => {
        const rel = resolveAliasToRelative(spec, filePath, cfg);
        return `${p1}${rel}${p3}`;
      },
    );

  const replaceDynamicImport = (code) =>
    code.replace(
      /(import\s*\(\s*["'])(@\/[^"']+)(["']\s*\))/g,
      (m, p1, spec, p3) => {
        const rel = resolveAliasToRelative(spec, filePath, cfg);
        return `${p1}${rel}${p3}`;
      },
    );

  updated = replaceStaticFrom(updated);
  updated = replaceBareImport(updated);
  updated = replaceExportFrom(updated);
  updated = replaceDynamicImport(updated);

  // Fix directory imports
  updated = fixDirectoryImports(updated, filePath, cfg);

  if (updated !== content) {
    await fsp.writeFile(filePath, updated, "utf8");
  }
}

async function main() {
  const tsconfigPath = path.join(projectRoot, "tsconfig.json");
  const tsconfig = await readTsConfigJson(tsconfigPath);
  const compilerOptions = tsconfig.compilerOptions || {};
  const outDir = compilerOptions.outDir || "dist";
  const baseUrl = compilerOptions.baseUrl || ".";
  const paths = compilerOptions.paths || {};

  const cfg = { outDir, baseUrl, paths };

  const distDir = path.resolve(projectRoot, outDir);
  if (!dirExists(distDir)) {
    console.error(`Output directory not found: ${distDir}`);
    process.exit(1);
  }

  for await (const file of walk(distDir)) {
    if (/[.](m?js|d\.ts)$/i.test(file)) {
      await processFile(file, cfg);
    }
  }
}

main().catch((err) => {
  console.error("Alias rewrite failed:", err);
  process.exit(1);
});
