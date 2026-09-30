// Run: node --test .github/actions/run-mobile-integration-tests/build-mobile-app/overlay-platform-prebuilds.test.mjs
//
// Network-free: overlayPlatformPrebuilds() takes an injected slice fetcher.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyFabricPrebuilds,
  applyOverlay,
  findHostAddonPackages,
  normalisePlatform,
  overlayPlatformPrebuilds,
  planOverlays,
  resolvePlatformPackageName,
} from './overlay-platform-prebuilds.mjs';

function hostAddonMap(meta) {
  return {
    linux: { x64: [`${meta}-linux-x64`, './addon-unavailable.js'], default: './addon-unavailable.js' },
    android: {
      arm64: [`${meta}-android-arm64`, './addon-unavailable.js'],
      default: './addon-unavailable.js',
    },
    ios: [`${meta}-ios`, './addon-unavailable.js'],
    default: './addon-unavailable.js',
  };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-test-'));
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

function writeSlice(root, hosts) {
  const files = {};
  for (const host of hosts) {
    files[`addon/prebuilds/${host}/qvac__fabric.bare`] = host;
    files[`addon/prebuilds/${host}/qvac__fabric/libqvac-ggml-cpu.so`] = host;
  }
  return writePackage(root, { name: 'slice' }, files);
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

test('findHostAddonPackages finds scoped, nested, and symlinked packages once', (t) => {
  const modules = path.join(tempDir(t), 'node_modules');
  const fabric = writePackage(path.join(modules, '@qvac/fabric'), {
    name: '@qvac/fabric',
    version: '0.18.0',
    imports: { '#host-addon': hostAddonMap('@qvac/fabric') },
  });
  writePackage(path.join(modules, '@qvac/llm-llamacpp'), { name: '@qvac/llm-llamacpp', version: '1.0.0' });
  writePackage(path.join(modules, '@qvac/llm-llamacpp/node_modules/@qvac/fabric'), {
    name: '@qvac/fabric',
    version: '0.17.0',
    imports: { '#host-addon': hostAddonMap('@qvac/fabric') },
  });
  writePackage(path.join(modules, 'plain'), { name: 'plain', version: '1.0.0' });
  fs.symlinkSync(fabric, path.join(modules, 'fabric-link'), 'dir');

  const found = findHostAddonPackages(modules);
  assert.deepEqual(found.map((pkg) => pkg.version).sort(), ['0.17.0', '0.18.0']);
});

test('planOverlays skips packages with local prebuilds and maps naming foreign packages', (t) => {
  const root = tempDir(t);
  const needs = writePackage(path.join(root, 'fabric'), { name: '@qvac/fabric' });
  const packed = writePackage(path.join(root, 'tts'), { name: '@qvac/tts-ggml' }, {
    'prebuilds/android-arm64/qvac__tts-ggml.bare': '',
  });
  const foreign = writePackage(path.join(root, 'foreign'), { name: '@qvac/other' });
  const packages = [
    { name: '@qvac/fabric', version: '0.18.0', hostAddon: hostAddonMap('@qvac/fabric'), packageRoot: needs },
    { name: '@qvac/tts-ggml', version: '1.0.0', hostAddon: hostAddonMap('@qvac/tts-ggml'), packageRoot: packed },
    { name: '@qvac/other', version: '1.0.0', hostAddon: hostAddonMap('@qvac/fabric'), packageRoot: foreign },
  ];

  const plan = planOverlays(packages, 'android');
  assert.deepEqual(
    plan.map((entry) => [entry.name, entry.platformPackage]),
    [['@qvac/fabric', '@qvac/fabric-android-arm64']],
  );
  assert.equal(planOverlays(packages, 'ios').length, 2);
});

test('applyOverlay copies every target host the slice ships', (t) => {
  const root = tempDir(t);
  const packageRoot = writePackage(path.join(root, 'fabric'), { name: '@qvac/fabric' });
  const slice = writeSlice(path.join(root, 'slice'), ['ios-arm64', 'ios-arm64-simulator']);
  const entry = { packageRoot, platformPackage: '@qvac/fabric-ios', version: '0.18.0' };

  assert.deepEqual(applyOverlay(entry, slice, 'ios'), ['ios-arm64', 'ios-arm64-simulator']);
  assert.ok(fs.existsSync(path.join(packageRoot, 'prebuilds/ios-arm64/qvac__fabric.bare')));
  assert.ok(fs.existsSync(path.join(packageRoot, 'prebuilds/ios-arm64/qvac__fabric/libqvac-ggml-cpu.so')));
  assert.ok(!fs.existsSync(path.join(packageRoot, 'prebuilds/ios-x64-simulator')));
});

test('applyOverlay fails when the slice ships no target host', (t) => {
  const root = tempDir(t);
  const packageRoot = writePackage(path.join(root, 'fabric'), { name: '@qvac/fabric' });
  const slice = writeSlice(path.join(root, 'slice'), ['linux-x64']);
  const entry = { packageRoot, platformPackage: '@qvac/fabric-android-arm64', version: '0.18.0' };

  assert.throws(() => applyOverlay(entry, slice, 'android'), /ships none of android-arm64/);
});

test('overlayPlatformPrebuilds fetches the slice at the meta package version', (t) => {
  const root = tempDir(t);
  const modules = path.join(root, 'node_modules');
  const fabric = writePackage(path.join(modules, '@qvac/fabric'), {
    name: '@qvac/fabric',
    version: '0.18.0',
    imports: { '#host-addon': hostAddonMap('@qvac/fabric') },
  });
  const slice = writeSlice(path.join(root, 'slice'), ['android-arm64']);
  const fetched = [];

  const result = overlayPlatformPrebuilds({
    modulesDir: modules,
    platform: 'android',
    fetchSlice: (spec, { cwd }) => {
      fetched.push([spec, cwd]);
      return slice;
    },
    log: () => {},
  });

  assert.deepEqual(fetched, [['@qvac/fabric-android-arm64@0.18.0', root]]);
  assert.deepEqual(result.map((entry) => entry.hosts), [['android-arm64']]);
  assert.ok(fs.existsSync(path.join(fabric, 'prebuilds/android-arm64/qvac__fabric.bare')));
});

// A `prebuild-fabric-<host>` artifact: <host>/ at the root, next to include/ and share/.
function writeFabricPrebuilds(root, hosts, marker) {
  const files = { 'include/ggml.h': '', 'share/qvac-fabric/cmake/qvac-fabricConfig.cmake': '' };
  for (const host of hosts) {
    files[`${host}/qvac__fabric.bare`] = marker;
    files[`${host}/qvac__fabric/libqvac-ggml-cpu.so`] = marker;
  }
  return writePackage(root, { name: 'artifact' }, files);
}

test('overlayPlatformPrebuilds takes @qvac/fabric from the PR prebuilds and never fetches its slice', (t) => {
  const root = tempDir(t);
  const modules = path.join(root, 'node_modules');
  const fabric = writePackage(path.join(modules, '@qvac/fabric'), {
    name: '@qvac/fabric',
    version: '0.18.1',
    imports: { '#host-addon': hostAddonMap('@qvac/fabric') },
  }, {
    'prebuilds/android-arm64/qvac__fabric/libqvac-ggml-stale.so': 'published',
  });
  const tts = writePackage(path.join(modules, '@qvac/tts-ggml'), {
    name: '@qvac/tts-ggml',
    version: '1.0.0',
    imports: { '#host-addon': hostAddonMap('@qvac/tts-ggml') },
  });
  const prFabric = writeFabricPrebuilds(path.join(root, 'pr-fabric'), ['android-arm64'], 'pr');
  const slice = writeSlice(path.join(root, 'slice'), ['android-arm64']);
  const fetched = [];

  const result = overlayPlatformPrebuilds({
    modulesDir: modules,
    platform: 'android',
    fabricPrebuildsDir: prFabric,
    fetchSlice: (spec) => {
      fetched.push(spec);
      return slice;
    },
    log: () => {},
  });

  assert.deepEqual(fetched, ['@qvac/tts-ggml-android-arm64@1.0.0']);
  assert.deepEqual(result.map((entry) => entry.name).sort(), ['@qvac/fabric', '@qvac/tts-ggml']);
  assert.equal(fs.readFileSync(path.join(fabric, 'prebuilds/android-arm64/qvac__fabric.bare'), 'utf8'), 'pr');
  assert.ok(!fs.existsSync(path.join(fabric, 'prebuilds/android-arm64/qvac__fabric/libqvac-ggml-stale.so')));
  assert.ok(fs.existsSync(path.join(tts, 'prebuilds/android-arm64/qvac__fabric.bare')));
});

test('applyFabricPrebuilds fails when the PR prebuilds lack every target host', (t) => {
  const root = tempDir(t);
  const packageRoot = writePackage(path.join(root, 'fabric'), { name: '@qvac/fabric' });
  const prFabric = writeFabricPrebuilds(path.join(root, 'pr-fabric'), ['linux-x64'], 'pr');

  assert.throws(() => applyFabricPrebuilds(packageRoot, prFabric, 'android'), /hold none of android-arm64/);
});

test('overlayPlatformPrebuilds fails when PR prebuilds are given but @qvac/fabric is not installed', (t) => {
  const root = tempDir(t);
  const modules = path.join(root, 'node_modules');
  writePackage(path.join(modules, 'plain'), { name: 'plain', version: '1.0.0' });
  const prFabric = writeFabricPrebuilds(path.join(root, 'pr-fabric'), ['android-arm64'], 'pr');

  assert.throws(
    () => overlayPlatformPrebuilds({ modulesDir: modules, platform: 'android', fabricPrebuildsDir: prFabric, log: () => {} }),
    /no @qvac\/fabric is installed/,
  );
});
