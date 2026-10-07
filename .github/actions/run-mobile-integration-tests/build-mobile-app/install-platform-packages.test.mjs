// Run: node --test .github/actions/run-mobile-integration-tests/build-mobile-app/install-platform-packages.test.mjs
//
// Network-free: installPlatformPackages() takes an injected npm installer.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findHostAddonPackages,
  installPlatformPackages,
  mangledAddonName,
  normalisePlatform,
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

function writeFabric(modules, version, files = {}) {
  return writePackage(
    path.join(modules, '@qvac/fabric'),
    { name: '@qvac/fabric', version, imports: { '#host-addon': hostAddonMap('@qvac/fabric') } },
    files,
  );
}

test('normalisePlatform accepts the action inputs and rejects others', () => {
  assert.equal(normalisePlatform('Android'), 'android');
  assert.equal(normalisePlatform('iOS'), 'ios');
  assert.throws(() => normalisePlatform('linux'), /Android or iOS/);
  assert.throws(() => normalisePlatform(undefined), /Android or iOS/);
});

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

  const plan = planPlatformPackages(packages, 'android', modules);
  assert.deepEqual(
    plan.map((entry) => [entry.name, entry.platformPackage, entry.localHosts]),
    [['@qvac/fabric', '@qvac/fabric-android-arm64', []]],
  );
  assert.equal(planPlatformPackages(packages, 'ios', modules).length, 2);
});

test('planPlatformPackages refuses two meta versions sharing one platform package', (t) => {
  const modules = path.join(tempDir(t), 'node_modules');
  const map = hostAddonMap('@qvac/fabric');
  const packages = [
    { name: '@qvac/fabric', version: '0.21.0', hostAddon: map, packageRoot: modules },
    { name: '@qvac/fabric', version: '0.20.0', hostAddon: map, packageRoot: modules },
  ];
  assert.throws(() => planPlatformPackages(packages, 'android', modules), /both 0.21.0 and 0.20.0/);
});

test('installPlatformPackages installs a sliced meta package from the registry', (t) => {
  const root = tempDir(t);
  const modules = path.join(root, 'node_modules');
  writeFabric(modules, '0.21.0');
  const installs = [];

  const result = installPlatformPackages({
    modulesDir: modules,
    platform: 'android',
    install: (specs, { cwd }) => installs.push([specs, cwd]),
    log: () => {},
  });

  assert.deepEqual(installs, [[['@qvac/fabric-android-arm64@0.21.0'], root]]);
  assert.equal(result.length, 1);
});

test('installPlatformPackages assembles an unsliced build from its own prebuilds', (t) => {
  const modules = path.join(tempDir(t), 'node_modules');
  writeFabric(
    modules,
    '0.21.0-dev.1',
    unslicedPrebuilds('qvac__fabric-ios', ['ios-arm64', 'ios-arm64-simulator']),
  );

  installPlatformPackages({
    modulesDir: modules,
    platform: 'ios',
    install: () => assert.fail('nothing to fetch'),
    log: () => {},
  });

  const slice = path.join(modules, '@qvac/fabric-ios');
  const manifest = JSON.parse(fs.readFileSync(path.join(slice, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@qvac/fabric-ios');
  assert.equal(manifest.version, '0.21.0-dev.1');
  assert.equal(manifest.addon, true);
  assert.equal(fs.readFileSync(path.join(slice, 'index.js'), 'utf8'), 'module.exports = require.addon()\n');
  assert.ok(fs.existsSync(path.join(slice, 'prebuilds/ios-arm64/qvac__fabric-ios.bare')));
  assert.ok(fs.existsSync(path.join(slice, 'prebuilds/ios-arm64-simulator/qvac__fabric-ios/libqvac-ggml-cpu.so')));
  assert.ok(!fs.existsSync(path.join(slice, 'prebuilds/ios-x64-simulator')));
});

test('installPlatformPackages ignores prebuilds named for another package', (t) => {
  const modules = path.join(tempDir(t), 'node_modules');
  writeFabric(modules, '0.21.0', unslicedPrebuilds('qvac__fabric', ['android-arm64']));
  const installs = [];

  installPlatformPackages({
    modulesDir: modules,
    platform: 'android',
    install: (specs) => installs.push(...specs),
    log: () => {},
  });

  assert.deepEqual(installs, ['@qvac/fabric-android-arm64@0.21.0']);
});

test('installPlatformPackages is a no-op once the package is in place', (t) => {
  const modules = path.join(tempDir(t), 'node_modules');
  writeFabric(modules, '0.21.0', unslicedPrebuilds('qvac__fabric-android-arm64', ['android-arm64']));
  const options = { modulesDir: modules, platform: 'android', install: () => assert.fail('no install'), log: () => {} };

  assert.equal(installPlatformPackages(options).length, 1);
  assert.equal(installPlatformPackages(options).length, 0);
});
