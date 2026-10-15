// Gives the test app the mobile platform packages of every split addon it is
// about to install, so bare-pack and bare-link see the native runtime.
//
// A split addon (one whose binding.js is `module.exports = require('#host-addon')`,
// such as @qvac/fabric) keeps no runtime of its own: `#host-addon` names a
// platform package, an ordinary addon carrying prebuilds/<host>/<name>.bare.
// npm never selects a cross-built one through optionalDependencies, because
// its os/cpu never match the install host, so a mobile app has to depend on it
// directly, as this step does for the app under test.
//
// It runs before the test framework's build, which installs the addon and
// bundles in one go: `#host-addon` has no fallback, so bare-pack fails on a
// platform package that is not installed yet. The framework bundles for
// android-arm64 and ios-arm64 whichever platform is tested, so both platforms'
// packages are needed. They are declared in the app's package.json, so the
// framework's own `npm install` keeps them.
//
// This release line predates local Fabric prebuild overlays, so platform
// packages come from the registry at the meta package's exact version.
//
// Usage: node install-platform-packages.mjs --app-dir <dir> --addon-dir <dir>

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_ADDON_IMPORT = '#host-addon';

export const TARGET_HOSTS = {
  android: ['android-arm64'],
  ios: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator'],
};

export const PLATFORMS = Object.keys(TARGET_HOSTS);

// Android nests the package under its architecture; every iOS flavour
// collapses onto one package, matching the publish-time slices.
export function resolvePlatformPackageName(hostAddon, platform) {
  const branch = readImportsBranch(hostAddon, platform);
  const candidate = platform === 'android' ? readImportsBranch(branch, 'arm64') : branch;
  const name = Array.isArray(candidate) ? candidate[0] : candidate;
  if (typeof name !== 'string' || name.startsWith('.')) return null;
  return name;
}

function readImportsBranch(value, key) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value[key];
}

export function readHostAddonPackage(packageRoot) {
  const manifest = readManifest(packageRoot);
  if (manifest?.imports?.[HOST_ADDON_IMPORT] === undefined) return null;
  return {
    name: manifest.name,
    version: manifest.version,
    hostAddon: manifest.imports[HOST_ADDON_IMPORT],
    packageRoot,
  };
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

      const pkg = readHostAddonPackage(packageRoot);
      if (pkg !== null) found.push(pkg);
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

// The platform package each split addon needs per platform. Only the meta
// package's own platform packages are considered (the map is registry-controlled,
// so it may confirm the slicer's naming, never choose an unrelated package).
export function planPlatformPackages(packages, platforms, modulesDir) {
  const plan = new Map();
  for (const platform of platforms) {
    for (const pkg of packages) {
      const platformPackage = resolvePlatformPackageName(pkg.hostAddon, platform);
      if (platformPackage === null || !platformPackage.startsWith(`${pkg.name}-`)) continue;

      if (readManifest(path.join(modulesDir, platformPackage))?.version === pkg.version) {
        continue;
      }
      const previous = plan.get(platformPackage);
      if (previous !== undefined) {
        if (previous.version !== pkg.version) {
          throw new Error(
            `${pkg.name} is installed at both ${previous.version} and ${pkg.version}; ` +
              `${platformPackage} can only match one of them`,
          );
        }
        continue;
      }
      plan.set(platformPackage, { ...pkg, platformPackage });
    }
  }
  return [...plan.values()];
}

// Saved to the app manifest: a mobile app depends on its platform packages
// directly, and the framework's later `npm install` must not prune them.
export function installWithNpm(specs, { cwd }) {
  const flags = ['--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps'];
  execFileSync('npm', ['install', ...flags, ...specs], { cwd, stdio: 'inherit' });
}

export function installPlatformPackages({
  appDir,
  addonDir,
  platforms = PLATFORMS,
  install = installWithNpm,
  log = console.log,
}) {
  const packages = [
    readHostAddonPackage(addonDir),
    ...findHostAddonPackages(path.join(addonDir, 'node_modules')),
  ].filter((pkg) => pkg !== null);
  const plan = planPlatformPackages(packages, platforms, path.join(appDir, 'node_modules'));
  if (plan.length === 0) {
    log('No split addon needs a mobile platform package.');
    return [];
  }

  const specs = plan.map((entry) => `${entry.platformPackage}@${entry.version}`);
  install(specs, { cwd: appDir });
  for (const entry of plan) {
    log(`Installed ${entry.platformPackage}@${entry.version} from the registry`);
  }
  return plan;
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app-dir') args.appDir = argv[++i];
    else if (argv[i] === '--addon-dir') args.addonDir = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.appDir || !args.addonDir) throw new Error('--app-dir and --addon-dir are required');
  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  installPlatformPackages({
    appDir: path.resolve(args.appDir),
    addonDir: path.resolve(args.addonDir),
  });
}
