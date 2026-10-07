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
// A platform package comes from one of three places:
//   - a prebuilds tree passed with --prebuilds <meta package>=<dir> (a
//     fabric CI run, say), which must cover every target host.
//   - the meta package's own prebuilds/<host>, when it carries them (GPR dev
//     builds are published unsliced, and CI packs the addon under test with
//     its fresh prebuilds). It is assembled under <app>/.qvac-platform-packages
//     and installed from there as a file: dependency.
//   - otherwise the registry, at the meta package's exact version.
//
// Usage: node install-platform-packages.mjs --app-dir <dir> --addon-dir <dir>
//          [--prebuilds <package>=<dir> ...]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_ADDON_IMPORT = '#host-addon';
const PLATFORM_INDEX_SOURCE = 'module.exports = require.addon()\n';
const STAGING_DIR = '.qvac-platform-packages';

export const TARGET_HOSTS = {
  android: ['android-arm64'],
  ios: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator'],
};

export const PLATFORMS = Object.keys(TARGET_HOSTS);

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

// The platform package each split addon needs per platform, and where it
// comes from. Only the meta package's own platform packages are considered
// (the map is registry-controlled, so it may confirm the slicer's naming, never
// choose an unrelated package), and one already installed at the meta's
// version is kept.
export function planPlatformPackages(packages, platforms, modulesDir) {
  const plan = new Map();
  for (const platform of platforms) {
    for (const pkg of packages) {
      const platformPackage = resolvePlatformPackageName(pkg.hostAddon, platform);
      if (platformPackage === null || !platformPackage.startsWith(`${pkg.name}-`)) continue;
      if (readManifest(path.join(modulesDir, platformPackage))?.version === pkg.version) continue;

      const prebuildsRoot = pkg.prebuildsRoot ?? path.join(pkg.packageRoot, 'prebuilds');
      const localHosts = TARGET_HOSTS[platform].filter((host) =>
        fs.existsSync(path.join(prebuildsRoot, host, `${mangledAddonName(platformPackage)}.bare`)),
      );
      if (pkg.prebuildsRoot !== undefined && localHosts.length !== TARGET_HOSTS[platform].length) {
        const missing = TARGET_HOSTS[platform].filter((host) => !localHosts.includes(host));
        throw new Error(
          `${pkg.prebuildsRoot} has no ${mangledAddonName(platformPackage)}.bare for ${missing.join(', ')}`,
        );
      }
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
      plan.set(platformPackage, { ...pkg, platformPackage, prebuildsRoot, localHosts });
    }
  }
  return [...plan.values()];
}

// Writes <stagingRoot>/<mangled name> from the meta package's own
// prebuilds/<host>, in the layout the slicer publishes.
export function assemblePlatformPackage(entry, stagingRoot) {
  const root = path.join(stagingRoot, mangledAddonName(entry.platformPackage));
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
    fs.cpSync(path.join(entry.prebuildsRoot, host), path.join(root, 'prebuilds', host), {
      recursive: true,
    });
  }
  return root;
}

// The framework's later installs must also copy the file: dependencies rather
// than symlink them.
export function enableInstallLinks(appDir) {
  const npmrc = path.join(appDir, '.npmrc');
  const current = fs.existsSync(npmrc) ? fs.readFileSync(npmrc, 'utf8') : '';
  if (/^install-links\s*=\s*true\s*$/m.test(current)) return;
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(npmrc, `${current}${separator}install-links=true\n`);
}

// Saved to the app manifest: a mobile app depends on its platform packages
// directly, and the framework's later `npm install` must not prune them.
// --install-links copies a file: dependency instead of symlinking it.
export function installWithNpm(specs, { cwd }) {
  const flags = ['--save-exact', '--install-links', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps'];
  execFileSync('npm', ['install', ...flags, ...specs], { cwd, stdio: 'inherit' });
}

export function installPlatformPackages({
  appDir,
  addonDir,
  prebuilds = {},
  platforms = PLATFORMS,
  install = installWithNpm,
  log = console.log,
}) {
  const packages = [
    readHostAddonPackage(addonDir),
    ...findHostAddonPackages(path.join(addonDir, 'node_modules')),
  ]
    .filter((pkg) => pkg !== null)
    .map((pkg) => (prebuilds[pkg.name] === undefined ? pkg : { ...pkg, prebuildsRoot: prebuilds[pkg.name] }));
  for (const name of Object.keys(prebuilds)) {
    if (!packages.some((pkg) => pkg.name === name)) {
      throw new Error(`--prebuilds names ${name}, but the addon does not install it`);
    }
  }
  const plan = planPlatformPackages(packages, platforms, path.join(appDir, 'node_modules'));
  if (plan.length === 0) {
    log('No split addon needs a mobile platform package.');
    return [];
  }

  const stagingRoot = path.join(appDir, STAGING_DIR);
  if (plan.some((entry) => entry.localHosts.length > 0)) enableInstallLinks(appDir);
  const specs = plan.map((entry) => {
    if (entry.localHosts.length === 0) return `${entry.platformPackage}@${entry.version}`;
    const root = assemblePlatformPackage(entry, stagingRoot);
    log(`Assembled ${entry.platformPackage}@${entry.version} (${entry.localHosts.join(', ')}) at ${root}`);
    return `file:${path.relative(appDir, root)}`;
  });
  install(specs, { cwd: appDir });
  for (const entry of plan) {
    const source = entry.localHosts.length === 0 ? 'the registry' : `${entry.name}'s prebuilds`;
    log(`Installed ${entry.platformPackage}@${entry.version} from ${source}`);
  }
  return plan;
}

export function parseArgs(argv) {
  const args = { prebuilds: {} };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app-dir') args.appDir = argv[++i];
    else if (argv[i] === '--addon-dir') args.addonDir = argv[++i];
    else if (argv[i] === '--prebuilds') {
      const value = argv[++i] ?? '';
      const separator = value.indexOf('=', 1);
      if (separator === -1) throw new Error(`--prebuilds expects <package>=<dir>, got '${value}'`);
      args.prebuilds[value.slice(0, separator)] = path.resolve(value.slice(separator + 1));
    } else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.appDir || !args.addonDir) throw new Error('--app-dir and --addon-dir are required');
  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  installPlatformPackages({
    appDir: path.resolve(args.appDir),
    addonDir: path.resolve(args.addonDir),
    prebuilds: args.prebuilds,
  });
}
