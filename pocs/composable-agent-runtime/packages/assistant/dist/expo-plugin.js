// expo-plugin.ts
import {
  createRunOncePlugin,
  withDangerousMod,
  withPlugins,
  withRunOnce
} from "@expo/config-plugins";

// ../harness/lib/react-native-stow.ts
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
  const patched = withStartSignature.replace("worklet.start('/core.bundle', bundle)", "worklet.start('/core.bundle', bundle, args)");
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
// expo-plugin.ts
import sdkExpoPlugin from "@qvac/sdk/expo-plugin";

// ../sync/lib/react-native-stow.ts
import Bundle2 from "bare-bundle";
import stow2 from "bare-stow";
import reactNativeTarget2 from "bare-stow-target-react-native";
import { mkdir as mkdir2, readFile as readFile2, writeFile as writeFile2 } from "node:fs/promises";
import { createRequire as createRequire2 } from "node:module";
import path2 from "node:path";
import { fileURLToPath as fileURLToPath2, pathToFileURL as pathToFileURL2 } from "node:url";
var syncReactNativeHosts = [...readTargetHosts2()];
function createSyncReactNativeDescriptor() {
  const require2 = createRequire2(import.meta.url);
  const packageRoot = path2.dirname(require2.resolve("@qvac/sync/package"));
  const generatedDirectory = path2.join(packageRoot, "generated", "react-native");
  return {
    entryPath: path2.join(packageRoot, "mobile-entry.ts"),
    harnessPath: path2.join(generatedDirectory, "sync.js"),
    metadataPath: path2.join(generatedDirectory, "sync.metadata.json"),
    contract: "qvac.sync",
    protocolVersion: 1,
    hosts: syncReactNativeHosts
  };
}
async function buildSyncReactNativeBundle({
  outputDirectory
} = {}) {
  const descriptor = createSyncReactNativeDescriptor();
  const buildDirectory = outputDirectory ?? path2.dirname(descriptor.harnessPath);
  const harnessPath = path2.join(buildDirectory, "sync.js");
  const metadataPath = path2.join(buildDirectory, "sync.metadata.json");
  await mkdir2(buildDirectory, { recursive: true });
  const artifactPaths = [];
  for await (const artifact of stow2(pathToFileURL2(descriptor.entryPath).href, reactNativeTarget2, pathToFileURL2(harnessPath).href)) {
    artifactPaths.push(fileURLToPath2(artifact.url.href));
  }
  const bundlePath = artifactPaths.find((value) => value.endsWith(".bundle.mjs"));
  if (!bundlePath) {
    throw new Error("Sync react-native stow did not emit .bundle.mjs");
  }
  const bundleSource = await readFile2(bundlePath, "utf8");
  const bundle = Bundle2.from(readStowBundleExport2(bundleSource));
  const nativeAddons = readBundleAddons2(bundle);
  await patchGeneratedHarness2(harnessPath);
  const metadata = {
    bundleId: bundle.id ? String(bundle.id) : null,
    contract: descriptor.contract,
    protocolVersion: descriptor.protocolVersion,
    hosts: descriptor.hosts,
    nativeAddons,
    packages: readBundlePackages2(bundle)
  };
  await writeFile2(metadataPath, `${JSON.stringify(metadata, null, 2)}
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
function readStowBundleExport2(source) {
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
function readTargetHosts2() {
  const value = Reflect.get(reactNativeTarget2, "hosts");
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("React Native target did not expose hosts[]");
  }
  return value;
}
function readBundleAddons2(bundle) {
  const addons = Reflect.get(bundle, "addons");
  if (!Array.isArray(addons))
    return [];
  return addons.filter((entry) => typeof entry === "string").sort();
}
function readBundlePackages2(bundle) {
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
async function patchGeneratedHarness2(harnessPath) {
  const original = await readFile2(harnessPath, "utf8");
  const withStartSignature = original.replace("async start(opts = {}) {", "async start(opts = {}, args = []) {");
  const patched = withStartSignature.replace("worklet.start('/core.bundle', bundle)", "worklet.start('/core.bundle', bundle, args)");
  if (patched === original || withStartSignature === original) {
    throw new Error(`Unable to patch generated harness argv support: ${harnessPath}`);
  }
  await writeFile2(harnessPath, patched);
  const typePath = harnessPath.replace(/\.js$/, ".d.ts");
  const types = await readFile2(typePath, "utf8");
  const patchedTypes = patchHarnessDeclaration2(types);
  if (patchedTypes === types) {
    throw new Error(`Unable to patch generated harness declaration argv support: ${typePath}`);
  }
  await writeFile2(typePath, patchedTypes);
}
function patchHarnessDeclaration2(types) {
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
// expo-plugin.ts
import Bundle3 from "bare-bundle";
import { access, mkdir as mkdir3, readFile as readFile4, readdir as readdir2, writeFile as writeFile3 } from "node:fs/promises";
import { createRequire as createRequire3 } from "node:module";
import path4 from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// lib/artifact-validation.ts
import { readdir, readFile as readFile3, realpath, stat } from "node:fs/promises";
import path3 from "node:path";
async function validateArtifacts(options) {
  const singletonPackages = new Set(options.singletonPackages);
  const realms = await Promise.all(options.realms.map(async (realm) => ({
    ...realm,
    packages: realm.packages?.map((instance) => ({
      ...instance,
      singleton: instance.singleton || singletonPackages.has(instance.name)
    })) ?? await resolveRealmPackages(options.projectRoot, realm.roots, singletonPackages)
  })));
  const errors = [];
  validateRealmDuplicates(realms, errors);
  const expectedAddons = validateAddonUnion(options, errors);
  validateInstalledAddonVersions(realms, expectedAddons, errors);
  if (options.stagedResources) {
    validateStagedResources(options.stagedResources, expectedAddons, errors);
  }
  return {
    ok: errors.length === 0,
    errors,
    realms,
    nativeAddons: expectedAddons
  };
}
function validateInstalledAddonVersions(realms, addons, errors) {
  const installed = new Set(realms.flatMap((realm) => (realm.packages ?? []).map((instance) => `${instance.name}@${instance.version}`)));
  for (const addon of addons) {
    if (installed.has(addonKey(addon)))
      continue;
    errors.push({
      code: "NATIVE_ADDON_VERSION_NOT_INSTALLED",
      message: `No execution realm contains ${addonKey(addon)}`,
      packageName: addon.name
    });
  }
}
function assertArtifactValidation(report) {
  if (report.ok)
    return;
  throw new Error(`Assistant artifact validation failed:
${report.errors.map((issue) => `- [${issue.code}] ${issue.message}`).join(`
`)}`);
}
async function resolveRealmPackages(projectRoot, roots, singletonPackages) {
  const queue = roots.map((name) => ({ name, from: projectRoot }));
  const visited = new Set;
  const packages = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current)
      break;
    const manifestPath = await resolvePackageManifest(current.name, current.from);
    const physicalManifest = await realpath(manifestPath);
    if (visited.has(physicalManifest))
      continue;
    visited.add(physicalManifest);
    const manifest = await readManifest(physicalManifest);
    if (!manifest.name || !manifest.version) {
      throw new Error(`Package manifest omitted name/version: ${physicalManifest}`);
    }
    const packagePath = path3.dirname(physicalManifest);
    packages.push({
      name: manifest.name,
      version: manifest.version,
      packagePath,
      singleton: singletonPackages.has(manifest.name) || manifest.addon === true
    });
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies
    };
    for (const name of Object.keys(dependencies).sort()) {
      try {
        await resolvePackageManifest(name, packagePath);
        queue.push({ name, from: packagePath });
      } catch {
        if (manifest.optionalDependencies?.[name] === undefined)
          throw new Error(`Unable to resolve ${name} required by ${manifest.name}@${manifest.version}`);
      }
    }
  }
  return packages.sort(comparePackageInstances);
}
async function resolvePackageManifest(name, from) {
  let directory = path3.resolve(from);
  while (true) {
    const candidate = path3.join(directory, "node_modules", ...name.split("/"), "package.json");
    try {
      const info = await stat(candidate);
      if (info.isFile())
        return candidate;
    } catch {}
    const parent = path3.dirname(directory);
    if (parent === directory)
      break;
    directory = parent;
  }
  throw new Error(`Unable to resolve package ${name} from ${from}`);
}
async function readManifest(manifestPath) {
  const parsed = JSON.parse(await readFile3(manifestPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Malformed package manifest: ${manifestPath}`);
  }
  return parsed;
}
function validateRealmDuplicates(realms, errors) {
  for (const realm of realms) {
    const versions = new Map;
    for (const instance of realm.packages ?? []) {
      if (!instance.singleton)
        continue;
      const current = versions.get(instance.name) ?? new Set;
      current.add(instance.version);
      versions.set(instance.name, current);
    }
    for (const [name, found] of versions) {
      if (found.size < 2)
        continue;
      errors.push({
        code: "DUPLICATE_SINGLETON_VERSION",
        message: `${realm.name} contains ${name} at versions ${[...found].sort().join(", ")}`,
        realm: realm.name,
        packageName: name
      });
    }
  }
}
function validateAddonUnion(options, errors) {
  const declared = [
    ...options.sdkAddons,
    ...options.workers.flatMap((worker) => worker.nativeAddons)
  ];
  const versions = new Map;
  for (const addon of declared) {
    const current = versions.get(addon.name) ?? new Set;
    current.add(addon.version);
    versions.set(addon.name, current);
  }
  for (const [name, found] of versions) {
    if (found.size < 2)
      continue;
    errors.push({
      code: "CONFLICTING_NATIVE_ADDON_VERSION",
      message: `${name} is required at versions ${[...found].sort().join(", ")}`,
      packageName: name
    });
  }
  const expected = uniqueAddons(declared);
  const merged = uniqueAddons(options.mergedAddons);
  const expectedKeys = new Set(expected.map(addonKey));
  const mergedKeys = new Set(merged.map(addonKey));
  for (const addon of expected) {
    if (mergedKeys.has(addonKey(addon)))
      continue;
    errors.push({
      code: "MISSING_MERGED_ADDON",
      message: `Merged linker manifest omits ${addonKey(addon)}`,
      packageName: addon.name
    });
  }
  for (const addon of merged) {
    if (expectedKeys.has(addonKey(addon)))
      continue;
    errors.push({
      code: "UNDECLARED_MERGED_ADDON",
      message: `Merged linker manifest includes undeclared ${addonKey(addon)}`,
      packageName: addon.name
    });
  }
  return expected;
}
function validateStagedResources(resources, expected, errors) {
  const staged = new Set;
  for (const resource of resources) {
    const identity = identifyNativeResource(resource, expected);
    if (!identity)
      continue;
    staged.add(addonKey(identity));
  }
  const expectedKeys = new Set(expected.map(addonKey));
  for (const addon of expected) {
    if (staged.has(addonKey(addon)))
      continue;
    errors.push({
      code: "MISSING_NATIVE_PREBUILD",
      message: `No staged native resource found for ${addonKey(addon)}`,
      packageName: addon.name
    });
  }
  for (const key of staged) {
    if (expectedKeys.has(key))
      continue;
    errors.push({
      code: "UNDECLARED_STAGED_ADDON",
      message: `Staged native resource is not declared by a worker: ${key}`
    });
  }
}
function identifyNativeResource(resource, expected) {
  const normalized = resource.replaceAll("\\", "/");
  for (const addon of expected) {
    const encoded2 = addon.name.startsWith("@") ? addon.name.slice(1).replace("/", "__") : addon.name;
    if (containsResourceIdentity(normalized, encoded2) && (normalized.includes(addon.version) || !/\d+\.\d+\.\d+/.test(normalized))) {
      return addon;
    }
  }
  const encoded = normalized.match(/(?:^|\/)(?:lib)?([a-z0-9-]+__[a-z0-9-]+)(?:\.(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?))?\.(?:so|bare|node|framework)(?:\/|$)/i);
  const identity = encoded?.[1];
  if (identity) {
    const separator = identity.indexOf("__");
    const scope = identity.slice(0, separator);
    const name = identity.slice(separator + 2);
    return {
      name: `@${scope}/${name}`,
      version: encoded[2] ?? "unknown"
    };
  }
  return null;
}
function containsResourceIdentity(resource, encodedName) {
  const candidates = [encodedName, `lib${encodedName}`];
  return resource.split("/").some((segment) => candidates.some((candidate) => segment === candidate || segment.startsWith(`${candidate}.`)));
}
function uniqueAddons(addons) {
  return [...new Map(addons.map((addon) => [addonKey(addon), addon])).values()].sort((left, right) => addonKey(left).localeCompare(addonKey(right)));
}
function addonKey(addon) {
  return `${addon.name}@${addon.version}`;
}
function comparePackageInstances(left, right) {
  return left.name.localeCompare(right.name) || left.version.localeCompare(right.version) || left.packagePath.localeCompare(right.packagePath);
}

// expo-plugin.ts
var ASSISTANT_STACK_MANIFEST_VERSION = 3;
var PLUGIN_EXECUTION_ORDER = Object.freeze([
  "build-sync-react-native-stow",
  "build-harness-react-native-stow",
  "invoke-sdk-expo-plugin",
  "merge-assistant-stack-manifests"
]);
var SDK_PLUGIN_ID = "@qvac/sdk/expo-plugin";
var ASSISTANT_PLUGIN_ID = "@qvac/assistant/expo-plugin";
var ASSISTANT_BUILD_RUN_ONCE = "@qvac/assistant/expo-plugin/build-workers";
var ASSISTANT_MERGE_RUN_ONCE = "@qvac/assistant/expo-plugin/merge-manifests";
var REQUIRED_MOBILE_HOSTS = Object.freeze([
  "android-arm64",
  "ios-arm64",
  "ios-arm64-simulator",
  "ios-x64-simulator"
]);
var WORKER_ADAPTER_VERSION = 1;
var LINKED_PREFIX = "linked:";
var assistantPackage = readAssistantPackageMetadata();
var ASSISTANT_PLUGIN_VERSION = assistantPackage.version;
var ASSISTANT_MANIFEST_PROVENANCE_VERSION = 1;
async function composeAssistantStack(options) {
  const builtWorkers = await buildWorkerArtifacts(options.projectRoot, options);
  await mergeAssistantManifests(options.projectRoot, builtWorkers);
}
function createAssistantExpoPlugin(options = {}) {
  const buildFunctions = {
    buildSync: options.buildSync ?? buildSyncReactNativeBundle,
    buildHarness: options.buildHarness ?? buildHarnessReactNativeBundle
  };
  const sdkPlugin = options.sdkPlugin ?? sdkExpoPlugin;
  const buildCache = new Map;
  const runOncePlugin = createRunOncePlugin(withAssistantExpoPlugin, ASSISTANT_PLUGIN_ID, ASSISTANT_PLUGIN_VERSION);
  return runOncePlugin;
  function withAssistantExpoPlugin(config) {
    assertNoDuplicatePluginRegistration(config.plugins, sdkPlugin, runOncePlugin, withAssistantExpoPlugin);
    return withPlugins(config, [
      withRunOnceMergePlugin,
      sdkPlugin,
      withRunOnceBuildPlugin
    ]);
  }
  function withRunOnceMergePlugin(config) {
    return withRunOnce(config, {
      name: ASSISTANT_MERGE_RUN_ONCE,
      version: ASSISTANT_PLUGIN_VERSION,
      plugin(configValue) {
        configValue = withDangerousMod(configValue, [
          "android",
          async (context) => {
            await mergeAfterSdk(context, buildFunctions, buildCache);
            return context;
          }
        ]);
        configValue = withDangerousMod(configValue, [
          "ios",
          async (context) => {
            await mergeAfterSdk(context, buildFunctions, buildCache);
            return context;
          }
        ]);
        return configValue;
      }
    });
  }
  function withRunOnceBuildPlugin(config) {
    return withRunOnce(config, {
      name: ASSISTANT_BUILD_RUN_ONCE,
      version: ASSISTANT_PLUGIN_VERSION,
      plugin(configValue) {
        configValue = withDangerousMod(configValue, [
          "android",
          async (context) => {
            await buildOnce(context, buildFunctions, buildCache);
            return context;
          }
        ]);
        configValue = withDangerousMod(configValue, [
          "ios",
          async (context) => {
            await buildOnce(context, buildFunctions, buildCache);
            return context;
          }
        ]);
        return configValue;
      }
    });
  }
}
var withAssistantExpoPlugin = createAssistantExpoPlugin();
var expo_plugin_default = withAssistantExpoPlugin;
async function buildOnce(context, buildFunctions, buildCache) {
  const projectRoot = readProjectRoot(context);
  getOrCreateBuild(projectRoot, buildFunctions, buildCache);
  await buildCache.get(projectRoot);
}
async function mergeAfterSdk(context, buildFunctions, buildCache) {
  const projectRoot = readProjectRoot(context);
  const builtWorkers = await getOrCreateBuild(projectRoot, buildFunctions, buildCache);
  await mergeAssistantManifests(projectRoot, builtWorkers, true);
}
function getOrCreateBuild(projectRoot, buildFunctions, buildCache) {
  const existing = buildCache.get(projectRoot);
  if (existing)
    return existing;
  const created = buildWorkerArtifacts(projectRoot, buildFunctions).catch((error) => {
    buildCache.delete(projectRoot);
    throw error;
  });
  buildCache.set(projectRoot, created);
  return created;
}
function readProjectRoot(context) {
  const projectRoot = context.modRequest.projectRoot;
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error("Expo plugin modRequest.projectRoot was missing");
  }
  return projectRoot;
}
function assertNoDuplicatePluginRegistration(plugins, sdkPlugin, assistantRunOncePlugin, assistantPlugin) {
  const entries = plugins ?? [];
  const sdkRegistrations = entries.filter((entry) => isMatchingPluginEntry(entry, SDK_PLUGIN_ID, sdkPlugin));
  if (sdkRegistrations.length > 0) {
    throw new Error("Duplicate SDK plugin registration detected. " + "Use only @qvac/assistant/expo-plugin and remove @qvac/sdk/expo-plugin from app config.");
  }
  const assistantRegistrations = entries.filter((entry) => isMatchingAssistantPluginEntry(entry, assistantRunOncePlugin, assistantPlugin));
  if (assistantRegistrations.length > 1) {
    throw new Error("Duplicate plugin registration detected for @qvac/assistant/expo-plugin.");
  }
}
function isMatchingAssistantPluginEntry(entry, assistantRunOncePlugin, assistantPlugin) {
  if (isMatchingPluginEntry(entry, ASSISTANT_PLUGIN_ID, assistantRunOncePlugin))
    return true;
  if (typeof entry === "function")
    return entry === assistantPlugin;
  if (!Array.isArray(entry))
    return false;
  const [plugin] = entry;
  return typeof plugin === "function" && plugin === assistantPlugin;
}
function isMatchingPluginEntry(entry, pluginId, pluginFunction) {
  if (typeof entry === "string") {
    return entry === pluginId || entry.endsWith(pluginId);
  }
  if (typeof entry === "function")
    return entry === pluginFunction;
  if (!Array.isArray(entry) || entry.length === 0)
    return false;
  const [plugin] = entry;
  if (typeof plugin === "string") {
    return plugin === pluginId || plugin.endsWith(pluginId);
  }
  return typeof plugin === "function" && plugin === pluginFunction;
}
async function buildWorkerArtifacts(projectRoot, buildFunctions) {
  const syncResult = await buildFunctions.buildSync();
  const harnessResult = await buildFunctions.buildHarness();
  await assertWorkerArtifacts("sync", syncResult);
  await assertWorkerArtifacts("harness", harnessResult);
  return {
    sync: await createWorkerInventory(projectRoot, "sync", syncResult),
    harness: await createWorkerInventory(projectRoot, "harness", harnessResult)
  };
}
async function assertWorkerArtifacts(role, buildResult) {
  await requireFile(buildResult.descriptor.harnessPath, `${role} harness`);
  await requireFile(buildResult.descriptor.metadataPath, `${role} metadata`);
  await requireFile(buildResult.bundlePath, `${role} bundle`);
}
async function requireFile(filePath, label) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`Missing worker artifact (${label}): ${filePath}`);
  }
}
async function createWorkerInventory(projectRoot, role, buildResult) {
  const metadata = validateWorkerMetadata(role, buildResult.metadata);
  const nativeAddons = await normalizeNativeAddonList(projectRoot, metadata.nativeAddons);
  return {
    role,
    contract: metadata.contract,
    protocolVersion: metadata.protocolVersion,
    bundleId: metadata.bundleId,
    hosts: [...metadata.hosts].sort(),
    nativeAddons,
    packages: metadata.packages
  };
}
function validateWorkerMetadata(role, metadata) {
  const expectedContract = role === "sync" ? "qvac.sync" : "qvac.harness";
  const hasBundleId = typeof metadata.bundleId === "string" && metadata.bundleId.length > 0;
  const hasContract = metadata.contract === expectedContract;
  const hasProtocol = metadata.protocolVersion === WORKER_ADAPTER_VERSION;
  const hasNativeAddons = Array.isArray(metadata.nativeAddons) && metadata.nativeAddons.every((entry) => typeof entry === "string");
  const hasHosts = Array.isArray(metadata.hosts) && metadata.hosts.every((entry) => typeof entry === "string") && REQUIRED_MOBILE_HOSTS.every((requiredHost) => metadata.hosts.includes(requiredHost));
  const hasPackages = metadata.packages === undefined || Array.isArray(metadata.packages) && metadata.packages.every((entry) => typeof entry.name === "string" && typeof entry.version === "string" && typeof entry.packagePath === "string" && typeof entry.singleton === "boolean");
  if (!hasBundleId || !hasContract || !hasProtocol || !hasNativeAddons || !hasHosts || !hasPackages) {
    throw new Error(`Malformed worker metadata for ${role}.`);
  }
  return {
    bundleId: metadata.bundleId,
    contract: metadata.contract,
    protocolVersion: WORKER_ADAPTER_VERSION,
    hosts: metadata.hosts,
    nativeAddons: metadata.nativeAddons,
    packages: metadata.packages
  };
}
async function mergeAssistantManifests(projectRoot, builtWorkers, pinLinkerRoot = false) {
  const qvacDirectory = path4.join(projectRoot, "qvac");
  const sdkManifestPath = path4.join(qvacDirectory, "addons.manifest.json");
  const stackManifestPath = path4.join(qvacDirectory, "assistant-stack.manifest.json");
  const sdkManifest = await readSdkManifest(sdkManifestPath);
  const sdkSourceAddons = await resolveSdkSourceAddons(projectRoot, sdkManifest);
  const mergedAddons = mergeAddonInventories(sdkSourceAddons, builtWorkers);
  const assistantProvenance = {
    schemaVersion: ASSISTANT_MANIFEST_PROVENANCE_VERSION,
    sourcePlugin: ASSISTANT_PLUGIN_ID,
    sourcePluginVersion: ASSISTANT_PLUGIN_VERSION,
    sdkSourceAddons
  };
  await mkdir3(qvacDirectory, { recursive: true });
  await writeFile3(sdkManifestPath, `${JSON.stringify({
    version: sdkManifest.version,
    bundleId: sdkManifest.bundleId,
    addons: mergedAddons.map((entry) => entry.name),
    assistantProvenance
  }, null, 2)}
`);
  const packageVersions = await readPackageVersions(projectRoot);
  const sdkBundlePackages = await readSdkBundlePackages(path4.join(qvacDirectory, "worker.bundle.js"));
  const stackManifest = {
    manifestVersion: ASSISTANT_STACK_MANIFEST_VERSION,
    pluginExecutionOrder: [...PLUGIN_EXECUTION_ORDER],
    requiredHosts: [...REQUIRED_MOBILE_HOSTS],
    packageVersions,
    bundles: {
      sync: builtWorkers.sync.bundleId,
      harness: builtWorkers.harness.bundleId,
      sdk: sdkManifest.bundleId
    },
    sdkSource: {
      manifestVersion: sdkManifest.version,
      bundleId: sdkManifest.bundleId,
      addons: sdkSourceAddons
    },
    workers: {
      sync: {
        contract: builtWorkers.sync.contract,
        protocolVersion: builtWorkers.sync.protocolVersion,
        hosts: builtWorkers.sync.hosts,
        nativeAddons: builtWorkers.sync.nativeAddons
      },
      harness: {
        contract: builtWorkers.harness.contract,
        protocolVersion: builtWorkers.harness.protocolVersion,
        hosts: builtWorkers.harness.hosts,
        nativeAddons: builtWorkers.harness.nativeAddons
      }
    },
    mergedAddons,
    realms: [
      {
        name: "host",
        roots: ["@qvac/assistant"],
        packages: [
          {
            name: "@qvac/assistant",
            version: packageVersions.assistant,
            packagePath: fileURLToPath3(new URL("./package.json", import.meta.url)),
            singleton: false
          }
        ]
      },
      {
        name: "sync-worker",
        roots: ["@qvac/sync"],
        packages: createRecordedRealmPackages("@qvac/sync", packageVersions.sync, builtWorkers.sync.bundleId, builtWorkers.sync.packages, builtWorkers.sync.nativeAddons)
      },
      {
        name: "harness-worker",
        roots: ["@qvac/harness"],
        packages: createRecordedRealmPackages("@qvac/harness", packageVersions.harness, builtWorkers.harness.bundleId, builtWorkers.harness.packages, builtWorkers.harness.nativeAddons)
      },
      {
        name: "sdk-worker",
        roots: ["@qvac/sdk"],
        packages: sdkBundlePackages ?? [
          {
            name: "@qvac/sdk",
            version: packageVersions.sdk,
            packagePath: `sdk-bundle:${sdkManifest.bundleId ?? "unknown"}/@qvac/sdk`,
            singleton: false
          },
          ...sdkSourceAddons.map((addon) => ({
            ...addon,
            packagePath: `sdk-bundle:${sdkManifest.bundleId ?? "unknown"}/${addon.name}`,
            singleton: true
          }))
        ]
      }
    ],
    singletonPackages: [
      "react-native-bare-kit",
      ...mergedAddons.map((addon) => addon.name)
    ].sort()
  };
  const validation = await validateArtifacts({
    projectRoot,
    realms: stackManifest.realms,
    singletonPackages: stackManifest.singletonPackages,
    sdkAddons: stackManifest.sdkSource.addons,
    workers: [
      {
        name: "sync",
        nativeAddons: stackManifest.workers.sync.nativeAddons
      },
      {
        name: "harness",
        nativeAddons: stackManifest.workers.harness.nativeAddons
      }
    ],
    mergedAddons: stackManifest.mergedAddons
  });
  assertArtifactValidation(validation);
  await writeFile3(stackManifestPath, `${JSON.stringify(stackManifest, null, 2)}
`);
  await writeFile3(path4.join(qvacDirectory, "assistant-stack.validation.json"), `${JSON.stringify(validation, null, 2)}
`);
  if (pinLinkerRoot)
    await pinBareKitLinkerProjectRoot(projectRoot);
}
async function pinBareKitLinkerProjectRoot(projectRoot) {
  const require2 = createRequire3(path4.join(projectRoot, "package.json"));
  let packageJsonPath;
  try {
    packageJsonPath = require2.resolve("react-native-bare-kit/package.json");
  } catch {
    return;
  }
  const packageRoot = path4.dirname(packageJsonPath);
  for (const relativePath of ["android/link.mjs", "ios/link.mjs"]) {
    const linkerPath = path4.join(packageRoot, relativePath);
    const source = await readFileStrict(linkerPath, `BareKit linker ${relativePath}`);
    const pattern = /^const projectRoot = .+$/m;
    if (!pattern.test(source)) {
      throw new Error(`BareKit linker project-root declaration was not found: ${linkerPath}`);
    }
    await writeFile3(linkerPath, source.replace(pattern, `const projectRoot = ${JSON.stringify(projectRoot)}`));
  }
}
function createRecordedRealmPackages(rootName, rootVersion, bundleId, bundledPackages, nativeAddons) {
  const packages = [
    ...bundledPackages ?? [],
    {
      name: rootName,
      version: rootVersion,
      packagePath: `bundle:${bundleId}/${rootName}`,
      singleton: false
    }
  ];
  const recorded = new Set(packages.map((entry) => `${entry.name}@${entry.version}`));
  for (const addon of nativeAddons) {
    const key = `${addon.name}@${addon.version}`;
    if (recorded.has(key))
      continue;
    packages.push({
      ...addon,
      packagePath: `bundle:${bundleId}/${addon.name}`,
      singleton: true
    });
    recorded.add(key);
  }
  return packages;
}
async function readSdkBundlePackages(bundlePath) {
  try {
    await access(bundlePath);
  } catch {
    return null;
  }
  const source = await readFile4(bundlePath);
  const text = source.toString("utf8");
  const prefix = "module.exports = ";
  const bundle = text.startsWith(prefix) ? decodeExportedBundle(text, prefix, bundlePath) : decodeBundle(source, bundlePath);
  const files = Reflect.get(bundle, "files");
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new Error(`SDK bundle omitted file inventory: ${bundlePath}`);
  }
  const packages = [];
  for (const [packagePath, file] of Object.entries(files)) {
    if (!packagePath.endsWith("/package.json") || typeof file !== "object" || file === null) {
      continue;
    }
    const data = Reflect.get(file, "_data");
    if (!(data instanceof Uint8Array))
      continue;
    const parsed = JSON.parse(Buffer.from(data).toString("utf8"));
    if (!isObject(parsed) || typeof parsed.name !== "string" || typeof parsed.version !== "string") {
      continue;
    }
    packages.push({
      name: parsed.name,
      version: parsed.version,
      packagePath,
      singleton: parsed.addon === true
    });
  }
  if (packages.length === 0) {
    throw new Error(`SDK bundle contained no package manifests: ${bundlePath}`);
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version) || left.packagePath.localeCompare(right.packagePath));
}
function decodeExportedBundle(source, prefix, bundlePath) {
  const literal = source.slice(prefix.length).trim().replace(/;$/, "");
  const encoded = JSON.parse(literal);
  if (typeof encoded !== "string") {
    throw new Error(`SDK bundle wrapper did not export a string: ${bundlePath}`);
  }
  return Bundle3.from(encoded);
}
function decodeBundle(data, bundlePath) {
  const from = Reflect.get(Bundle3, "from");
  if (typeof from !== "function") {
    throw new Error("bare-bundle did not expose Bundle.from");
  }
  const decoded = Reflect.apply(from, Bundle3, [data]);
  if (!(decoded instanceof Bundle3)) {
    throw new Error(`Unable to decode SDK bundle: ${bundlePath}`);
  }
  return decoded;
}
async function readSdkManifest(sdkManifestPath) {
  let source = "";
  try {
    source = await readFile4(sdkManifestPath, "utf8");
  } catch {
    throw new Error(`Missing SDK addons manifest: ${sdkManifestPath}. ` + "Run @qvac/sdk/expo-plugin before assistant manifest merge.");
  }
  const parsed = parseJson(source, sdkManifestPath, "SDK addons manifest");
  if (!isSdkManifest(parsed)) {
    throw new Error(`Malformed SDK addons manifest: ${sdkManifestPath}`);
  }
  return parsed;
}
function parseJson(source, filePath, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed ${label} JSON at ${filePath}: ${message}`);
  }
}
function isSdkManifest(value) {
  if (!isObject(value))
    return false;
  const version = value.version;
  const bundleId = value.bundleId;
  const addons = value.addons;
  return typeof version === "number" && Number.isFinite(version) && (bundleId === null || typeof bundleId === "string") && Array.isArray(addons) && addons.every((entry) => typeof entry === "string");
}
function isVersionedAddon(value) {
  return isObject(value) && typeof value.name === "string" && typeof value.version === "string";
}
function isAssistantManifestProvenance(value) {
  return isObject(value) && value.schemaVersion === ASSISTANT_MANIFEST_PROVENANCE_VERSION && value.sourcePlugin === ASSISTANT_PLUGIN_ID && typeof value.sourcePluginVersion === "string" && Array.isArray(value.sdkSourceAddons) && value.sdkSourceAddons.every(isVersionedAddon);
}
async function resolveSdkSourceAddons(projectRoot, sdkManifest) {
  if (isAssistantManifestProvenance(sdkManifest.assistantProvenance)) {
    return [...sdkManifest.assistantProvenance.sdkSourceAddons].sort(compareAddons);
  }
  return resolveAddonsByAncestor(projectRoot, sdkManifest.addons);
}
async function normalizeNativeAddonList(projectRoot, nativeAddons) {
  const addonsByName = new Map;
  for (const resource of nativeAddons) {
    const normalized = await normalizeNativeAddon(projectRoot, resource);
    const previous = addonsByName.get(normalized.name);
    if (!previous) {
      addonsByName.set(normalized.name, normalized);
      continue;
    }
    if (previous.version !== normalized.version) {
      throw new Error(`Conflicting versions for native addon ${normalized.name}: ` + `${previous.version} vs ${normalized.version}`);
    }
  }
  return [...addonsByName.values()].sort(compareAddons);
}
async function normalizeNativeAddon(projectRoot, resource) {
  const linkedAddon = parseLinkedAddon(resource);
  if (linkedAddon) {
    const versionExists = await packageVersionExistsInTree(projectRoot, linkedAddon.name, linkedAddon.version);
    if (!versionExists) {
      throw new Error(`Unable to resolve required package version for ${linkedAddon.name}@${linkedAddon.version} ` + `from package tree rooted at ${projectRoot}`);
    }
    return linkedAddon;
  }
  const packageFromPath = await readAddonFromNodeModulesResource(projectRoot, resource);
  if (packageFromPath)
    return packageFromPath;
  if (isPackageName(resource)) {
    const version = await resolvePackageVersion(projectRoot, resource);
    return { name: resource, version };
  }
  throw new Error(`Malformed native addon metadata resource: ${resource}`);
}
function parseLinkedAddon(resource) {
  if (!resource.startsWith(LINKED_PREFIX))
    return null;
  const token = resource.slice(LINKED_PREFIX.length);
  const framework = token.match(/^(.+)\.(\d+\.\d+\.\d+(?:[-+][^/]+)?)\.framework(?:\/.*)?$/);
  if (framework) {
    return {
      name: decodeLinkedPackageName(framework[1] ?? ""),
      version: framework[2] ?? ""
    };
  }
  const sharedObject = token.match(/^lib(.+)\.(\d+\.\d+\.\d+(?:[-+][^/]+)?)\.so$/);
  if (sharedObject) {
    return {
      name: decodeLinkedPackageName(sharedObject[1] ?? ""),
      version: sharedObject[2] ?? ""
    };
  }
  throw new Error(`Malformed native addon metadata resource: ${resource}`);
}
function decodeLinkedPackageName(value) {
  if (value.includes("__")) {
    const [scope, pkg] = value.split("__", 2);
    if (scope && pkg)
      return `@${scope}/${pkg}`;
  }
  return value;
}
async function readAddonFromNodeModulesResource(projectRoot, resource) {
  const segment = readPackageSegment(resource);
  if (!segment)
    return null;
  const source = await readFileStrict(segment.packageJsonPath, "native addon package metadata");
  const parsed = parseJson(source, segment.packageJsonPath, "native addon package metadata");
  if (!isObject(parsed) || typeof parsed.name !== "string" || typeof parsed.version !== "string") {
    throw new Error(`Malformed native addon package metadata: ${segment.packageJsonPath}`);
  }
  const versionExists = await packageVersionExistsInTree(projectRoot, parsed.name, parsed.version);
  if (!versionExists) {
    throw new Error(`Unable to resolve required package version for ${parsed.name}@${parsed.version} ` + `from package tree rooted at ${projectRoot}`);
  }
  return {
    name: parsed.name,
    version: parsed.version
  };
}
function readPackageSegment(resource) {
  const normalized = resource.replaceAll("\\", "/");
  const marker = "node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1)
    return null;
  const fromNodeModules = normalized.slice(markerIndex + marker.length);
  const segments = fromNodeModules.split("/").filter((entry) => entry.length > 0);
  if (segments.length === 0)
    return null;
  const packageName = segments[0]?.startsWith("@") && segments[1] ? `${segments[0]}/${segments[1]}` : segments[0] ?? null;
  if (packageName === null)
    return null;
  const packageDirectory = path4.resolve(normalized.slice(0, markerIndex + marker.length), ...packageName.split("/"));
  return {
    packageJsonPath: path4.join(packageDirectory, "package.json")
  };
}
function isPackageName(value) {
  if (value.startsWith("@"))
    return /^@[^/]+\/[^/]+$/.test(value);
  return !value.includes("/") && !value.includes("\\");
}
function mergeAddonInventories(sdkSourceAddons, builtWorkers) {
  const addonsByName = new Map;
  for (const addon of sdkSourceAddons) {
    addonsByName.set(addon.name, addon);
  }
  for (const addon of [...builtWorkers.sync.nativeAddons, ...builtWorkers.harness.nativeAddons]) {
    const previous = addonsByName.get(addon.name);
    if (!previous) {
      addonsByName.set(addon.name, addon);
      continue;
    }
    if (previous.version !== addon.version) {
      throw new Error(`Conflicting versions for native addon ${addon.name}: ${previous.version} vs ${addon.version}`);
    }
  }
  return [...addonsByName.values()].sort(compareAddons);
}
async function resolveAddonsByAncestor(projectRoot, addonNames) {
  const result = [];
  for (const addonName of addonNames) {
    const version = await resolvePackageVersion(projectRoot, addonName);
    result.push({ name: addonName, version });
  }
  result.sort(compareAddons);
  return result;
}
function compareAddons(left, right) {
  if (left.name !== right.name)
    return left.name.localeCompare(right.name);
  return left.version.localeCompare(right.version);
}
async function readPackageVersions(projectRoot) {
  const assistantPackageJsonPath = resolveAssistantPackageJsonPath();
  const assistantSource = await readFileStrict(assistantPackageJsonPath, "assistant package metadata");
  const assistantParsed = parseJson(assistantSource, assistantPackageJsonPath, "assistant package metadata");
  if (!isObject(assistantParsed) || typeof assistantParsed.version !== "string") {
    throw new Error(`Malformed assistant package metadata: ${assistantPackageJsonPath}`);
  }
  return {
    assistant: assistantParsed.version,
    sync: await resolvePackageVersion(projectRoot, "@qvac/sync"),
    harness: await resolvePackageVersion(projectRoot, "@qvac/harness"),
    sdk: await resolvePackageVersion(projectRoot, "@qvac/sdk")
  };
}
async function resolvePackageVersion(projectRoot, packageName) {
  const packageJsonPath = await findPackageJsonInAncestors(projectRoot, packageName);
  const source = await readFileStrict(packageJsonPath, `package metadata for ${packageName}`);
  const parsed = parseJson(source, packageJsonPath, `package metadata for ${packageName}`);
  if (!isObject(parsed) || typeof parsed.version !== "string") {
    throw new Error(`Malformed package metadata for ${packageName}: ${packageJsonPath}`);
  }
  return parsed.version;
}
var packageVersionTreeCache = new Map;
async function packageVersionExistsInTree(projectRoot, packageName, version) {
  const cacheKey = `${projectRoot}::${packageName}`;
  let versionsPromise = packageVersionTreeCache.get(cacheKey);
  if (!versionsPromise) {
    versionsPromise = collectPackageVersionsInTree(projectRoot, packageName);
    packageVersionTreeCache.set(cacheKey, versionsPromise);
  }
  const versions = await versionsPromise;
  return versions.includes(version);
}
async function collectPackageVersionsInTree(projectRoot, packageName) {
  const discovered = new Set;
  const visitedNodeModules = new Set;
  let currentDirectory = path4.resolve(projectRoot);
  const rootDirectory = path4.parse(currentDirectory).root;
  while (true) {
    const nodeModules = path4.join(currentDirectory, "node_modules");
    await traverseNodeModulesForPackage(nodeModules, packageName, discovered, visitedNodeModules);
    if (currentDirectory === rootDirectory)
      break;
    currentDirectory = path4.dirname(currentDirectory);
  }
  return [...discovered].sort();
}
async function traverseNodeModulesForPackage(nodeModulesPath, packageName, discoveredVersions, visitedNodeModules) {
  const canonical = path4.resolve(nodeModulesPath);
  if (visitedNodeModules.has(canonical))
    return;
  visitedNodeModules.add(canonical);
  try {
    await access(canonical);
  } catch {
    return;
  }
  const packageJsonPath = path4.join(canonical, ...packageName.split("/"), "package.json");
  try {
    const source = await readFile4(packageJsonPath, "utf8");
    const parsed = parseJson(source, packageJsonPath, `package metadata for ${packageName}`);
    if (isObject(parsed) && typeof parsed.version === "string") {
      discoveredVersions.add(parsed.version);
    }
  } catch {}
  const entries = await readdir2(canonical, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory())
      continue;
    const packageDirectory = path4.join(canonical, entry.name);
    if (entry.name.startsWith("@")) {
      const scopedEntries = await readdir2(packageDirectory, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        if (!scopedEntry.isDirectory())
          continue;
        await traverseNodeModulesForPackage(path4.join(packageDirectory, scopedEntry.name, "node_modules"), packageName, discoveredVersions, visitedNodeModules);
      }
      continue;
    }
    await traverseNodeModulesForPackage(path4.join(packageDirectory, "node_modules"), packageName, discoveredVersions, visitedNodeModules);
  }
}
async function findPackageJsonInAncestors(projectRoot, packageName) {
  let currentDirectory = path4.resolve(projectRoot);
  const rootDirectory = path4.parse(currentDirectory).root;
  while (true) {
    const candidate = path4.join(currentDirectory, "node_modules", ...packageName.split("/"), "package.json");
    try {
      await access(candidate);
      return candidate;
    } catch {
      if (currentDirectory === rootDirectory)
        break;
      currentDirectory = path4.dirname(currentDirectory);
    }
  }
  throw new Error(`Unable to resolve required package version for ${packageName} from ancestor node_modules of ${projectRoot}`);
}
async function readFileStrict(filePath, label) {
  try {
    return await readFile4(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label} at ${filePath}: ${message}`);
  }
}
function isObject(value) {
  return typeof value === "object" && value !== null;
}
function readAssistantPackageMetadata() {
  const require2 = createRequire3(import.meta.url);
  const packageJson = require2(resolveAssistantPackageJsonPath());
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Assistant package version is required for expo plugin provenance.");
  }
  return packageJson;
}
function resolveAssistantPackageJsonPath() {
  const moduleDirectory = path4.dirname(fileURLToPath3(import.meta.url));
  return path4.join(path4.basename(moduleDirectory) === "dist" ? path4.dirname(moduleDirectory) : moduleDirectory, "package.json");
}
export {
  expo_plugin_default as default,
  createAssistantExpoPlugin,
  composeAssistantStack
};
