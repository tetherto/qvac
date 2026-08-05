// lib/expo/plugin.ts
import {
  createRunOncePlugin,
  withDangerousMod,
  withRunOnce
} from "@expo/config-plugins";

// lib/react-native-stow.ts
import Bundle from "bare-bundle";
import stow from "bare-stow";
import reactNativeTarget from "bare-stow-target-react-native";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var harnessReactNativeHosts = [...readTargetHosts()];
function createHarnessReactNativeDescriptor() {
  const require2 = createRequire(import.meta.url);
  const packageRoot = path.dirname(require2.resolve("@qvac/harness/package"));
  const generatedDirectory = path.join(packageRoot, "generated", "react-native");
  return {
    entryPath: path.join(packageRoot, "mobile-entry.ts"),
    harnessPath: path.join(generatedDirectory, "harness.js"),
    metadataPath: path.join(generatedDirectory, "harness.metadata.json"),
    contract: "qvac.harness",
    protocolVersion: 1,
    hosts: harnessReactNativeHosts
  };
}
async function buildHarnessReactNativeBundle({
  outputDirectory
} = {}) {
  const descriptor = createHarnessReactNativeDescriptor();
  const buildDirectory = outputDirectory ?? path.dirname(descriptor.harnessPath);
  const harnessPath = path.join(buildDirectory, "harness.js");
  const metadataPath = path.join(buildDirectory, "harness.metadata.json");
  await mkdir(buildDirectory, { recursive: true });
  const artifactPaths = [];
  for await (const artifact of stow(pathToFileURL(descriptor.entryPath).href, reactNativeTarget, pathToFileURL(harnessPath).href)) {
    artifactPaths.push(fileURLToPath(artifact.url.href));
  }
  const bundlePath = artifactPaths.find((value) => value.endsWith(".bundle.mjs"));
  if (!bundlePath) {
    throw new Error("Harness react-native stow did not emit .bundle.mjs");
  }
  const bundleSource = await readFile(bundlePath, "utf8");
  const bundle = Bundle.from(readStowBundleExport(bundleSource));
  const nativeAddons = readBundleAddons(bundle);
  await patchGeneratedHarness(harnessPath);
  const metadata = {
    bundleId: bundle.id ? String(bundle.id) : null,
    contract: descriptor.contract,
    protocolVersion: descriptor.protocolVersion,
    hosts: descriptor.hosts,
    nativeAddons,
    packages: readBundlePackages(bundle)
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}
`);
  return {
    descriptor: {
      ...descriptor,
      harnessPath,
      metadataPath
    },
    bundlePath,
    metadata
  };
}
function readStowBundleExport(source) {
  const prefix = "export default ";
  if (!source.startsWith(prefix)) {
    throw new Error("Stow bundle module did not export a default value");
  }
  const literal = source.slice(prefix.length).trim().replace(/;$/, "");
  const parsed = JSON.parse(literal);
  if (typeof parsed !== "string") {
    throw new Error("Stow bundle module default export was not a string");
  }
  return parsed;
}
function readTargetHosts() {
  const value = Reflect.get(reactNativeTarget, "hosts");
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("React Native target did not expose hosts[]");
  }
  return value;
}
function readBundleAddons(bundle) {
  const addons = Reflect.get(bundle, "addons");
  if (!Array.isArray(addons))
    return [];
  return addons.filter((entry) => typeof entry === "string").sort();
}
function readBundlePackages(bundle) {
  const files = Reflect.get(bundle, "files");
  if (typeof files !== "object" || files === null || Array.isArray(files))
    return [];
  const packages = [];
  for (const [packagePath, file] of Object.entries(files)) {
    if (!packagePath.endsWith("/package.json") || typeof file !== "object" || file === null) {
      continue;
    }
    const data = Reflect.get(file, "_data");
    if (!(data instanceof Uint8Array))
      continue;
    const parsed = JSON.parse(Buffer.from(data).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      continue;
    const name = Reflect.get(parsed, "name");
    const version = Reflect.get(parsed, "version");
    if (typeof name !== "string" || typeof version !== "string")
      continue;
    packages.push({
      name,
      version,
      packagePath,
      singleton: Reflect.get(parsed, "addon") === true
    });
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version) || left.packagePath.localeCompare(right.packagePath));
}
async function patchGeneratedHarness(harnessPath) {
  const original = await readFile(harnessPath, "utf8");
  const withStartSignature = original.replace("async start(opts = {}) {", "async start(opts = {}, args = []) {");
  const patched = withStartSignature.replace("worklet.start('/core.bundle', bundle)", "worklet.start('/core.bundle', new TextEncoder().encode(bundle), args)");
  if (patched === original || withStartSignature === original) {
    throw new Error(`Unable to patch generated harness argv support: ${harnessPath}`);
  }
  await writeFile(harnessPath, patched);
  const typePath = harnessPath.replace(/\.js$/, ".d.ts");
  const types = await readFile(typePath, "utf8");
  const patchedTypes = patchHarnessDeclaration(types);
  if (patchedTypes === types) {
    throw new Error(`Unable to patch generated harness declaration argv support: ${typePath}`);
  }
  await writeFile(typePath, patchedTypes);
}
function patchHarnessDeclaration(types) {
  const directImportPattern = /start\(opts\?: import\('react-native-bare-kit'\)\.WorkletOptions\): Promise<\{/g;
  if (directImportPattern.test(types)) {
    return types.replace(directImportPattern, "start(opts?: import('react-native-bare-kit').WorkletOptions, args?: readonly string[]): Promise<{");
  }
  const localTypePattern = /start\(opts\?: WorkletOptions\): Promise<\{/g;
  if (localTypePattern.test(types)) {
    return types.replace(localTypePattern, "start(opts?: WorkletOptions, args?: readonly string[]): Promise<{");
  }
  return types;
}

// lib/expo/plugin.ts
import { createRequire as createRequire2 } from "node:module";
import path5 from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// lib/expo/contribution.ts
import { access as access2, mkdir as mkdir2, readFile as readFile3, writeFile as writeFile2 } from "node:fs/promises";
import path3 from "node:path";

// lib/expo/addon-inventory.ts
import { access, readFile as readFile2, readdir } from "node:fs/promises";
import path2 from "node:path";
var linkedPrefix = "linked:";
var packageVersionTreeCache = new Map;
async function normalizeNativeAddonList(projectRoot, resources) {
  const byName = new Map;
  for (const resource of resources) {
    const addon = await normalizeNativeAddon(projectRoot, resource);
    const previous = byName.get(addon.name);
    if (previous && previous.version !== addon.version) {
      throw new Error(`Conflicting versions for native addon ${addon.name}: ${previous.version} vs ${addon.version}`);
    }
    byName.set(addon.name, addon);
  }
  return [...byName.values()].sort(compareAddons);
}
async function normalizeNativeAddon(projectRoot, resource) {
  const linked = parseLinkedAddon(resource);
  if (linked) {
    await assertPackageVersionInTree(projectRoot, linked);
    return linked;
  }
  const fromResource = await readAddonFromNodeModulesResource(projectRoot, resource);
  if (fromResource)
    return fromResource;
  if (!isPackageName(resource)) {
    throw new Error(`Malformed native addon metadata resource: ${resource}`);
  }
  return { name: resource, version: await resolvePackageVersion(projectRoot, resource) };
}
function parseLinkedAddon(resource) {
  if (!resource.startsWith(linkedPrefix))
    return null;
  const token = resource.slice(linkedPrefix.length);
  const framework = token.match(/^(.+)\.(\d+\.\d+\.\d+(?:[-+][^/]+)?)\.framework(?:\/.*)?$/);
  const sharedObject = token.match(/^lib(.+)\.(\d+\.\d+\.\d+(?:[-+][^/]+)?)\.so$/);
  const match = framework ?? sharedObject;
  if (!match)
    throw new Error(`Malformed native addon metadata resource: ${resource}`);
  return { name: decodeLinkedPackageName(match[1] ?? ""), version: match[2] ?? "" };
}
async function packageVersionExistsInTree(projectRoot, packageName, version) {
  const cacheKey = `${projectRoot}::${packageName}`;
  let versions = packageVersionTreeCache.get(cacheKey);
  if (!versions) {
    versions = collectPackageVersionsInTree(projectRoot, packageName);
    packageVersionTreeCache.set(cacheKey, versions);
  }
  return (await versions).includes(version);
}
async function readAddonFromNodeModulesResource(projectRoot, resource) {
  const packageJsonPath = readPackageJsonPath(resource);
  if (!packageJsonPath)
    return null;
  const parsed = await readPackageManifest(packageJsonPath);
  await assertPackageVersionInTree(projectRoot, parsed);
  return parsed;
}
function readPackageJsonPath(resource) {
  const normalized = resource.replaceAll("\\", "/");
  const marker = "node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1)
    return null;
  const segments = normalized.slice(markerIndex + marker.length).split("/").filter(Boolean);
  const name = segments[0]?.startsWith("@") && segments[1] ? `${segments[0]}/${segments[1]}` : segments[0];
  if (!name)
    return null;
  return path2.join(normalized.slice(0, markerIndex + marker.length), ...name.split("/"), "package.json");
}
async function assertPackageVersionInTree(projectRoot, addon) {
  if (await packageVersionExistsInTree(projectRoot, addon.name, addon.version))
    return;
  throw new Error(`Unable to resolve required package version for ${addon.name}@${addon.version} ` + `from package tree rooted at ${projectRoot}`);
}
async function resolvePackageVersion(projectRoot, packageName) {
  const packageJsonPath = await findPackageJsonInAncestors(projectRoot, packageName);
  return (await readPackageManifest(packageJsonPath)).version;
}
async function collectPackageVersionsInTree(projectRoot, packageName) {
  const versions = new Set;
  const visited = new Set;
  let directory = path2.resolve(projectRoot);
  while (true) {
    await traverseNodeModules(path2.join(directory, "node_modules"), packageName, versions, visited);
    const parent = path2.dirname(directory);
    if (parent === directory)
      break;
    directory = parent;
  }
  return [...versions].sort();
}
async function traverseNodeModules(nodeModules, packageName, versions, visited) {
  const resolved = path2.resolve(nodeModules);
  if (visited.has(resolved))
    return;
  visited.add(resolved);
  try {
    await access(resolved);
  } catch {
    return;
  }
  try {
    versions.add((await readPackageManifest(path2.join(resolved, ...packageName.split("/"), "package.json"))).version);
  } catch {}
  for (const entry of await readdir(resolved, { withFileTypes: true })) {
    if (!entry.isDirectory())
      continue;
    const directory = path2.join(resolved, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scoped of await readdir(directory, { withFileTypes: true })) {
        if (scoped.isDirectory()) {
          await traverseNodeModules(path2.join(directory, scoped.name, "node_modules"), packageName, versions, visited);
        }
      }
    } else {
      await traverseNodeModules(path2.join(directory, "node_modules"), packageName, versions, visited);
    }
  }
}
async function findPackageJsonInAncestors(projectRoot, packageName) {
  let directory = path2.resolve(projectRoot);
  while (true) {
    const candidate = path2.join(directory, "node_modules", ...packageName.split("/"), "package.json");
    try {
      await access(candidate);
      return candidate;
    } catch {}
    const parent = path2.dirname(directory);
    if (parent === directory)
      break;
    directory = parent;
  }
  throw new Error(`Unable to resolve required package version for ${packageName} from ancestor node_modules of ${projectRoot}`);
}
async function readPackageManifest(packageJsonPath) {
  const parsed = JSON.parse(await readFile2(packageJsonPath, "utf8"));
  if (!isObject(parsed) || typeof parsed.name !== "string" || typeof parsed.version !== "string") {
    throw new Error(`Malformed native addon package metadata: ${packageJsonPath}`);
  }
  return { name: parsed.name, version: parsed.version };
}
function decodeLinkedPackageName(value) {
  const [scope, name] = value.split("__", 2);
  return scope && name ? `@${scope}/${name}` : value;
}
function isPackageName(value) {
  return value.startsWith("@") ? /^@[^/]+\/[^/]+$/.test(value) : !value.includes("/") && !value.includes("\\");
}
function compareAddons(left, right) {
  return left.name.localeCompare(right.name) || left.version.localeCompare(right.version);
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// lib/expo/types.ts
var requiredMobileHosts = [
  "android-arm64",
  "ios-arm64",
  "ios-arm64-simulator",
  "ios-x64-simulator"
];

// lib/expo/contribution.ts
async function composeHarnessContribution(projectRoot, buildResult, options = {}) {
  await assertArtifacts(buildResult);
  const metadata = await readAndValidateHarnessMetadata(buildResult.descriptor.metadataPath);
  const nativeAddons = await normalizeNativeAddonList(projectRoot, metadata.nativeAddons);
  const contribution = {
    schemaVersion: 1,
    packageName: "@qvac/harness",
    packageVersion: options.packageVersion ?? "0.0.0-poc",
    contract: "qvac.harness",
    protocolVersion: 1,
    bundleId: metadata.bundleId,
    hosts: [...metadata.hosts].sort(),
    nativeAddons,
    packages: [...metadata.packages],
    harnessPath: buildResult.descriptor.harnessPath,
    metadataPath: buildResult.descriptor.metadataPath,
    bundlePath: buildResult.bundlePath
  };
  const destination = path3.join(projectRoot, "qvac", "contributions", "harness.json");
  await mkdir2(path3.dirname(destination), { recursive: true });
  await writeFile2(destination, `${JSON.stringify(contribution, null, 2)}
`);
  return contribution;
}
async function readAndValidateHarnessMetadata(metadataPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile3(metadataPath, "utf8"));
  } catch (error) {
    throw new Error(`Malformed Harness metadata: unable to parse ${metadataPath}`, { cause: error });
  }
  return validateHarnessMetadataShape(parsed);
}
function validateHarnessMetadataShape(metadata) {
  if (!isObject2(metadata))
    throw new Error("Malformed Harness metadata.");
  const bundleId = metadata.bundleId;
  const contract = metadata.contract;
  const protocolVersion = metadata.protocolVersion;
  const hosts = metadata.hosts;
  const nativeAddons = metadata.nativeAddons;
  const packages = metadata.packages;
  if (typeof bundleId !== "string" || bundleId.length === 0 || contract !== "qvac.harness" || protocolVersion !== 1 || !Array.isArray(hosts) || !hosts.every((host) => typeof host === "string") || !requiredMobileHosts.every((host) => hosts.includes(host)) || !Array.isArray(nativeAddons) || !nativeAddons.every((addon) => typeof addon === "string") || !isValidPackages(packages)) {
    throw new Error("Malformed Harness metadata.");
  }
  return {
    bundleId,
    hosts,
    nativeAddons,
    packages: packages === undefined ? [] : packages
  };
}
function isValidPackages(packages) {
  if (packages === undefined)
    return true;
  return Array.isArray(packages) && packages.every((entry) => isObject2(entry) && typeof entry.name === "string" && typeof entry.version === "string" && typeof entry.packagePath === "string" && typeof entry.singleton === "boolean");
}
async function assertArtifacts(buildResult) {
  await Promise.all([
    requireFile(buildResult.descriptor.harnessPath, "harness"),
    requireFile(buildResult.descriptor.metadataPath, "metadata"),
    requireFile(buildResult.bundlePath, "bundle")
  ]);
}
async function requireFile(filePath, label) {
  try {
    await access2(filePath);
  } catch {
    throw new Error(`Missing Harness artifact (${label}): ${filePath}`);
  }
}
function isObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// lib/expo/finalize.ts
import { existsSync } from "node:fs";
import { access as access3, mkdir as mkdir3, readFile as readFile4, writeFile as writeFile3 } from "node:fs/promises";
import path4 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var linkerTargets = [
  { relativePath: "android/link.mjs", patchName: "android-link.mjs" },
  { relativePath: "ios/link.mjs", patchName: "ios-link.mjs" }
];
async function finalizeHarnessStandalone(projectRoot, contribution) {
  const validation = validateStandaloneContribution(contribution);
  const qvacDirectory = path4.join(projectRoot, "qvac");
  await mkdir3(qvacDirectory, { recursive: true });
  await writeFile3(path4.join(qvacDirectory, "harness-stack.validation.json"), `${JSON.stringify(validation, null, 2)}
`);
  if (!validation.ok) {
    throw new Error(`Harness standalone validation failed:
${validation.errors.map((error) => `- ${error}`).join(`
`)}`);
  }
  await writeFile3(path4.join(qvacDirectory, "addons.manifest.json"), `${JSON.stringify({
    version: 1,
    bundleId: contribution.bundleId,
    addons: contribution.nativeAddons.map((addon) => addon.name)
  }, null, 2)}
`);
  await installBareKitLinkerAdaptation(projectRoot);
}
function validateStandaloneContribution(contribution) {
  const errors = [];
  if (contribution.schemaVersion !== 1)
    errors.push("Contribution schema version must be 1");
  if (contribution.packageName !== "@qvac/harness") {
    errors.push("Contribution package name must be @qvac/harness");
  }
  if (contribution.contract !== "qvac.harness") {
    errors.push("Contribution contract must be qvac.harness");
  }
  if (contribution.protocolVersion !== 1)
    errors.push("Contribution protocol version must be 1");
  if (!contribution.bundleId)
    errors.push("Contribution bundle ID is required");
  if (!contribution.harnessPath || !contribution.metadataPath || !contribution.bundlePath) {
    errors.push("Contribution artifact paths are required");
  }
  for (const host of requiredMobileHosts) {
    if (!contribution.hosts.includes(host)) {
      errors.push(`Contribution is missing required host ${host}`);
    }
  }
  const addonVersions = new Map;
  for (const addon of contribution.nativeAddons) {
    const previous = addonVersions.get(addon.name);
    if (previous && previous !== addon.version) {
      errors.push(`Conflicting versions for native addon ${addon.name}: ${previous} vs ${addon.version}`);
    }
    addonVersions.set(addon.name, addon.version);
  }
  const singletonVersions = new Map;
  const packageKeys = new Set;
  for (const entry of contribution.packages) {
    packageKeys.add(`${entry.name}@${entry.version}`);
    if (!entry.singleton)
      continue;
    const versions = singletonVersions.get(entry.name) ?? new Set;
    versions.add(entry.version);
    singletonVersions.set(entry.name, versions);
  }
  for (const [name, versions] of singletonVersions) {
    if (versions.size < 2)
      continue;
    errors.push(`Conflicting singleton package versions for ${name}: ${[...versions].sort().join(", ")}`);
  }
  if (contribution.nativeAddons.length > 0 && contribution.packages.length === 0) {
    errors.push("Contribution packages are required when native addons are declared");
  }
  for (const addon of contribution.nativeAddons) {
    const key = `${addon.name}@${addon.version}`;
    if (packageKeys.has(key))
      continue;
    errors.push(`Native addon ${key} is missing from contribution packages`);
  }
  return { ok: errors.length === 0, errors };
}
async function installBareKitLinkerAdaptation(projectRoot) {
  const packageRoot = findBareKitPackageRoot(projectRoot);
  if (!packageRoot) {
    throw new Error("Standalone Harness Expo plugin requires react-native-bare-kit to prepare native linking");
  }
  const patchesDirectory = resolvePatchesDirectory();
  for (const target of linkerTargets) {
    const linkerPath = path4.join(packageRoot, target.relativePath);
    const patchPath = path4.join(patchesDirectory, target.patchName);
    await assertReadable(linkerPath, `BareKit linker ${target.relativePath}`);
    const adaptation = await readFileStrict(patchPath, `BareKit linker adaptation ${target.patchName}`);
    const declaration = /^const projectRoot = .+$/m;
    if (!declaration.test(adaptation)) {
      throw new Error(`BareKit linker adaptation is missing project-root declaration: ${patchPath}`);
    }
    await writeFile3(linkerPath, adaptation.replace(declaration, `const projectRoot = ${JSON.stringify(projectRoot)}`));
  }
}
function findBareKitPackageRoot(projectRoot) {
  let directory = path4.resolve(projectRoot);
  let parent = path4.dirname(directory);
  for (;directory !== parent; directory = parent, parent = path4.dirname(directory)) {
    const candidate = path4.join(directory, "node_modules", "react-native-bare-kit");
    if (existsSync(path4.join(candidate, "package.json")))
      return candidate;
  }
  return null;
}
function resolvePatchesDirectory() {
  const moduleDirectory = path4.dirname(fileURLToPath2(import.meta.url));
  if (path4.basename(moduleDirectory) === "dist") {
    return path4.join(path4.dirname(moduleDirectory), "lib", "expo", "patches");
  }
  return path4.join(moduleDirectory, "patches");
}
async function assertReadable(filePath, label) {
  try {
    await access3(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label} at ${filePath}: ${message}`);
  }
}
async function readFileStrict(filePath, label) {
  try {
    return await readFile4(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label} at ${filePath}: ${message}`);
  }
}

// lib/expo/plugin.ts
var pluginId = "@qvac/harness/expo-plugin";
var buildRunOnceId = "@qvac/harness/expo-plugin/build";
function createHarnessExpoPlugin(options = {}) {
  const mode = options.mode ?? "standalone";
  const build = options.build ?? buildHarnessReactNativeBundle;
  const packageVersion = options.packageVersion ?? readHarnessPackageVersion();
  const buildCache = new Map;
  const composeCache = new Map;
  const runOncePlugin = createRunOncePlugin(withHarnessExpoPlugin, pluginId, packageVersion);
  return runOncePlugin;
  function withHarnessExpoPlugin(config) {
    return withRunOnce(config, {
      name: buildRunOnceId,
      version: packageVersion,
      plugin(configValue) {
        configValue = withDangerousMod(configValue, [
          "android",
          async (context) => {
            await composeOnce(context);
            return context;
          }
        ]);
        configValue = withDangerousMod(configValue, [
          "ios",
          async (context) => {
            await composeOnce(context);
            return context;
          }
        ]);
        return configValue;
      }
    });
  }
  async function composeOnce(context) {
    const projectRoot = readProjectRoot(context);
    const existing = composeCache.get(projectRoot);
    if (existing)
      return existing;
    const work = (async () => {
      const result = await getOrCreateBuild(projectRoot, build, buildCache);
      const contribution = await composeHarnessContribution(projectRoot, result, { packageVersion });
      if (mode === "standalone")
        await finalizeHarnessStandalone(projectRoot, contribution);
    })().catch((error) => {
      composeCache.delete(projectRoot);
      throw error;
    });
    composeCache.set(projectRoot, work);
    return work;
  }
}
function getOrCreateBuild(projectRoot, build, cache) {
  const existing = cache.get(projectRoot);
  if (existing)
    return existing;
  const created = build().catch((error) => {
    cache.delete(projectRoot);
    throw error;
  });
  cache.set(projectRoot, created);
  return created;
}
function readProjectRoot(context) {
  const projectRoot = context.modRequest.projectRoot;
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error("Expo plugin modRequest.projectRoot was missing");
  }
  return projectRoot;
}
function readHarnessPackageVersion() {
  const moduleDirectory = path5.dirname(fileURLToPath3(import.meta.url));
  const packageRoot = path5.basename(moduleDirectory) === "dist" ? path5.dirname(moduleDirectory) : path5.resolve(moduleDirectory, "../..");
  const require2 = createRequire2(import.meta.url);
  const packageJson = require2(path5.join(packageRoot, "package.json"));
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Harness package version is required for Expo plugin.");
  }
  return packageJson.version;
}

// expo-plugin.ts
var expo_plugin_default = createHarnessExpoPlugin();
export {
  validateStandaloneContribution,
  expo_plugin_default as default,
  createHarnessExpoPlugin,
  composeHarnessContribution
};
