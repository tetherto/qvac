#!/usr/bin/env node
// Writes one Device Farm test spec per test group, each carrying its own WDIO config.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// These move here when run-mobile-integration-tests loses its last caller.
const OLD = fileURLToPath(
  new URL('../run-mobile-integration-tests/upload-to-devicefarm/', import.meta.url)
)

const ANDROID_CAPS = (id) =>
  `{platformName:"Android","appium:automationName":"UiAutomator2","appium:appPackage":"${id}","appium:appActivity":"${id}.MainActivity","appium:newCommandTimeout":300,"appium:autoGrantPermissions":true,"appium:autoAcceptAlerts":true,"appium:noReset":true,"appium:dontStopAppOnReset":true,"appium:forceAppLaunch":false}`
const IOS_CAPS = (id) =>
  `{platformName:"iOS","appium:automationName":"XCUITest","appium:bundleId":"${id}","appium:newCommandTimeout":300,"appium:noReset":true,"appium:forceAppLaunch":false,"appium:usePrebuiltWDA":true,"appium:wdaLocalPort":8100,"appium:showIOSLog":true,"appium:realDeviceLogger":"/usr/local/lib/node_modules/appium/node_modules/deviceconsole/deviceconsole"}`

export function platformValues(platform, bundleId) {
  return platform === 'Android'
    ? {
        host: 'android_test_host: amazon_linux_2',
        automation: 'UiAutomator2',
        caps: ANDROID_CAPS(bundleId),
        init: 'android=new UiSelector().textContains("INITIALIZED")',
        button: 'android=new UiSelector().textContains("Run Automated Tests")'
      }
    : {
        host: 'ios_test_host: macos_sequoia',
        automation: 'XCUITest',
        caps: IOS_CAPS(bundleId),
        init: '-ios predicate string:label CONTAINS "INITIALIZED"',
        button: '-ios predicate string:label CONTAINS "Run Automated Tests"'
      }
}

// An explicit list wins, then the package's test-groups.json, then one spec running everything.
export function resolveGroups(explicit, groupsFile, platform) {
  const given = explicit ? JSON.parse(explicit) : []
  if (given.length) return given
  if (groupsFile && existsSync(groupsFile)) {
    const map = JSON.parse(readFileSync(groupsFile, 'utf8'))[platform.toLowerCase()]
    if (map && typeof map === 'object')
      return Object.entries(map).map(([name, tests]) => ({
        name,
        grep: tests.join('|')
      }))
  }
  return [{ name: 'default', grep: '' }]
}

// A sharded package reports perf only from shards named for it.
export const shardPerf = (enables, count, name) => enables && (count <= 1 || /perf/i.test(name))

export function render(template, values) {
  let out = template
  for (const [k, v] of Object.entries(values)) out = out.replaceAll(k, () => v)
  return out
}

export function generate({
  platform,
  bundleId,
  groups,
  allTests,
  enablesPerf,
  mochaTimeoutMs,
  waitforMs,
  outDir,
  template,
  writeSpec
}) {
  const p = platformValues(platform, bundleId)
  return groups.map((g) => {
    const perf = shardPerf(enablesPerf, groups.length, g.name)
    const wdio = render(template, {
      __PLATFORM_CAPABILITIES__: p.caps,
      __BUNDLE_ID__: bundleId,
      __MOCHA_GREP__: JSON.stringify(g.grep || ''),
      __MOCHA_TIMEOUT_MS__: mochaTimeoutMs,
      __WDIO_WAITFOR_TIMEOUT_MS__: waitforMs,
      __INIT_PREDICATE__: p.init,
      __RUN_BUTTON_PREDICATE__: p.button,
      __ENABLE_FLUSH_BARE_LOG__: 'true',
      __ENABLE_CRASH_MONITOR__: 'true',
      __QVAC_PERF_RUNS__: '',
      __QVAC_PERF_WARMUP_RUNS__: '',
      __QVAC_EXTRA_ENV__: '',
      __ENABLES_PERF__: String(perf),
      __AFTER_HOOK_EXTRA__: ''
    })
    const file = join(outDir, `testspec-${g.name.replace(/[^A-Za-z0-9_-]/g, '_')}.yml`)
    writeSpec(file, {
      PLATFORM: platform,
      HOST_LINE: p.host,
      AUTOMATION_NAME: p.automation,
      SHARD_ENABLES_PERF: String(perf),
      WDIO_CONFIG_B64: Buffer.from(wdio).toString('base64'),
      GROUP_GREP_B64: Buffer.from(g.grep || '').toString('base64')
    })
    return {
      name: g.name,
      grep: g.grep || '',
      tests: g.grep || allTests.join('|'),
      file
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  const outDir = join(env.RUNNER_TEMP, 'devicefarm-specs')
  mkdirSync(outDir, { recursive: true })
  const pre = join(outDir, 'extra-pre-test.sh')
  writeFileSync(pre, env.EXTRA_PRE_TEST || '')
  const auto = join(env.WORKDIR, 'test/mobile/integration.auto.cjs')
  const enablesPerf = env.ENABLES_PERF === 'true'
  const specs = generate({
    platform: env.PLATFORM,
    bundleId: env.BUNDLE_ID,
    enablesPerf,
    mochaTimeoutMs: env.MOCHA_TIMEOUT_MS,
    waitforMs: env.WAITFOR_MS,
    outDir,
    groups: resolveGroups(
      env.TESTS ? JSON.stringify([{ name: 'manual', grep: env.TESTS }]) : '',
      join(env.WORKDIR, 'test/mobile/test-groups.json'),
      env.PLATFORM
    ),
    allTests: existsSync(auto)
      ? [...readFileSync(auto, 'utf8').matchAll(/async function (run[A-Za-z0-9]+)/g)].map(
          (m) => m[1]
        )
      : [],
    template: readFileSync(join(OLD, 'wdio.template.js'), 'utf8'),
    writeSpec: (file, vars) =>
      execFileSync('bash', [join(OLD, 'generate-testspec.sh'), file], {
        stdio: 'inherit',
        env: {
          ...process.env,
          ...vars,
          EXTRA_PRE_TEST_PATH: pre,
          EXTRA_POST_TEST_PATH: join(outDir, 'none'),
          PERF_EXTRACT_B64: enablesPerf
            ? readFileSync(join(OLD, 'perf-extract.js')).toString('base64')
            : ''
        }
      })
  })
  // Specs can carry presigned URLs from the pre-test commands, so only names are printed.
  for (const s of specs) console.log(`${s.file}: grep '${s.grep}'`)
  // The framework's e2e suite, packed with its dependencies, is the test package every spec runs.
  const e2e = join(env.APP_DIR, 'e2e')
  execFileSync('npm', ['install'], { cwd: e2e, stdio: 'inherit' })
  execFileSync('npm', ['pack'], { cwd: e2e, stdio: 'inherit' })
  const testPackage = join(env.RUNNER_TEMP, `e2e-tests-${env.PLATFORM}.zip`)
  const tarballs = readdirSync(e2e).filter((f) => f.endsWith('.tgz'))
  execFileSync('zip', ['-r', testPackage, 'package.json', 'tests/', ...tarballs], {
    cwd: e2e,
    stdio: 'inherit'
  })
  appendFileSync(env.GITHUB_OUTPUT, `specs=${JSON.stringify(specs)}\ntest-package=${testPackage}\n`)
}
