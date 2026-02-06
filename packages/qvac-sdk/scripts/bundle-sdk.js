#!/usr/bin/env node
/**
 * QVAC SDK Worker Bundler
 *
 * Generates a custom worker bundle with only the selected plugins.
 *
 * Usage:
 *   npx qvac bundle sdk [options]
 *   node scripts/bundle-sdk.js [options]
 *
 * Options:
 *   --config, -c <path>   Path to config file (default: auto-detect qvac.config.*)
 *   --host <target>       Target host (repeatable, default: all platforms)
 *   --defer <module>      Defer a module (repeatable, for mobile targets)
 *   --dry-run             Preview without bundling
 *   --clean               Delete output directory before bundling
 *   --quiet, -q           Minimal output
 *   --verbose, -v         Detailed output
 *   --help, -h            Show help
 *
 * @see https://docs.qvac.io/plugins for full documentation
 */

import { promises as fsp } from "fs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Built-in plugin registry mapping suffix to export name.
 * Specifier format: `${sdkName}/${suffix}/plugin`
 */
const BUILTIN_PLUGINS = {
  "llamacpp-completion": { exportName: "llmPlugin" },
  "llamacpp-embedding": { exportName: "embeddingsPlugin" },
  "whispercpp-transcription": { exportName: "whisperPlugin" },
  "nmtcpp-translation": { exportName: "nmtPlugin" },
  "onnx-tts": { exportName: "ttsPlugin" },
  "onnx-ocr": { exportName: "ocrPlugin" },
};

const BUILTIN_SUFFIXES = Object.keys(BUILTIN_PLUGINS);

/** Supported bare-pack host targets */
const VALID_HOSTS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
  "android-arm64",
  "ios-arm64",
  "ios-arm64-simulator",
  "ios-x64-simulator",
]);

const DEFAULT_HOSTS = [...VALID_HOSTS];

/** Cached SDK package name */
let cachedSdkName = null;

// Logging utilities
let logLevel = "normal"; // "quiet" | "normal" | "verbose"

function log(message, level = "normal") {
  if (logLevel === "quiet" && level !== "error") return;
  if (level === "verbose" && logLevel !== "verbose") return;
  console.log(message);
}

function logError(message) {
  console.error(message);
}

function pad(str, n) {
  str = String(str);
  return str.length >= n ? str : str + " ".repeat(n - str.length);
}

function fmtBool(b) {
  return b ? "✅" : "—";
}

/**
 * Extracts the packed string from a bare-pack bundle without executing it.
 * Bundle format: `module.exports = "<packed string>";`
 */
function extractPackedString(bundleJsText) {
  const idx = bundleJsText.indexOf("module.exports");
  if (idx === -1) {
    throw new Error("bundle does not contain 'module.exports'");
  }

  const eq = bundleJsText.indexOf("=", idx);
  if (eq === -1) {
    throw new Error("could not find '=' after module.exports");
  }

  let i = eq + 1;
  while (i < bundleJsText.length && /\s/.test(bundleJsText[i])) i++;

  const quote = bundleJsText[i];
  if (quote !== '"' && quote !== "'") {
    throw new Error("export value is not a string literal");
  }
  i++; // past opening quote

  let out = "";
  let esc = false;

  for (; i < bundleJsText.length; i++) {
    const ch = bundleJsText[i];

    if (esc) {
      switch (ch) {
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "v":
          out += "\v";
          break;
        case "\\":
          out += "\\";
          break;
        case '"':
          out += '"';
          break;
        case "'":
          out += "'";
          break;
        case "x": {
          // \xHH
          const hex = bundleJsText.slice(i + 1, i + 3);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error("bad \\x escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 2;
          break;
        }
        case "u": {
          // \uHHHH
          const hex = bundleJsText.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("bad \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          // Keep unknown escapes as-is
          out += ch;
      }
      esc = false;
      continue;
    }

    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === quote) break; // end of string literal

    out += ch;
  }

  if (i >= bundleJsText.length) {
    throw new Error("unterminated string literal");
  }

  return out;
}

/**
 * Parses the header JSON from a bare-pack packed string.
 * Format: `<offset>\n{...header json...}\n...`
 */
function extractBarePackHeaderFromPackedString(packed) {
  const firstNL = packed.indexOf("\n");
  if (firstNL === -1)
    throw new Error("packed string missing first newline separator");

  const jsonStart = packed.indexOf("{", firstNL + 1);
  if (jsonStart === -1)
    throw new Error("could not find header JSON start in packed string");

  let i = jsonStart;
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (; i < packed.length; i++) {
    const ch = packed[i];

    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }

    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        i++; // include closing brace
        break;
      }
    }
  }

  if (depth !== 0)
    throw new Error("unbalanced braces while extracting header JSON");

  return JSON.parse(packed.slice(jsonStart, i));
}

/** Plugin to native addon mapping for tree-shaking verification */
const PLUGIN_TO_ADDON = {
  "llamacpp-completion": { addon: "@qvac/llm-llamacpp" },
  "llamacpp-embedding": { addon: "@qvac/embed-llamacpp" },
  "whispercpp-transcription": { addon: "@qvac/transcription-whispercpp" },
  "nmtcpp-translation": { addon: "@qvac/translation-nmtcpp" },
  "onnx-tts": { addon: "@qvac/tts-onnx" },
  "onnx-ocr": { addon: "@qvac/ocr-onnx" },
};

/**
 * Verifies tree-shaking by inspecting the bare-pack resolutions graph.
 * Checks that only selected plugins and their native addons are included.
 */
async function verifyTreeShaking({ bundlePath, pluginSpecifiers, sdkName }) {
  const selectedBuiltins = new Set();
  const customPlugins = [];

  for (const spec of pluginSpecifiers) {
    const builtin = parseBuiltinSpecifier(spec, sdkName);
    if (builtin) {
      selectedBuiltins.add(builtin.suffix);
    } else {
      const match = spec.match(/^(.+)\/plugin$/);
      if (match) {
        customPlugins.push({ specifier: spec, packageName: match[1] });
      }
    }
  }

  const bundleJsText = await fsp.readFile(bundlePath, "utf8");
  const packed = extractPackedString(bundleJsText);
  const header = extractBarePackHeaderFromPackedString(packed);
  const resolutions = header?.resolutions ?? {};

  const rows = [];
  const offenders = [];
  const missingSelected = [];

  for (const [suffix, info] of Object.entries(PLUGIN_TO_ADDON)) {
    const selected = selectedBuiltins.has(suffix);
    const pluginModuleKeyLocal = `/dist/server/bare/plugins/${suffix}/plugin.js`;
    const pluginModuleKeyNodeModules = `/node_modules/${sdkName}/dist/server/bare/plugins/${suffix}/plugin.js`;
    const pluginResolutions =
      resolutions[pluginModuleKeyNodeModules] ??
      resolutions[pluginModuleKeyLocal];
    const pluginModuleIncluded = !!pluginResolutions;
    const addonReferenced =
      !!pluginResolutions &&
      Object.prototype.hasOwnProperty.call(pluginResolutions, info.addon);

    const bindingKey = `/node_modules/${info.addon}/binding.js`;
    const bindingRes = resolutions[bindingKey];
    const bindingText = bindingRes ? JSON.stringify(bindingRes) : "";
    const nativeHint =
      bindingText.includes("linked:") ||
      bindingText.includes(".framework") ||
      bindingText.includes(".so") ||
      bindingText.includes(".dll") ||
      bindingText.includes(".node");

    if (!selected && (pluginModuleIncluded || addonReferenced)) {
      offenders.push({
        suffix,
        why: [
          pluginModuleIncluded ? "plugin module present" : null,
          addonReferenced ? "addon referenced" : null,
        ]
          .filter(Boolean)
          .join(", "),
      });
    }

    if (selected && (!pluginModuleIncluded || !addonReferenced)) {
      missingSelected.push({
        suffix,
        why: [
          !pluginModuleIncluded ? "plugin module missing" : null,
          pluginModuleIncluded && !addonReferenced
            ? "addon not referenced"
            : null,
        ]
          .filter(Boolean)
          .join(", "),
      });
    }

    rows.push({
      plugin: suffix,
      selected,
      pluginModuleIncluded,
      addonReferenced,
      nativeHint,
    });
  }

  log("\n🔍 Verifying tree-shaking (bundle graph)...");
  const headerLine =
    pad("plugin", 24) +
    pad("selected", 10) +
    pad("pluginMod", 10) +
    pad("addonRef", 9) +
    pad("nativeHint", 11);
  log("   " + headerLine);
  log("   " + "-".repeat(headerLine.length));

  for (const r of rows) {
    log(
      "   " +
        pad(r.plugin, 24) +
        pad(fmtBool(r.selected), 10) +
        pad(fmtBool(r.pluginModuleIncluded), 10) +
        pad(fmtBool(r.addonReferenced), 9) +
        pad(fmtBool(r.nativeHint), 11),
    );
  }

  const selectedList = Array.from(selectedBuiltins).join(", ") || "(none)";
  const excludedList =
    rows
      .filter((r) => !r.selected)
      .map((r) => r.plugin)
      .join(", ") || "(none)";

  for (const m of missingSelected) {
    log(`   ⚠️  ${m.suffix}: selected but not fully detected (${m.why})`);
    log("      (May occur if addon is deferred or path differs)", "verbose");
  }

  if (offenders.length === 0) {
    log(`   📦 Selected: ${selectedList}`);
    log(`   🗑️  Excluded: ${excludedList}`);
  } else {
    log("   ❌ Tree-shaking NOT working (unexpected modules found):");
    for (const o of offenders) {
      log(`      - ${o.suffix}: ${o.why}`);
    }
    log(`   📦 Selected: ${selectedList}`);
  }

  // Verify custom plugins
  if (customPlugins.length > 0) {
    log("\n🔍 Verifying custom plugins (bundle graph)...");
    const customHeaderLine =
      pad("plugin", 28) + pad("inGraph", 10) + pad("inCode", 10);
    log("   " + customHeaderLine);
    log("   " + "-".repeat(customHeaderLine.length));

    const customRows = [];

    for (const { packageName } of customPlugins) {
      const moduleKey = `/node_modules/${packageName}/`;
      const inGraph = Object.keys(resolutions).some((key) =>
        key.includes(moduleKey),
      );

      const inCode = bundleJsText.includes(packageName);
      const included = inGraph || inCode;

      customRows.push({
        packageName,
        inGraph,
        inCode,
        included,
      });

      log(
        "   " +
          pad(packageName, 28) +
          pad(fmtBool(inGraph), 10) +
          pad(fmtBool(inCode), 10),
      );
    }

    const allIncluded = customRows.every((r) => r.included);
    if (allIncluded) {
      log("   ✅ All custom plugins included!");
    } else {
      const missing = customRows
        .filter((r) => !r.included)
        .map((r) => r.packageName);
      log(`   ❌ Missing custom plugins: ${missing.join(", ")}`);
    }
  }
}

/**
 * Generates addons.manifest.json from the bundle's resolutions graph.
 *
 * Scans the bundle header for /node_modules/<pkg>/... entries,
 * checks which packages have "addon": true in their package.json,
 * and writes the allowlist to qvac/addons.manifest.json.
 *
 * This manifest is used by react-native-bare-kit to link only
 * the native addons actually required by the bundle.
 */
async function generateAddonsManifest({ bundlePath, outputDir, projectRoot }) {
  log("\n📦 Generating addons manifest...");

  const bundleJsText = await fsp.readFile(bundlePath, "utf8");
  const packed = extractPackedString(bundleJsText);
  const header = extractBarePackHeaderFromPackedString(packed);
  const resolutions = header?.resolutions ?? {};

  // Extract package names from resolution keys
  const packageNames = new Set();
  const nodeModulesRegex = /\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//;

  for (const key of Object.keys(resolutions)) {
    const match = key.match(nodeModulesRegex);
    if (match) {
      packageNames.add(match[1]);
    }
  }

  // Check which packages have "addon": true
  const addons = [];
  for (const pkgName of packageNames) {
    const pkgJsonPath = path.join(
      projectRoot,
      "node_modules",
      pkgName,
      "package.json",
    );
    try {
      if (fs.existsSync(pkgJsonPath)) {
        const pkgJson = JSON.parse(await fsp.readFile(pkgJsonPath, "utf8"));
        if (pkgJson.addon === true) {
          addons.push(pkgName);
        }
      }
    } catch {
      // Skip packages we can't read
    }
  }

  // Sort for deterministic output
  addons.sort();

  const bundleId =
    typeof header?.id === "string" && header.id.length > 0
      ? header.id
      : "unknown";

  const manifest = {
    version: 1,
    bundleId,
    addons,
  };

  const manifestPath = path.join(outputDir, "addons.manifest.json");
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  log(`   Found ${packageNames.size} packages in bundle graph`);
  log(
    `   Identified ${addons.length} native addons: ${addons.join(", ") || "(none)"}`,
  );
  log(`   Wrote ${manifestPath}`);
}

/** Gets SDK package name from package.json (cached) */
async function getSdkPackageName() {
  if (cachedSdkName) return cachedSdkName;
  const sdkPackageJsonPath = path.join(__dirname, "..", "package.json");
  const sdkPackageJson = JSON.parse(
    await fsp.readFile(sdkPackageJsonPath, "utf8"),
  );
  cachedSdkName = sdkPackageJson.name;
  return cachedSdkName;
}

/** Builds a full built-in plugin specifier: `${sdkName}/${suffix}/plugin` */
function buildBuiltinSpecifier(sdkName, suffix) {
  return `${sdkName}/${suffix}/plugin`;
}

/** Parses a built-in plugin specifier, returns null if not a built-in */
function parseBuiltinSpecifier(specifier, sdkName) {
  const prefix = `${sdkName}/`;
  const pluginSuffix = "/plugin";
  if (specifier.startsWith(prefix) && specifier.endsWith(pluginSuffix)) {
    const middle = specifier.slice(prefix.length, -pluginSuffix.length);
    if (!middle.includes("/") && BUILTIN_PLUGINS[middle]) {
      return { suffix: middle, ...BUILTIN_PLUGINS[middle] };
    }
  }
  return null;
}

/** Parses CLI arguments */
function parseArgs(args) {
  const result = {
    configPath: null,
    hosts: [],
    defer: [],
    help: false,
    dryRun: false,
    clean: false,
    quiet: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--config" || arg === "-c") {
      result.configPath = args[++i];
    } else if (arg === "--host") {
      const host = args[++i];
      if (!VALID_HOSTS.has(host)) {
        console.warn(
          `⚠️  Unknown host "${host}" - may not be supported by bare-pack`,
        );
      }
      result.hosts.push(host);
    } else if (arg === "--defer") {
      result.defer.push(args[++i]);
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--clean") {
      result.clean = true;
    } else if (arg === "--quiet" || arg === "-q") {
      result.quiet = true;
    } else if (arg === "--verbose" || arg === "-v") {
      result.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    }
  }

  if (result.hosts.length === 0) {
    result.hosts = [...DEFAULT_HOSTS];
  }

  return result;
}

function printHelp() {
  const sdkPackageJsonPath = path.join(__dirname, "..", "package.json");
  const sdkPackageJson = JSON.parse(
    fs.readFileSync(sdkPackageJsonPath, "utf8"),
  );
  const sdkName = sdkPackageJson.name;

  const builtinList = BUILTIN_SUFFIXES.map(
    (suffix) => `  - ${sdkName}/${suffix}/plugin`,
  ).join("\n");
  const hostsList = [...VALID_HOSTS].map((h) => `  - ${h}`).join("\n");

  console.log(`
QVAC SDK Worker Bundler

Generates a custom worker bundle with only selected plugins for tree-shaking.

Usage:
  npx qvac bundle sdk [options]
  node scripts/bundle-sdk.js [options]

Options:
  --config, -c <path>   Config file path (default: auto-detect qvac.config.*)
  --host <target>       Target host (repeatable, default: all platforms)
  --defer <module>      Defer a module (repeatable, for mobile targets)
  --dry-run             Preview configuration without bundling
  --clean               Delete qvac/ directory before bundling
  --quiet, -q           Minimal output (errors only)
  --verbose, -v         Detailed output (includes debug info)
  --help, -h            Show this help message

Built-in plugins:
${builtinList}

Supported hosts:
${hostsList}

Examples:
  npx qvac bundle sdk                                       # All platforms
  npx qvac bundle sdk --config my-config.json               # Custom config
  npx qvac bundle sdk --host darwin-arm64 --host ios-arm64  # Specific hosts
  npx qvac bundle sdk --defer expo-file-system              # Defer mobile module
`);
}

const CONFIG_CANDIDATES = [
  "qvac.config.json",
  "qvac.config.js",
  "qvac.config.mjs",
];

/** Finds config file, checking explicit path or auto-detecting */
async function findConfigFile(projectRoot, explicitPath) {
  if (explicitPath) {
    const absPath = path.resolve(projectRoot, explicitPath);
    if (fs.existsSync(absPath)) return absPath;
    throw new Error(`Config file not found: ${explicitPath}`);
  }

  for (const candidate of CONFIG_CANDIDATES) {
    const configPath = path.join(projectRoot, candidate);
    if (fs.existsSync(configPath)) return configPath;
  }

  return null;
}

/** Loads config from file, supports JSON, JS, and TS formats */
async function loadConfig(configPath) {
  if (!configPath) return { plugins: [] };

  const ext = path.extname(configPath).toLowerCase();

  if (ext === ".json") {
    return JSON.parse(await fsp.readFile(configPath, "utf8"));
  }

  if (ext === ".js" || ext === ".mjs") {
    const module = await import(configPath);
    return module.default || module;
  }

  throw new Error(`Unsupported config format: ${ext}. Use .json, .js, or .mjs`);
}

/** Resolves and validates plugin specifiers from config */
function resolvePluginSpecifiers(config, sdkName) {
  const { plugins = [] } = config;

  if (!plugins || plugins.length === 0) {
    log("ℹ️  No plugins specified, including all built-in plugins");
    return BUILTIN_SUFFIXES.map((suffix) =>
      buildBuiltinSpecifier(sdkName, suffix),
    );
  }

  const resolved = [];
  const customPlugins = [];
  const errors = [];

  for (const specifier of plugins) {
    const builtin = parseBuiltinSpecifier(specifier, sdkName);
    if (builtin) {
      resolved.push(specifier);
    } else {
      if (!specifier.endsWith("/plugin")) {
        errors.push(`"${specifier}" must end with /plugin`);
      }
      customPlugins.push(specifier);
    }
  }

  if (errors.length > 0) {
    logError("❌ Invalid plugin specifiers:");
    for (const err of errors) logError(`   - ${err}`);
    process.exit(1);
  }

  if (customPlugins.length > 0) {
    log(`📦 Custom plugins: ${customPlugins.join(", ")}`);
  }

  return [...resolved, ...customPlugins];
}

/** Generates the worker entry file with selected plugins */
function generateWorkerEntry(pluginSpecifiers, sdkName) {
  const imports = [];
  const registrations = [];
  let varIndex = 0;

  for (const specifier of pluginSpecifiers) {
    const builtin = parseBuiltinSpecifier(specifier, sdkName);
    if (builtin) {
      imports.push(
        `import { ${builtin.exportName} } from "${sdkName}/${builtin.suffix}/plugin";`,
      );
      registrations.push(`registerPlugin(${builtin.exportName});`);
    } else {
      const varName = `customPlugin${varIndex++}`;
      imports.push(`import ${varName} from "${specifier}";`);
      registrations.push(`registerPlugin(${varName});`);
    }
  }

  const importsStr = imports.join("\n");
  const registrationsStr = registrations.join("\n");
  const pluginsList = pluginSpecifiers.map((p) => `*   - ${p}`).join("\n");

  return `/**
 * QVAC SDK Worker Entry (auto-generated)
 * Generated by: npx qvac bundle sdk
 * Plugins: ${pluginSpecifiers.length}
 *
${pluginsList}
 */

import { initializeWorkerCore, ensureRPCSetup } from "${sdkName}/dist/server/worker-core.js";
import { registerPlugin } from "${sdkName}/dist/server/plugins/index.js";
import { getServerLogger } from "${sdkName}/dist/logging/index.js";

${importsStr}

const { hasRPCConfig } = initializeWorkerCore();

const logger = getServerLogger();
logger.info("🐻 QVAC Worker (custom bundle)");
logger.info("📦 Plugins: ${pluginSpecifiers.length}");

${registrationsStr}

// Auto-setup RPC if config present
if (hasRPCConfig) {
  ensureRPCSetup();
}
`;
}

/**
 * Generates a Pear worker entry file that:
 * 1) Registers selected plugins (built-in + custom)
 * 2) Then loads the app worker module (dynamic import to preserve ordering)
 */
function generatePearWorkerEntry(pluginSpecifiers, sdkName, appWorkerImport) {
  const imports = [];
  const registrations = [];
  let varIndex = 0;

  for (const specifier of pluginSpecifiers) {
    const builtin = parseBuiltinSpecifier(specifier, sdkName);
    if (builtin) {
      imports.push(
        `import { ${builtin.exportName} } from "${sdkName}/${builtin.suffix}/plugin";`,
      );
      registrations.push(`registerPlugin(${builtin.exportName});`);
    } else {
      const varName = `customPlugin${varIndex++}`;
      imports.push(`import ${varName} from "${specifier}";`);
      registrations.push(`registerPlugin(${varName});`);
    }
  }

  const importsStr = imports.join("\n");
  const registrationsStr = registrations.join("\n");
  const pluginsList = pluginSpecifiers.map((p) => `*   - ${p}`).join("\n");

  return `/**
 * QVAC Pear Worker Entry (auto-generated)
 * Generated by: npx qvac bundle sdk
 * Plugins: ${pluginSpecifiers.length}
 *
${pluginsList}
 */

import { registerPlugin } from "${sdkName}/dist/server/plugins/index.js";

${importsStr}

${registrationsStr}

await import(${JSON.stringify(appWorkerImport)});
`;
}

function toPosixPath(p) {
  return p.replace(/\\\\/g, "/");
}

function toRelativeImportSpecifier(fromDir, targetPath) {
  let rel = path.relative(fromDir, targetPath);
  rel = toPosixPath(rel);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

async function checkBarePackAvailable() {
  return new Promise((resolve) => {
    const proc = spawn("npx", ["bare-pack", "--help"], {
      stdio: "ignore",
      shell: true,
    });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

/**
 * Detects bare-pack major version to determine correct platform flag.
 * - v1.x uses --target
 * - v2.x uses --host
 * Returns major version number, defaults to 2 if detection fails.
 *
 * Note: bare-pack requires an entry file even for --version, so we pass
 * the entry path to avoid MISSING_ARG errors.
 */
async function detectBarePackMajorVersion(entryPath) {
  return new Promise((resolve) => {
    const proc = spawn("npx", ["bare-pack", "--version", entryPath], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: true,
    });

    let output = "";
    proc.stdout.on("data", (data) => {
      output += data.toString();
    });

    proc.on("close", () => {
      const match = output.match(/v?(\d+)\./);
      const majorVersion = match && match[1] ? parseInt(match[1], 10) : 2;
      resolve(majorVersion);
    });

    proc.on("error", () => resolve(2)); // Default to v2 on error
  });
}

/** Runs bare-pack to create the bundle */
async function runBarePack(
  entryPath,
  outputPath,
  hosts,
  importsMapPath,
  deferModules,
) {
  const available = await checkBarePackAvailable();
  if (!available) {
    throw new Error(
      "bare-pack is not installed.\n\n" +
        "  To bundle the SDK, install bare-pack:\n" +
        "    npm install -D bare-pack\n" +
        "    # or: bun add -d bare-pack\n\n" +
        "  Then run: npx qvac bundle sdk",
    );
  }

  // Detect version to use correct platform flag (v1: --target, v2: --host)
  const majorVersion = await detectBarePackMajorVersion(entryPath);
  const platformFlag = majorVersion < 2 ? "--target" : "--host";
  log(
    `📦 Detected bare-pack v${majorVersion} (using ${platformFlag})`,
    "verbose",
  );

  return new Promise((resolve, reject) => {
    const hostArgs = hosts.flatMap((h) => [platformFlag, h]);
    const deferArgs = deferModules.flatMap((m) => ["--defer", m]);
    const args = [
      "bare-pack",
      ...hostArgs,
      "--linked",
      "--imports",
      importsMapPath,
      ...deferArgs,
      "--out",
      outputPath,
      entryPath,
    ];

    log(`\n📦 Running: npx ${args.join(" ")}`, "verbose");

    const proc = spawn("npx", args, {
      stdio: logLevel === "quiet" ? "ignore" : "inherit",
      shell: true,
    });
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`bare-pack exited with code ${code}`)),
    );
    proc.on("error", reject);
  });
}

async function main() {
  const startTime = Date.now();
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Set log level
  if (args.quiet) logLevel = "quiet";
  else if (args.verbose) logLevel = "verbose";

  const projectRoot = process.cwd();
  const outputDir = path.join(projectRoot, "qvac");
  const entryPath = path.join(outputDir, "worker.entry.mjs");
  const bundlePath = path.join(outputDir, "worker.bundle.js");

  log("🔧 QVAC SDK Worker Bundler\n");

  // Find and load config
  const configPath = await findConfigFile(projectRoot, args.configPath);
  log(
    configPath
      ? `📄 Config: ${path.relative(projectRoot, configPath)}`
      : "📄 Config: (none, using defaults)",
  );

  const config = await loadConfig(configPath);
  const sdkName = await getSdkPackageName();
  log(`📦 SDK: ${sdkName}`);

  // Resolve plugin specifiers
  const pluginSpecifiers = resolvePluginSpecifiers(config, sdkName);
  log(`\n📦 Plugins to include (${pluginSpecifiers.length}):`);
  for (const spec of pluginSpecifiers) {
    const label = parseBuiltinSpecifier(spec, sdkName)
      ? "✓ built-in"
      : "⊕ custom";
    log(`   ${label}: ${spec}`);
  }

  // Dry-run mode
  if (args.dryRun) {
    log("\n📋 Dry run - no files written");
    log(`   Output: ${path.relative(projectRoot, bundlePath)}`);
    log(`   Hosts: ${args.hosts.join(", ")}`);
    if (args.defer.length > 0) log(`   Deferred: ${args.defer.join(", ")}`);
    process.exit(0);
  }

  // Clean mode
  if (args.clean && fs.existsSync(outputDir)) {
    log("\n🧹 Cleaning output directory...");
    await fsp.rm(outputDir, { recursive: true });
  }

  // Get previous bundle size for delta comparison
  let previousSize = 0;
  if (fs.existsSync(bundlePath)) {
    previousSize = (await fsp.stat(bundlePath)).size;
  }

  await fsp.mkdir(outputDir, { recursive: true });

  const sdkRoot = path.join(__dirname, "..");

  // Generate worker entry
  log("\n📝 Generating worker entry...");
  const workerEntry = generateWorkerEntry(pluginSpecifiers, sdkName);
  await fsp.writeFile(entryPath, workerEntry, "utf8");
  log(`   Created: ${path.relative(projectRoot, entryPath)}`);

  const pearWorkerEntryPath = path.join(outputDir, "worker.pear.entry.mjs");
  const configAny = config && typeof config === "object" ? config : {};
  const pearWorker =
    typeof configAny.pearWorker === "string" && configAny.pearWorker.length > 0
      ? configAny.pearWorker
      : "worker.js";

  const pearWorkerAbs = path.isAbsolute(pearWorker)
    ? pearWorker
    : path.join(projectRoot, pearWorker);
  const pearWorkerImport = toRelativeImportSpecifier(outputDir, pearWorkerAbs);

  const pearWorkerEntry = generatePearWorkerEntry(
    pluginSpecifiers,
    sdkName,
    pearWorkerImport,
  );
  await fsp.writeFile(pearWorkerEntryPath, pearWorkerEntry, "utf8");
  log(`   Created: ${path.relative(projectRoot, pearWorkerEntryPath)}`);

  // Validate bare-imports.json
  const importsMapPath = path.join(sdkRoot, "bare-imports.json");
  if (!fs.existsSync(importsMapPath)) {
    logError(`\n❌ bare-imports.json not found: ${importsMapPath}`);
    process.exit(1);
  }
  log(`   Using: ${path.relative(projectRoot, importsMapPath)}`);

  // Bundle with bare-pack
  log("\n🔨 Bundling with bare-pack...");
  log(`   Hosts: ${args.hosts.join(", ")}`);
  if (args.defer.length > 0) log(`   Deferred: ${args.defer.join(", ")}`);

  try {
    await runBarePack(
      entryPath,
      bundlePath,
      args.hosts,
      importsMapPath,
      args.defer,
    );

    const stats = await fsp.stat(bundlePath);
    const sizeKB = (stats.size / 1024).toFixed(1);
    log(`\n✅ Bundle created: ${path.relative(projectRoot, bundlePath)}`);
    log(`   Size: ${sizeKB} KB`);

    // Show size delta if previous bundle existed
    if (previousSize > 0) {
      const delta = stats.size - previousSize;
      const deltaKB = (Math.abs(delta) / 1024).toFixed(1);
      const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
      const emoji = delta < 0 ? "📉" : delta > 0 ? "📈" : "➡️";
      log(`   ${emoji} Delta: ${sign}${deltaKB} KB`);
    }
  } catch (error) {
    logError(`\n❌ Bundle failed: ${error.message}`);
    logError("\n💡 Worker entry generated at:");
    logError(`   ${entryPath}`);
    logError("\n   Run bare-pack manually with appropriate options.");
    process.exit(1);
  }

  // Verify tree-shaking
  log("\n🔍 Verifying tree-shaking...");
  await verifyTreeShaking({ bundlePath, pluginSpecifiers, sdkName });

  // Generate addons manifest for native linking
  await generateAddonsManifest({ bundlePath, outputDir, projectRoot });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  log(`\n🎉 Done in ${elapsed}s!\n`);
  log("Generated files:");
  log("  - qvac/worker.entry.mjs    (standalone worker with RPC + lifecycle)");
  log(
    "  - qvac/worker.pear.entry.mjs (Pear worker entrypoint: plugins + app worker)",
  );
  log(
    "  - qvac/worker.bundle.js    (mobile bundle for Expo/React Native BareKit)",
  );
  log("  - qvac/addons.manifest.json\n");
  log("Pear apps: Spawn qvac/worker.pear.entry.mjs as your worker entrypoint");
  log("Mobile: Expo plugin auto-configures worker.bundle.js");
  log("Standalone: Import qvac/worker.entry.mjs for full worker with RPC\n");
}

main().catch((err) => {
  logError(`❌ Error: ${err.message}`);
  if (logLevel === "verbose") console.error(err.stack);
  process.exit(1);
});
