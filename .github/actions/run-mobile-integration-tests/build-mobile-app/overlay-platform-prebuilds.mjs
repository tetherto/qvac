// Copies each split addon's mobile platform package into the addon's own
// prebuilds/ so bare-pack and bare-link see the runtime.
//
// The test framework installs the addon under test with npm, and npm never
// selects a cross-built platform package: its os/cpu never match the install
// host. bare-link also reads only a package's own prebuilds/<host>, never the
// nested addon/ of a platform package. A split addon (one routing its binding
// through a `#host-addon` imports map, such as @qvac/fabric) therefore reaches
// the app with no native runtime unless its prebuilds are overlaid here. The
// loaders already prefer a runtime in the package's own prebuilds/.
//
// Usage: node overlay-platform-prebuilds.mjs --platform Android|iOS [--modules-dir node_modules]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_ADDON_IMPORT = '#host-addon';

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
  const candidate = platform === 'android' ? readImportsBranch(branch, 'arm64') : branch;
  const name = Array.isArray(candidate) ? candidate[0] : candidate;
  if (typeof name !== 'string' || name.startsWith('.')) return null;
  return name;
}

function readImportsBranch(value, key) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value[key];
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

// Packages that need an overlay: the map names one of the package's own
// slices for this platform, and no local prebuild for the platform exists
// (CI packs split addons under test with theirs).
export function planOverlays(packages, platform) {
  const plan = [];
  for (const pkg of packages) {
    const platformPackage = resolvePlatformPackageName(pkg.hostAddon, platform);
    if (platformPackage === null || !platformPackage.startsWith(`${pkg.name}-`)) continue;
    if (hasLocalPrebuild(pkg.packageRoot, platform)) continue;
    plan.push({ ...pkg, platformPackage });
  }
  return plan;
}

function hasLocalPrebuild(packageRoot, platform) {
  return TARGET_HOSTS[platform].some((host) =>
    fs.existsSync(path.join(packageRoot, 'prebuilds', host)),
  );
}

// Copies the slice's addon/prebuilds/<host> for every target host it ships.
export function applyOverlay(entry, sliceRoot, platform) {
  const slicePrebuilds = path.join(sliceRoot, 'addon', 'prebuilds');
  const hosts = TARGET_HOSTS[platform].filter((host) =>
    fs.existsSync(path.join(slicePrebuilds, host)),
  );
  if (hosts.length === 0) {
    throw new Error(
      `${entry.platformPackage}@${entry.version} ships none of ${TARGET_HOSTS[platform].join(', ')} ` +
        `under addon/prebuilds`,
    );
  }
  for (const host of hosts) {
    fs.cpSync(path.join(slicePrebuilds, host), path.join(entry.packageRoot, 'prebuilds', host), {
      recursive: true,
    });
  }
  return hosts;
}

// `npm pack` downloads the registry tarball without running any package
// scripts. The slice is pinned to the meta package's exact version: its .bare
// is built against that version's JS layer.
export function fetchSliceWithNpm(spec, { cwd, workDir }) {
  const output = execFileSync('npm', ['pack', spec, '--pack-destination', workDir, '--json'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [{ filename }] = JSON.parse(output);
  const extractDir = fs.mkdtempSync(path.join(workDir, 'slice-'));
  execFileSync('tar', ['-xzf', path.join(workDir, filename), '-C', extractDir], {
    stdio: 'inherit',
  });
  return path.join(extractDir, 'package');
}

export function overlayPlatformPrebuilds({
  modulesDir,
  platform,
  fetchSlice = fetchSliceWithNpm,
  log = console.log,
}) {
  const plan = planOverlays(findHostAddonPackages(modulesDir), platform);
  if (plan.length === 0) {
    log(`No split addon needs a ${platform} platform package overlay.`);
    return [];
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-platform-overlay-'));
  try {
    return plan.map((entry) => {
      const spec = `${entry.platformPackage}@${entry.version}`;
      const sliceRoot = fetchSlice(spec, { cwd: path.dirname(modulesDir), workDir });
      const hosts = applyOverlay(entry, sliceRoot, platform);
      log(`Overlaid ${spec} (${hosts.join(', ')}) into ${entry.packageRoot}/prebuilds`);
      return { ...entry, hosts };
    });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
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
  overlayPlatformPrebuilds({
    modulesDir: path.resolve(args.modulesDir),
    platform: normalisePlatform(args.platform),
  });
}
