// Run: node --test .github/actions/run-mobile-integration-tests/build-mobile-app/install-platform-packages.test.mjs
//
// Network-free: installPlatformPackages() takes an injected npm installer.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  enableInstallLinks,
  findHostAddonPackages,
  installPlatformPackages,
  mangledAddonName,
  parseArgs,
  planPlatformPackages,
  resolvePlatformPackageName,
} from './install-platform-packages.mjs';

function hostAddonMap(meta) {
  return {
    linux: { x64: `${meta}-linux-x64`, default: './addon-unavailable.js' },
    android: { arm64: `${meta}-android-arm64`, default: './addon-unavailable.js' },
    ios: `${meta}-ios`,
    default: './addon-unavailable.js',
  };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-packages-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePackage(root, manifest, files = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  }
  return root;
}

function unslicedPrebuilds(module, hosts) {
  const files = {};
  for (const host of hosts) {
    files[`prebuilds/${host}/${module}.bare`] = host;
    files[`prebuilds/${host}/${module}/libqvac-ggml-cpu.so`] = host;
  }
  return files;
}

function writeSplit(root, name, version, files = {}) {
  return writePackage(root, { name, version, imports: { '#host-addon': hostAddonMap(name) } }, files);
}

function writeFabric(modules, version, files = {}) {
  return writeSplit(path.join(modules, '@qvac/fabric'), '@qvac/fabric', version, files);
}

// An addon checkout next to a test app, the layout build-mobile-app runs in.
function workspace(t) {
  const root = tempDir(t);
  const addonDir = writePackage(path.join(root, 'addon'), { name: '@qvac/llm-llamacpp', version: '1.0.0' });
  const appDir = writePackage(path.join(root, 'app'), { name: 'app', version: '1.0.0' });
  return { addonDir, appDir };
}

function recordInstalls() {
  const installs = [];
  const install = (specs, { cwd }) => installs.push({ specs, cwd });
  return { installs, install };
}

test('resolvePlatformPackageName reads the arm64 arm on Android and the flat iOS arm', () => {
  const map = hostAddonMap('@qvac/fabric');
  assert.equal(resolvePlatformPackageName(map, 'android'), '@qvac/fabric-android-arm64');
  assert.equal(resolvePlatformPackageName(map, 'ios'), '@qvac/fabric-ios');
  assert.equal(resolvePlatformPackageName({ default: './addon-unavailable.js' }, 'ios'), null);
  assert.equal(resolvePlatformPackageName({ ios: './addon-unavailable.js' }, 'ios'), null);
  assert.equal(resolvePlatformPackageName(undefined, 'android'), null);
});

test('mangledAddonName matches the module name cmake-bare derives', () => {
  assert.equal(mangledAddonName('@qvac/fabric-android-arm64'), 'qvac__fabric-android-arm64');
  assert.equal(mangledAddonName('plain-ios'), 'plain-ios');
});

test('findHostAddonPackages finds scoped, nested, and symlinked packages once', (t) => {
  const modules = path.join(tempDir(t), 'node_modules');
  const fabric = writeFabric(modules, '0.21.0');
  writePackage(path.join(modules, '@qvac/llm-llamacpp'), { name: '@qvac/llm-llamacpp', version: '1.0.0' });
  writeFabric(path.join(modules, '@qvac/llm-llamacpp/node_modules'), '0.20.0');
  writePackage(path.join(modules, 'plain'), { name: 'plain', version: '1.0.0' });
  fs.symlinkSync(fabric, path.join(modules, 'fabric-link'), 'dir');

  const found = findHostAddonPackages(modules);
  assert.deepEqual(found.map((pkg) => pkg.version).sort(), ['0.20.0', '0.21.0']);
});

test('planPlatformPackages keeps installed ones and refuses foreign names', (t) => {
  const modules = path.join(tempDir(t), 'node_modules');
  writePackage(path.join(modules, '@qvac/tts-ggml-android-arm64'), {
    name: '@qvac/tts-ggml-android-arm64',
    version: '1.0.0',
  });
  const packages = [
    { name: '@qvac/fabric', version: '0.21.0', hostAddon: hostAddonMap('@qvac/fabric'), packageRoot: modules },
    { name: '@qvac/tts-ggml', version: '1.0.0', hostAddon: hostAddonMap('@qvac/tts-ggml'), packageRoot: modules },
    { name: '@qvac/other', version: '1.0.0', hostAddon: hostAddonMap('@qvac/fabric'), packageRoot: modules },
  ];

  const plan = planPlatformPackages(packages, ['android'], modules);
  assert.deepEqual(
    plan.map((entry) => [entry.name, entry.platformPackage, entry.localHosts]),
    [['@qvac/fabric', '@qvac/fabric-android-arm64', []]],
  );
  assert.equal(planPlatformPackages(packages, ['ios'], modules).length, 2);
  assert.equal(planPlatformPackages(packages, ['android', 'ios'], modules).length, 3);
});

test('planPlatformPackages refuses two meta versions sharing one platform package', (t) => {
  const modules = path.join(tempDir(t), 'node_modules');
  const map = hostAddonMap('@qvac/fabric');
  const packages = [
    { name: '@qvac/fabric', version: '0.21.0', hostAddon: map, packageRoot: modules },
    { name: '@qvac/fabric', version: '0.20.0', hostAddon: map, packageRoot: modules },
  ];
  assert.throws(() => planPlatformPackages(packages, ['android'], modules), /both 0.21.0 and 0.20.0/);
});

test('installPlatformPackages fetches both mobile platforms of a dependency from the registry', (t) => {
  const { addonDir, appDir } = workspace(t);
  writeFabric(path.join(addonDir, 'node_modules'), '0.21.0');
  const { installs, install } = recordInstalls();

  const result = installPlatformPackages({ appDir, addonDir, install, log: () => {} });

  assert.deepEqual(installs, [
    { specs: ['@qvac/fabric-android-arm64@0.21.0', '@qvac/fabric-ios@0.21.0'], cwd: appDir },
  ]);
  assert.equal(result.length, 2);
  assert.ok(!fs.existsSync(path.join(appDir, '.npmrc')));
});

test('installPlatformPackages assembles the addon under test from its own prebuilds', (t) => {
  const { appDir } = workspace(t);
  const addonDir = writeSplit(path.join(path.dirname(appDir), 'tts'), '@qvac/tts-ggml', '0.11.0', {
    ...unslicedPrebuilds('qvac__tts-ggml-android-arm64', ['android-arm64']),
    ...unslicedPrebuilds('qvac__tts-ggml-ios', ['ios-arm64', 'ios-arm64-simulator']),
  });
  const { installs, install } = recordInstalls();

  installPlatformPackages({ appDir, addonDir, install, log: () => {} });

  assert.deepEqual(installs, [
    {
      specs: [
        'file:.qvac-platform-packages/qvac__tts-ggml-android-arm64',
        'file:.qvac-platform-packages/qvac__tts-ggml-ios',
      ],
      cwd: appDir,
    },
  ]);
  const slice = path.join(appDir, '.qvac-platform-packages/qvac__tts-ggml-ios');
  const manifest = JSON.parse(fs.readFileSync(path.join(slice, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@qvac/tts-ggml-ios');
  assert.equal(manifest.version, '0.11.0');
  assert.equal(manifest.addon, true);
  assert.equal(fs.readFileSync(path.join(slice, 'index.js'), 'utf8'), 'module.exports = require.addon()\n');
  assert.ok(fs.existsSync(path.join(slice, 'prebuilds/ios-arm64/qvac__tts-ggml-ios.bare')));
  assert.ok(fs.existsSync(path.join(slice, 'prebuilds/ios-arm64-simulator/qvac__tts-ggml-ios/libqvac-ggml-cpu.so')));
  assert.ok(!fs.existsSync(path.join(slice, 'prebuilds/ios-x64-simulator')));
  assert.equal(fs.readFileSync(path.join(appDir, '.npmrc'), 'utf8'), 'install-links=true\n');
});

test('installPlatformPackages fetches what the prebuilds do not cover', (t) => {
  const { appDir } = workspace(t);
  const addonDir = writeSplit(
    path.join(path.dirname(appDir), 'tts'),
    '@qvac/tts-ggml',
    '0.11.0',
    unslicedPrebuilds('qvac__tts-ggml-android-arm64', ['android-arm64']),
  );
  const { installs, install } = recordInstalls();

  installPlatformPackages({ appDir, addonDir, install, log: () => {} });

  assert.deepEqual(installs[0].specs, [
    'file:.qvac-platform-packages/qvac__tts-ggml-android-arm64',
    '@qvac/tts-ggml-ios@0.11.0',
  ]);
});

test('installPlatformPackages ignores prebuilds named for another package', (t) => {
  const { addonDir, appDir } = workspace(t);
  writeFabric(path.join(addonDir, 'node_modules'), '0.21.0', unslicedPrebuilds('qvac__fabric', ['android-arm64']));
  const { installs, install } = recordInstalls();

  installPlatformPackages({ appDir, addonDir, platforms: ['android'], install, log: () => {} });

  assert.deepEqual(installs[0].specs, ['@qvac/fabric-android-arm64@0.21.0']);
});

test('installPlatformPackages skips what the app already has', (t) => {
  const { addonDir, appDir } = workspace(t);
  writeFabric(path.join(addonDir, 'node_modules'), '0.21.0');
  for (const name of ['@qvac/fabric-android-arm64', '@qvac/fabric-ios']) {
    writePackage(path.join(appDir, 'node_modules', name), { name, version: '0.21.0' });
  }

  const result = installPlatformPackages({
    appDir,
    addonDir,
    install: () => assert.fail('no install'),
    log: () => {},
  });
  assert.equal(result.length, 0);
});

test('enableInstallLinks appends once and keeps the existing settings', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, '.npmrc'), 'legacy-peer-deps=true');
  enableInstallLinks(dir);
  enableInstallLinks(dir);
  assert.equal(fs.readFileSync(path.join(dir, '.npmrc'), 'utf8'), 'legacy-peer-deps=true\ninstall-links=true\n');
});

test('installPlatformPackages builds a dependency from a --prebuilds tree', (t) => {
  const { addonDir, appDir } = workspace(t);
  writeFabric(path.join(addonDir, 'node_modules'), '0.21.0');
  const run = tempDir(t);
  writePackage(run, {}, {
    ...unslicedPrebuilds('qvac__fabric-android-arm64', ['android-arm64']),
    ...unslicedPrebuilds('qvac__fabric-ios', ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator']),
  });
  const { installs, install } = recordInstalls();

  installPlatformPackages({
    appDir,
    addonDir,
    prebuilds: { '@qvac/fabric': path.join(run, 'prebuilds') },
    install,
    log: () => {},
  });

  assert.deepEqual(installs[0].specs, [
    'file:.qvac-platform-packages/qvac__fabric-android-arm64',
    'file:.qvac-platform-packages/qvac__fabric-ios',
  ]);
  const slice = path.join(appDir, '.qvac-platform-packages/qvac__fabric-android-arm64');
  assert.equal(JSON.parse(fs.readFileSync(path.join(slice, 'package.json'), 'utf8')).version, '0.21.0');
  assert.ok(fs.existsSync(path.join(slice, 'prebuilds/android-arm64/qvac__fabric-android-arm64/libqvac-ggml-cpu.so')));
});

test('installPlatformPackages refuses a --prebuilds tree missing a host', (t) => {
  const { addonDir, appDir } = workspace(t);
  writeFabric(path.join(addonDir, 'node_modules'), '0.21.0');
  const run = tempDir(t);
  writePackage(run, {}, {
    ...unslicedPrebuilds('qvac__fabric-android-arm64', ['android-arm64']),
    ...unslicedPrebuilds('qvac__fabric-ios', ['ios-arm64']),
  });
  const { installs, install } = recordInstalls();

  assert.throws(
    () =>
      installPlatformPackages({
        appDir,
        addonDir,
        prebuilds: { '@qvac/fabric': path.join(run, 'prebuilds') },
        install,
        log: () => {},
      }),
    /no qvac__fabric-ios\.bare for ios-arm64-simulator, ios-x64-simulator/,
  );
  assert.deepEqual(installs, []);
});

test('installPlatformPackages refuses --prebuilds for a package the addon does not install', (t) => {
  const { addonDir, appDir } = workspace(t);
  const { install } = recordInstalls();
  assert.throws(
    () => installPlatformPackages({ appDir, addonDir, prebuilds: { '@qvac/fabric': appDir }, install, log: () => {} }),
    /--prebuilds names @qvac\/fabric, but the addon does not install it/,
  );
});

test('parseArgs splits --prebuilds at the first = after the scope', () => {
  const args = parseArgs(['--app-dir', 'a', '--addon-dir', 'b', '--prebuilds', '@qvac/fabric=/tmp/x=y']);
  assert.deepEqual(args.prebuilds, { '@qvac/fabric': '/tmp/x=y' });
  assert.throws(() => parseArgs(['--app-dir', 'a', '--addon-dir', 'b', '--prebuilds', '@qvac/fabric']), /expects/);
});
