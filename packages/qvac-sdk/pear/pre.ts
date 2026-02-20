/**
 * QVAC Pear Pre-Hook
 *
 * Invoked by Pear before `pear run` or `pear stage` to:
 * 1. Generate `qvac/worker.pear.entry.mjs` with selected plugins
 * 2. Persist `pear.stage.entrypoints` to package.json for routing
 *
 * @example package.json configuration
 * ```json
 * {
 *   "pear": {
 *     "pre": ["@qvac/sdk/pear-pre"]
 *   }
 * }
 * ```
 */

import * as cenc from "compact-encoding";
import pearPipe from "pear-pipe";
import fs from "bare-fs";
import path from "bare-path";

declare const Pear: {
  pipe: { end: () => void };
  exit: () => void;
  config: { applink: string };
};

interface PearConfig {
  name?: string;
  unrouted?: string[];
  stage?: { entrypoints?: string[]; [key: string]: unknown };
  pear?: { [key: string]: unknown };
  [key: string]: unknown;
}

interface QvacConfig {
  plugins?: string[];
  pearWorker?: string;
  [key: string]: unknown;
}

const CONFIG_CANDIDATES = [
  "qvac.config.json",
  "qvac.config.js",
  "qvac.config.mjs",
  "qvac.config.ts",
];

const BUILTIN_PLUGINS = [
  "@qvac/sdk/llamacpp-completion/plugin",
  "@qvac/sdk/llamacpp-embedding/plugin",
  "@qvac/sdk/whispercpp-transcription/plugin",
  "@qvac/sdk/nmtcpp-translation/plugin",
  "@qvac/sdk/onnx-tts/plugin",
  "@qvac/sdk/onnx-ocr/plugin",
];

const BUILTIN_PLUGIN_EXPORTS: Record<string, string> = {
  "llamacpp-completion": "llmPlugin",
  "llamacpp-embedding": "embeddingsPlugin",
  "whispercpp-transcription": "whisperPlugin",
  "nmtcpp-translation": "nmtPlugin",
  "onnx-tts": "ttsPlugin",
  "onnx-ocr": "ocrPlugin",
};

const SDK_NAME = "@qvac/sdk";
const DEFAULT_PEAR_WORKER = "worker.js";
const PEAR_WORKER_ENTRY_PATH = "qvac/worker.pear.entry.mjs";
const LOG_PREFIX = "[qvac/pear-pre]";

/** Normalize path to Pear config format (POSIX-style, leading slash) */
function toPearConfigPath(pathFromAppRoot: string): string {
  let p = String(pathFromAppRoot).replaceAll("\\", "/");
  if (p.startsWith("./")) p = p.slice(2);
  if (!p.startsWith("/")) p = `/${p}`;
  return p.replaceAll("/./", "/").replace(/\/{2,}/g, "/");
}

function toPosixPath(p: string): string {
  return String(p).replaceAll("\\", "/");
}

function pathToFileUrl(absPath: string): string {
  let p = toPosixPath(absPath);

  // Windows drive letter paths need a leading slash in file:// URLs.
  if (/^[A-Za-z]:\//.test(p)) p = `/${p}`;
  if (!p.startsWith("/")) p = `/${p}`;

  const segments = p.split("/");
  const encoded = segments
    .map((seg, idx) => {
      if (idx === 0) return "";
      // Preserve "C:" drive segment in Windows file URLs (file:///C:/...)
      if (idx === 1 && /^[A-Za-z]:$/.test(seg)) return seg;
      return encodeURIComponent(seg);
    })
    .join("/");

  return `file://${encoded}`;
}

function detectJsonIndent(raw: string): string | number {
  const match = raw.match(/\n([ \t]+)"/);
  if (match?.[1]) return match[1];
  return 2;
}

function detectJsonNewline(raw: string): "\n" | "\r\n" {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

function ensureObjectProp(
  obj: Record<string, unknown>,
  prop: string
): Record<string, unknown> {
  const existing = obj[prop];
  if (existing === undefined) {
    const created: Record<string, unknown> = {};
    obj[prop] = created;
    return created;
  }
  if (typeof existing === "object" && existing && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  throw new Error(`package.json "${prop}" must be an object`);
}

function normalizeStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.length ? [value] : [];
  if (Array.isArray(value)) return uniqStrings(value);
  throw new Error("Expected an array of strings");
}

function atomicWriteFileSync(targetPath: string, content: string): void {
  const tmpPath = `${targetPath}.qvac-pre.tmp`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, targetPath);
}

function normalizePearWorkerPath(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_PEAR_WORKER;
  let p = value.trim();
  if (!p) return DEFAULT_PEAR_WORKER;

  p = toPosixPath(p);
  if (/^[A-Za-z]:\//.test(p)) {
    throw new Error(
      `"pearWorker" must be a path inside the app root (got absolute path: ${JSON.stringify(
        value
      )})`
    );
  }
  if (p.startsWith("./")) p = p.slice(2);
  while (p.startsWith("/")) p = p.slice(1);

  if (!p) return DEFAULT_PEAR_WORKER;
  if (p === "." || p === ".." || p.startsWith("../") || p.includes("/../")) {
    throw new Error(
      `"pearWorker" must be a path inside the app root (got: ${JSON.stringify(
        value
      )})`
    );
  }
  return p;
}

/**
 * Converts an absolute path to a relative ESM import specifier, using POSIX separators.
 */
function toRelativeImportSpecifier(fromDir: string, targetPath: string): string {
  let rel = path.relative(fromDir, targetPath);
  rel = toPosixPath(rel);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/** Extract unique strings from an array, preserving order */
function uniqStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (typeof v === "string" && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Ensure array contains required values, returning new array and change flag */
function ensureArrayIncludes(
  existing: string[],
  required: string[]
): { next: string[]; changed: boolean } {
  const next = [...existing];
  const set = new Set(existing);
  let changed = false;
  for (const v of required) {
    if (!set.has(v)) {
      set.add(v);
      next.push(v);
      changed = true;
    }
  }
  return { next, changed };
}

/**
 * Persist pear.stage.entrypoints to package.json.
 *
 * Required because workers are spawned with --no-pre, bypassing dynamic config.
 * pear-state merges stage.entrypoints into unrouted automatically.
 */
function persistStageEntrypointsToPackageJson(
  appRoot: string,
  requiredEntrypoints: string[]
): void {
  const packageJsonPath = path.join(appRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found at ${packageJsonPath}`);
  }

  const raw = fs.readFileSync(packageJsonPath, "utf8") as string;
  const newline = detectJsonNewline(raw);
  const indent = detectJsonIndent(raw);
  const hasFinalNewline = raw.endsWith("\n") || raw.endsWith("\r\n");

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to parse ${packageJsonPath}: ${String(err)}`);
  }
  const pear = ensureObjectProp(pkg, "pear");
  const stage = ensureObjectProp(pear, "stage");

  const existing = normalizeStringArray(stage["entrypoints"]);
  const required = uniqStrings(requiredEntrypoints);
  const { next, changed } = ensureArrayIncludes(existing, required);

  if (!changed) return;

  stage["entrypoints"] = next;

  let nextRaw = JSON.stringify(pkg, null, indent);
  if (newline === "\r\n") nextRaw = nextRaw.replaceAll("\n", "\r\n");
  if (hasFinalNewline) nextRaw += newline;
  atomicWriteFileSync(packageJsonPath, nextRaw);
}

/** Extract app root directory from Pear's applink */
function getAppRoot(): string {
  const applink = Pear.config?.applink;
  if (typeof applink !== "string" || applink.length === 0) {
    throw new Error("Pear.config.applink is not available");
  }

  // Pear provides a file:// URL to the application root.
  let pathname: string;
  let url: URL;
  try {
    url = new URL(applink);
  } catch {
    // Some environments may provide a plain filesystem path instead of a URL.
    return path.normalize(applink);
  }
  if (url.protocol !== "file:") {
    throw new Error(
      `Expected Pear.config.applink to be a file:// URL (got: ${applink})`
    );
  }
  pathname = url.pathname;

  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // If decoding fails, keep the raw pathname.
  }

  // Handle Windows paths (e.g., /C:/path)
  if (pathname[0] === "/" && pathname[2] === ":") {
    pathname = pathname.slice(1);
  }

  return path.normalize(pathname);
}

/** Find the first existing qvac config file */
function findConfigFile(appRoot: string): string | null {
  for (const candidate of CONFIG_CANDIDATES) {
    const configPath = path.join(appRoot, candidate);
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }
  return null;
}

/** Load and parse a qvac config file */
async function loadConfig(configPath: string): Promise<QvacConfig> {
  const ext = path.extname(configPath).toLowerCase();

  if (ext === ".json") {
    const content = fs.readFileSync(configPath, "utf8") as string;
    try {
      return JSON.parse(content) as QvacConfig;
    } catch (err) {
      throw new Error(`Failed to parse ${configPath}: ${String(err)}`);
    }
  }

  if (ext === ".js" || ext === ".mjs") {
    const module = (await import(pathToFileUrl(configPath))) as {
      default?: QvacConfig;
    } & QvacConfig;
    return module.default ?? module;
  }

  if (ext === ".ts") {
    throw new Error(
      "TypeScript config not supported in Pear pre-hook. Use qvac.config.json or qvac.config.mjs."
    );
  }

  throw new Error(`Unsupported config format: ${ext}. Use .json, .js, or .mjs`);
}

/** Discover and load qvac config, returning null if not found */
async function discoverConfig(
  appRoot: string
): Promise<{ config: QvacConfig | null; configFile: string | null }> {
  const configPath = findConfigFile(appRoot);

  if (!configPath) {
    return { config: null, configFile: null };
  }

  const config = await loadConfig(configPath);
  return { config, configFile: path.basename(configPath) };
}

/** Resolve plugin set from config or default to all built-in plugins */
function resolvePlugins(config: QvacConfig | null): string[] {
  const fromConfig = uniqStrings(config?.plugins);
  if (fromConfig.length) return fromConfig;
  return [...BUILTIN_PLUGINS];
}

/** Parse SDK builtin plugin specifier to extract export info */
function parseBuiltinSpecifier(
  specifier: string
): { suffix: string; exportName: string } | null {
  const prefix = `${SDK_NAME}/`;
  const pluginSuffix = "/plugin";

  if (specifier.startsWith(prefix) && specifier.endsWith(pluginSuffix)) {
    const middle = specifier.slice(prefix.length, -pluginSuffix.length);
    const exportName = BUILTIN_PLUGIN_EXPORTS[middle];
    if (!middle.includes("/") && exportName) {
      return { suffix: middle, exportName };
    }
  }

  return null;
}

/** Generate the Pear worker entry file content */
function generatePearWorkerEntry(plugins: string[], appWorkerPath: string): string {
  const imports: string[] = [];
  const registrations: string[] = [];
  let varIndex = 0;

  for (const specifier of plugins) {
    const builtin = parseBuiltinSpecifier(specifier);
    if (builtin) {
      imports.push(
        `import { ${builtin.exportName} } from "${SDK_NAME}/${builtin.suffix}/plugin";`
      );
      registrations.push(`registerPlugin(${builtin.exportName});`);
    } else {
      const varName = `customPlugin${varIndex++}`;
      imports.push(`import ${varName} from "${specifier}";`);
      registrations.push(`registerPlugin(${varName});`);
    }
  }

  const pluginsList = plugins.map((p) => `*   - ${p}`).join("\n");

  return `/**
 * QVAC Pear Worker Entry (auto-generated)
 * Plugins: ${plugins.length}
 *
${pluginsList}
 */

import { registerPlugin } from "${SDK_NAME}/plugins";

${imports.join("\n")}

${registrations.join("\n")}

await import(${JSON.stringify(appWorkerPath)});
`;
}

/** Write worker entry file if content changed (idempotent) */
function writeWorkerEntryIfChanged(appRoot: string, content: string): boolean {
  const outputDir = path.join(appRoot, "qvac");
  const entryPath = path.join(appRoot, PEAR_WORKER_ENTRY_PATH);

  if (fs.existsSync(entryPath)) {
    try {
      if ((fs.readFileSync(entryPath, "utf8") as string) === content) {
        return false;
      }
    } catch {
      // Will rewrite on error
    }
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  atomicWriteFileSync(entryPath, content);
  return true;
}

/** Main configuration handler */
async function configure(options: PearConfig): Promise<PearConfig> {
  const appRoot = getAppRoot();
  const { config: qvacConfig } = await discoverConfig(appRoot);

  const plugins = resolvePlugins(qvacConfig);
  const pearWorker = normalizePearWorkerPath(qvacConfig?.pearWorker);

  // Validate worker file exists
  const workerAbs = path.join(appRoot, pearWorker);
  if (!fs.existsSync(workerAbs)) {
    const hint = qvacConfig?.pearWorker
      ? `"${String(qvacConfig.pearWorker)}" (resolved to ${workerAbs})`
      : `"${DEFAULT_PEAR_WORKER}". Set "pearWorker" in qvac.config.json to specify your worker path.`;
    throw new Error(`Worker file not found: ${hint}`);
  }

  // Generate worker entry with relative import path from qvac/ directory
  const outputDir = path.join(appRoot, "qvac");
  const appWorkerImport = toRelativeImportSpecifier(outputDir, workerAbs);

  const workerEntryContent = generatePearWorkerEntry(plugins, appWorkerImport);
  writeWorkerEntryIfChanged(appRoot, workerEntryContent);

  // Persist entrypoint to package.json for worker routing
  const workerEntryPath = toPearConfigPath(PEAR_WORKER_ENTRY_PATH);
  persistStageEntrypointsToPackageJson(appRoot, [workerEntryPath]);

  return options;
}

// IPC Protocol
const pipe = pearPipe();

if (!pipe) {
  console.error(`${LOG_PREFIX} No IPC pipe available`);
  process.exit(1);
}

pipe.autoexit = true;

let exitCode = 0;

pipe.on("end", () => {
  try {
    Pear.pipe.end();
  } finally {
    if (exitCode !== 0) process.exit(exitCode);
  }
});

pipe.once("error", (err: Error) => {
  exitCode = exitCode || 1;
  console.error(LOG_PREFIX, err);
});

pipe.once("data", (data: unknown) => {
  void (async () => {
    let options: PearConfig | null = null;
    try {
      options = cenc.decode(cenc.any, data as Buffer) as PearConfig;
    } catch (err) {
      exitCode = 1;
      console.error(LOG_PREFIX, err);
      try {
        pipe.end(cenc.encode(cenc.any, { tag: "configure", data: {} }));
      } catch {
        pipe.destroy(err as Error);
      }
      return;
    }

    try {
      const config = await configure(options);
      pipe.end(cenc.encode(cenc.any, { tag: "configure", data: config }));
    } catch (err) {
      exitCode = 1;
      console.error(LOG_PREFIX, err);
      try {
        pipe.end(cenc.encode(cenc.any, { tag: "configure", data: options }));
      } catch {
        pipe.destroy(err as Error);
      }
    }
  })();
});
