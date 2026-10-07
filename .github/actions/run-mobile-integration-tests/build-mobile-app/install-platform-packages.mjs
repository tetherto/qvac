// Gives the test app the mobile platform package of every split addon it
// installed, so bare-pack and bare-link see the native runtime.
//
// A split addon (one whose binding.js is `module.exports = require('#host-addon')`,
// such as @qvac/fabric) keeps no runtime of its own: `#host-addon` names a
// platform package, an ordinary addon carrying prebuilds/<host>/<name>.bare.
// npm never selects a cross-built one through optionalDependencies, because
// its os/cpu never match the install host, so a mobile app has to depend on it
// directly, as this step does for the app under test.
//
// The platform package comes from one of two places:
//   - the meta package's own prebuilds/<host>, when it carries them (GPR dev
//     builds are published unsliced, and CI packs the addon under test with
//     its fresh prebuilds). The package is assembled in node_modules from them.
//   - otherwise the registry, at the meta package's exact version.
//
// Usage: node install-platform-packages.mjs --platform Android|iOS [--modules-dir node_modules]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_ADDON_IMPORT = '#host-addon';
const PLATFORM_INDEX_SOURCE = 'module.exports = require.addon()\n';

export const TARGET_HOSTS = {
  android: ['android-arm64'],
  ios: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator'],
};

export function normalisePlatform(value) {
  const platform = String(value ?? '').toLowerCase();
  if (!Object.hasOwn(TARGET_HOSTS, platform)) {
    throw new Error(`--platform must be Android or iOS, got "${value ?? ''}"`);
  }
  return platform;
}

// Android nests the package under its architecture; every iOS flavour
// collapses onto one package, matching the publish-time slices.
export function resolvePlatformPackageName(hostAddon, platform) {
  const branch = readImportsBranch(hostAddon, platform);
  const name = platform === 'android' ? readImportsBranch(branch, 'arm64') : branch;
  if (typeof name !== 'string' || name.startsWith('.')) return null;
  return name;
}

function readImportsBranch(value, key) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value[key];
}

// `@qvac/fabric-android-arm64` -> `qvac__fabric-android-arm64`, the module
// name cmake-bare derives from the package that ships it.
export function mangledAddonName(packageName) {
  return packageName.replace(/^@/, '').replace('/', '__');
}

// Every installed package with a `#host-addon` map, including copies npm
// nested under another package's node_modules.
export function findHostAddonPackages(modulesDir) {
  const found = [];
  const seen = new Set();
  const pending = [modulesDir];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const packageRoot of listPackageDirs(dir)) {
      const identity = fs.realpathSync(packageRoot);
      if (seen.has(identity)) continue;
      seen.add(identity);

      const manifest = readManifest(packageRoot);
      if (manifest?.imports?.[HOST_ADDON_IMPORT] !== undefined) {
        found.push({
          name: manifest.name,
          version: manifest.version,
          hostAddon: manifest.imports[HOST_ADDON_IMPORT],
          packageRoot,
        });
      }
      pending.push(path.join(packageRoot, 'node_modules'));
    }
  }
  return found;
}

function listPackageDirs(modulesDir) {
  const dirs = [];
  for (const entry of readDirSafe(modulesDir)) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(modulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scoped of readDirSafe(entryPath)) {
        if (isDirectory(scoped, entryPath)) dirs.push(path.join(entryPath, scoped.name));
      }
    } else if (isDirectory(entry, modulesDir)) {
      dirs.push(entryPath);
    }
  }
  return dirs;
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isDirectory(entry, parent) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(parent, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function readManifest(packageRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

// The platform package each split addon needs, and where it comes from. Only
// the meta package's own platform packages are considered (the map is
// registry-controlled, so it may confirm the slicer's naming, never choose an
// unrelated package), and one already installed at the meta's version is kept.
export function planPlatformPackages(packages, platform, modulesDir) {
  const plan = new Map();
  for (const pkg of packages) {
    const platformPackage = resolvePlatformPackageName(pkg.hostAddon, platform);
    if (platformPackage === null || !platformPackage.startsWith(`${pkg.name}-`)) continue;
    if (readManifest(path.join(modulesDir, platformPackage))?.version === pkg.version) continue;

    const localHosts = TARGET_HOSTS[platform].filter((host) =>
      fs.existsSync(path.join(pkg.packageRoot, 'prebuilds', host, `${mangledAddonName(platformPackage)}.bare`)),
    );
    const previous = plan.get(platformPackage);
    if (previous !== undefined) {
      if (previous.version !== pkg.version) {
        throw new Error(
          `${pkg.name} is installed at both ${previous.version} and ${pkg.version}; ` +
            `${platformPackage} can only match one of them`,
        );
      }
      if (previous.localHosts.length >= localHosts.length) continue;
    }
    plan.set(platformPackage, { ...pkg, platformPackage, localHosts });
  }
  return [...plan.values()];
}

// Writes node_modules/<platformPackage> from the meta package's own
// prebuilds/<host>, in the layout the slicer publishes.
export function assemblePlatformPackage(entry, modulesDir) {
  const root = path.join(modulesDir, entry.platformPackage);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'prebuilds'), { recursive: true });
  const manifest = {
    name: entry.platformPackage,
    version: entry.version,
    addon: true,
    exports: { '.': './index.js', './package': './package.json' },
    files: ['index.js', 'prebuilds'],
  };
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'index.js'), PLATFORM_INDEX_SOURCE);
  for (const host of entry.localHosts) {
    fs.cpSync(path.join(entry.packageRoot, 'prebuilds', host), path.join(root, 'prebuilds', host), {
      recursive: true,
    });
  }
  return root;
}

// Saved to the app manifest: a mobile app depends on its platform package
// directly, and a later `npm install` must not prune it.
export function installWithNpm(specs, { cwd }) {
  execFileSync('npm', ['install', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', ...specs], {
    cwd,
    stdio: 'inherit',
  });
}

export function installPlatformPackages({
  modulesDir,
  platform,
  install = installWithNpm,
  log = console.log,
}) {
  const plan = planPlatformPackages(findHostAddonPackages(modulesDir), platform, modulesDir);
  if (plan.length === 0) {
    log(`No split addon needs a ${platform} platform package.`);
    return [];
  }
  const fromRegistry = plan.filter((entry) => entry.localHosts.length === 0);
  if (fromRegistry.length > 0) {
    const specs = fromRegistry.map((entry) => `${entry.platformPackage}@${entry.version}`);
    install(specs, { cwd: path.dirname(modulesDir) });
    for (const spec of specs) log(`Installed ${spec} from the registry`);
  }
  // After npm, which would otherwise prune a package it did not install.
  for (const entry of plan.filter((e) => e.localHosts.length > 0)) {
    const root = assemblePlatformPackage(entry, modulesDir);
    log(`Assembled ${entry.platformPackage}@${entry.version} (${entry.localHosts.join(', ')}) at ${root}`);
  }
  return plan;
}

function parseArgs(argv) {
  const args = { modulesDir: 'node_modules' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--platform') args.platform = argv[++i];
    else if (argv[i] === '--modules-dir') args.modulesDir = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  installPlatformPackages({
    modulesDir: path.resolve(args.modulesDir),
    platform: normalisePlatform(args.platform),
  });
}
