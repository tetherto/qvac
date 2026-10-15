// Run: node --test .github/actions/run-mobile-integration-tests/build-mobile-app/install-platform-packages.test.mjs
// Network-free: installPlatformPackages() takes an injected npm installer.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findHostAddonPackages,
  installPlatformPackages,
  parseArgs,
  planPlatformPackages,
  resolvePlatformPackageName,
} from './install-platform-packages.mjs';

function hostAddonMap(meta) {
  return {
    android: { arm64: [meta + '-android-arm64', './addon-unavailable.js'] },
    ios: [meta + '-ios', './addon-unavailable.js'],
    default: './addon-unavailable.js',
  };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-platform-packages-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePackage(root, manifest) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  return root;
}

function writeSplit(root, name, version) {
  return writePackage(root, {
    name,
    version,
    imports: { '#host-addon': hostAddonMap(name) },
  });
}

test('the mobile action installs platform packages before bundling', () => {
  const actionPath = fileURLToPath(new URL('./action.yml', import.meta.url));
  const source = fs.readFileSync(actionPath, 'utf8');
  const install = source.indexOf('- name: Install mobile platform packages');
  const build = source.indexOf('- name: Build test app with addon');

  assert.notEqual(install, -1);
  assert.notEqual(build, -1);
  assert.ok(install < build);
  assert.doesNotMatch(source, /Overlay mobile platform prebuilds/);
});

test('resolvePlatformPackageName supports the release line array fallbacks', () => {
  const map = hostAddonMap('@qvac/fabric');
  assert.equal(resolvePlatformPackageName(map, 'android'), '@qvac/fabric-android-arm64');
  assert.equal(resolvePlatformPackageName(map, 'ios'), '@qvac/fabric-ios');
  assert.equal(resolvePlatformPackageName({ ios: './addon-unavailable.js' }, 'ios'), null);
});

test('findHostAddonPackages finds nested split dependencies', (t) => {
  const modules = path.join(tempDir(t), 'node_modules');
  writeSplit(path.join(modules, '@qvac/fabric'), '@qvac/fabric', '0.19.1');
  writeSplit(
    path.join(modules, '@qvac/llm-llamacpp/node_modules/@qvac/fabric'),
    '@qvac/fabric',
    '0.19.0',
  );

  const found = findHostAddonPackages(modules);
  assert.deepEqual(found.map((pkg) => pkg.version).sort(), ['0.19.0', '0.19.1']);
});

test('planPlatformPackages installs both cross-built packages at the exact meta version', (t) => {
  const modules = path.join(tempDir(t), 'node_modules');
  const packages = [{
    name: '@qvac/fabric',
    version: '0.19.1',
    hostAddon: hostAddonMap('@qvac/fabric'),
    packageRoot: modules,
  }];

  const plan = planPlatformPackages(packages, ['android', 'ios'], modules);
  assert.deepEqual(
    plan.map((entry) => [entry.platformPackage, entry.version]),
    [
      ['@qvac/fabric-android-arm64', '0.19.1'],
      ['@qvac/fabric-ios', '0.19.1'],
    ],
  );
});

test('planPlatformPackages skips an exact package already installed in the app', (t) => {
  const modules = path.join(tempDir(t), 'node_modules');
  writePackage(path.join(modules, '@qvac/fabric-android-arm64'), {
    name: '@qvac/fabric-android-arm64',
    version: '0.19.1',
  });
  const packages = [{
    name: '@qvac/fabric',
    version: '0.19.1',
    hostAddon: hostAddonMap('@qvac/fabric'),
    packageRoot: modules,
  }];

  assert.equal(planPlatformPackages(packages, ['android'], modules).length, 0);
});

test('installPlatformPackages adds Fabric platform packages to the test app', (t) => {
  const root = tempDir(t);
  const addonDir = writePackage(path.join(root, 'addon'), {
    name: '@qvac/llm-llamacpp',
    version: '0.55.2',
  });
  writeSplit(
    path.join(addonDir, 'node_modules/@qvac/fabric'),
    '@qvac/fabric',
    '0.19.1',
  );
  const appDir = writePackage(path.join(root, 'app'), { name: 'app', version: '1.0.0' });
  const calls = [];

  installPlatformPackages({
    appDir,
    addonDir,
    install: (specs, options) => calls.push({ specs, options }),
    log: () => {},
  });

  assert.deepEqual(calls, [{
    specs: ['@qvac/fabric-android-arm64@0.19.1', '@qvac/fabric-ios@0.19.1'],
    options: { cwd: appDir },
  }]);
});

test('conflicting meta versions fail instead of selecting one platform package', (t) => {
  const modules = path.join(tempDir(t), 'node_modules');
  const packages = ['0.19.0', '0.19.1'].map((version) => ({
    name: '@qvac/fabric',
    version,
    hostAddon: hostAddonMap('@qvac/fabric'),
    packageRoot: modules,
  }));

  assert.throws(
    () => planPlatformPackages(packages, ['android'], modules),
    /both 0\.19\.0 and 0\.19\.1/,
  );
});

test('parseArgs requires the app and addon directories', () => {
  assert.deepEqual(parseArgs(['--app-dir', 'app', '--addon-dir', 'addon']), {
    appDir: 'app',
    addonDir: 'addon',
  });
  assert.throws(() => parseArgs(['--app-dir', 'app']), /required/);
  assert.throws(() => parseArgs(['--unknown']), /unknown argument/);
});
