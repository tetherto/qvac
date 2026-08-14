// WebdriverIO config template for QVAC mobile integration tests on AWS Device Farm.
// Consumed by the run-mobile-integration-tests composite action.
//
// The composite copies this file, sed-substitutes the __PLACEHOLDER__ tokens for
// the platform's values, base64-packs it, and writes it into the Device Farm test
// spec's pre_test phase. Keeping the template in a real .js file (instead of
// embedding it as a giant bash heredoc inside the workflow) is what gets us out
// from under the GitHub Actions 21,000-character expression limit.
//
// Tokens substituted by action.yml:
//   __PLATFORM_NAME__               Android | iOS
//   __AUTOMATION_NAME__             UiAutomator2 | XCUITest
//   __BUNDLE_ID__                   io.tether.test.qvac (today; per-input later)
//   __MOCHA_GREP__                  Mocha --grep pattern (or empty string)
//   __MOCHA_TIMEOUT_MS__            Mocha test timeout in ms
//   __WDIO_WAITFOR_TIMEOUT_MS__     WDIO waitforTimeout in ms
//   __INIT_PREDICATE__              Selector that resolves the "INITIALIZED" label
//   __RUN_BUTTON_PREDICATE__        Selector that resolves the "Run Automated Tests" button
//   __ENABLE_FLUSH_BARE_LOG__       'true' | 'false' — gates bare_console.log pull
//   __ENABLE_CRASH_MONITOR__        'true' | 'false' — gates the 15s background crash poller
//   __QVAC_PERF_RUNS__             Override for QVAC_PERF_RUNS (empty = test default)
//   __QVAC_PERF_WARMUP_RUNS__      Override for QVAC_PERF_WARMUP_RUNS (empty = test default)
//   __QVAC_EXTRA_ENV__             Extra KEY=VALUE lines (\n-separated, may be empty)
//                                  appended to the pushed device config file
//   __ENABLES_PERF__                'true' | 'false' — gates perf-report extraction in after:
//   __AFTER_HOOK_EXTRA__            Optional consumer-supplied JS spliced into the after: hook
//
// Companion modules (also base64-deployed to Device Farm):
//   perf-extract.js   Device-side perf-report.json extraction (5-phase Android,
//                     pullFile-based iOS). Only deployed when enables-perf is true.

exports.config = {
  runner: 'local',
  hostname: '127.0.0.1',
  port: 4723,
  path: '/wd/hub',
  specs: ['*.spec.js', '*.test.js'],
  maxInstances: 1,
  bail: 0,
  capabilities: [
    __PLATFORM_CAPABILITIES__,
  ],
  logLevel: 'debug',
  waitforTimeout: __WDIO_WAITFOR_TIMEOUT_MS__,
  connectionRetryTimeout: 30000,
  connectionRetryCount: 3,
  services: [],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: __MOCHA_TIMEOUT_MS__,
    grep: '__MOCHA_GREP__',
  },

  before: async function (capabilities, specs, browser) {
    const BUNDLE_ID = '__BUNDLE_ID__';
    global.appCrashed = false;

    // Per-test-case result tracker. Written to $DEVICEFARM_LOG_DIR/test-results.json
    // after every beforeTest/afterTest so a mid-run crash still preserves all
    // results collected up to that point.
    global.testResults = {
      startedAt: new Date().toISOString(),
      completedAt: null,
      crashed: false,
      summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
      tests: [],
    };
    global.flushTestResults = function () {
      try {
        var logDir = process.env.DEVICEFARM_LOG_DIR || '.';
        require('fs').writeFileSync(
          logDir + '/test-results.json',
          JSON.stringify(global.testResults, null, 2)
        );
      } catch (e) {
        console.log('[test-results] flush failed: ' + e.message);
      }
    };

    // Pull bare_console.log from the device and write to $DEVICEFARM_LOG_DIR.
    // Used at end-of-run (after: hook) and on crash to capture app-side logs
    // before process.exit() races the artifact upload.
    //
    // Uses raw HTTP to Appium instead of browser.pullFile() because this also
    // runs on crash paths where the WDIO command queue may have a pending
    // command stuck behind a long timeout (e.g. waitForDisplayed 60s on an
    // element that will never appear). Raw HTTP bypasses the queue.
    global.flushBareLog = async function (reason) {
      if ('__ENABLE_FLUSH_BARE_LOG__' !== 'true') return;
      try {
        var http = require('http');
        var body = JSON.stringify({ path: '@' + BUNDLE_ID + ':documents/bare_console.log' });
        var b64 = await new Promise(function (resolve, reject) {
          var req = http.request({
            hostname: '127.0.0.1', port: 4723,
            path: '/wd/hub/session/' + browser.sessionId + '/appium/device/pull_file',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          }, function (res) {
            var chunks = '';
            res.on('data', function (c) { chunks += c; });
            res.on('end', function () {
              try { resolve(JSON.parse(chunks).value); } catch (e) { reject(e); }
            });
          });
          req.on('error', reject);
          req.write(body);
          req.end();
        });
        var text = Buffer.from(b64, 'base64').toString();
        var logDir = process.env.DEVICEFARM_LOG_DIR || '.';
        require('fs').writeFileSync(logDir + '/bare_console.log', text);
        console.log('[bare-log] ' + reason + ' flush ok (' + text.length + ' bytes)');
      } catch (e) {
        console.log('[bare-log] ' + reason + ' flush failed: ' + e.message);
      }
    };

    // Android: synchronously dump the full device logcat to
    // $DEVICEFARM_LOG_DIR/logcat_full.txt. The testspec post_test phase writes
    // the same file, but Device Farm skips post_test when the test phase exits
    // non-zero OR the app crashes — so we also capture here on the failure and
    // crash paths (test phase). Kept synchronous so the crash path finishes the
    // dump before the queued process.exit(1) fires. Writes only when adb
    // produced output, so a dead/offline device leaves no misleading empty file.
    // Mirrors the post_test dump in generate-testspec.sh — keep buffer flags and
    // filename in sync. No-op on iOS (which has no logcat; it uses flushBareLog).
    global.isAndroid = (capabilities.platformName || '').toLowerCase() === 'android';
    global.dumpAndroidLogcat = function (reason) {
      if (!global.isAndroid) return;
      try {
        var cp = require('child_process');
        var logDir = process.env.DEVICEFARM_LOG_DIR || '.';
        var udid = process.env.DEVICEFARM_DEVICE_UDID || '';
        var sel = udid ? ('-s ' + udid + ' ') : '';
        var out = cp.execSync('adb ' + sel + 'logcat -d -b all', {
          maxBuffer: 512 * 1024 * 1024,
          timeout: 120000,
        });
        if (out && out.length) {
          require('fs').writeFileSync(logDir + '/logcat_full.txt', out);
          console.log('[logcat] ' + reason + ' dump ok (' + out.length + ' bytes)');
        } else {
          console.log('[logcat] ' + reason + ' produced no output; left existing file untouched');
        }
      } catch (e) {
        console.log('[logcat] ' + reason + ' dump failed: ' + e.message);
      }
    };

    // Crash detection — shared by named checkpoints and the optional 15s
    // background poller. Disables itself after 5 consecutive queryAppState
    // errors to avoid flooding logs when the device is unrecoverable.
    global._crashCheckFails = 0;
    global._crashCheckDisabled = false;
    global.checkAppCrash = async function (stage) {
      if (global._crashCheckDisabled) return -1;
      try {
        var state = await browser.queryAppState(BUNDLE_ID);
        console.log('[' + stage + '] App state: ' + state + ' (4=foreground,3=background,1=not running)');
        if (state < 3) {
          console.error('\n[crash] App crashed at ' + stage + '! State=' + state);
          console.error('Check device logs for BareKit/native errors.\n');
          global.appCrashed = true;
          if (global.testResults) {
            global.testResults.crashed = true;
            global.flushTestResults();
          }
          // Android: grab logcat NOW — post_test won't run on a crashed shard.
          // Synchronous, so it completes before the process.exit(1) timer below
          // can fire. iOS relies on the flushBareLog pull further down.
          global.dumpAndroidLogcat('crash-' + stage);
          setTimeout(function () { process.exit(1); }, 5000);
          try {
            await browser.pause(1500);
            await Promise.race([
              global.flushBareLog('crash-' + stage),
              new Promise(function (_, reject) {
                setTimeout(function () { reject(new Error('flush timed out')); }, 3000);
              }),
            ]);
          } catch (_) { /* already failing */ }
        }
        global._crashCheckFails = 0;
        return state;
      } catch (e) {
        console.log('[' + stage + '] queryAppState error: ' + e.message);
        global._crashCheckFails += 1;
        if (global._crashCheckFails >= 5) {
          console.log('[' + stage + '] disabling crash checks after 5 consecutive errors');
          global._crashCheckDisabled = true;
        }
        return -1;
      }
    };

    // ── Startup sequence ─────────────────────────────────────────────────
    console.log('Checking initial app state...');
    await global.checkAppCrash('startup');
    console.log('Waiting for app to initialize...');
    await browser.pause(5000);
    await global.checkAppCrash('after-pause');
    var initText = await browser.$('__INIT_PREDICATE__');
    await initText.waitForDisplayed({ timeout: 60000 });
    await global.checkAppCrash('after-init');

    // Push test filter + perf config BEFORE clicking the Run button so the
    // on-device test code can read them when it starts processing.
    var isAndroid = (capabilities.platformName || '').toLowerCase() === 'android';
    var testFilter = '__MOCHA_GREP__';
    if (testFilter.length > 0) {
      try {
        var filterPath = isAndroid
          ? '/data/local/tmp/testFilter.txt'
          : '@' + BUNDLE_ID + ':documents/testFilter.txt';
        await browser.pushFile(filterPath, Buffer.from(testFilter).toString('base64'));
        console.log('[pushFile] testFilter -> ' + filterPath);
      } catch (e) {
        console.log('[pushFile] testFilter failed: ' + e.message);
      }
    }
    var perfRuns = '__QVAC_PERF_RUNS__';
    var perfWarmup = '__QVAC_PERF_WARMUP_RUNS__';
    // Extra consumer-supplied KEY=VALUE lines (\n-separated) appended to the
    // same config file — the on-device loader os.setEnv()s every key it finds.
    var extraEnv = '__QVAC_EXTRA_ENV__';
    if (perfRuns.length > 0 || perfWarmup.length > 0 || extraEnv.length > 0) {
      try {
        var configPath = isAndroid
          ? '/data/local/tmp/qvacPerfConfig.txt'
          : '@' + BUNDLE_ID + ':documents/qvacPerfConfig.txt';
        var configBody = 'QVAC_PERF_RUNS=' + perfRuns + '\nQVAC_PERF_WARMUP_RUNS=' + perfWarmup + '\n';
        if (extraEnv.length > 0) configBody += extraEnv + '\n';
        await browser.pushFile(configPath, Buffer.from(configBody).toString('base64'));
        console.log('[pushFile] qvacPerfConfig -> ' + configPath);
      } catch (e) {
        console.log('[pushFile] qvacPerfConfig failed: ' + e.message);
      }
    }

    // ── Click "Run Automated Tests" ──────────────────────────────────────
    console.log('App initialized, clicking Run Automated Tests...');
    var button = await browser.$('__RUN_BUTTON_PREDICATE__');
    await button.waitForDisplayed({ timeout: 15000 });
    await button.click();
    console.log('Button clicked!');
    await browser.pause(5000);
    await global.checkAppCrash('after-click');

    // ── Background crash monitor ─────────────────────────────────────────
    if ('__ENABLE_CRASH_MONITOR__' === 'true') {
      global.crashMonitor = setInterval(function () {
        global.checkAppCrash('crash-monitor').catch(function () {});
      }, 15000);
    }
  },

  after: async function (result, capabilities, specs) {
    if (global.crashMonitor) {
      clearInterval(global.crashMonitor);
    }
    console.log('[bare-log] Waiting for log flush...');
    await browser.pause(3000);
    if (global.flushBareLog) await global.flushBareLog('after');

    // Android: on FAILURE, dump logcat here (test phase) so the bare runtime
    // TAP output survives — Device Farm skips the post_test dump when the test
    // phase exits non-zero. On a clean pass (result === 0) we skip it and let
    // post_test write the file, so the happy path does no redundant work.
    // `result !== 0` also fires on an undefined/ambiguous result (fail-safe).
    // Crashes are already covered in checkAppCrash above.
    if (result !== 0) {
      global.dumpAndroidLogcat('after-fail');
    }

    // Perf extraction — pull perf-report.json from the device while the
    // Appium session is still alive. See perf-extract.js for the full
    // multi-phase strategy (Android: poll→pullFile→logcat→shell→run-as;
    // iOS: pullFile from sandbox paths).
    if ('__ENABLES_PERF__' === 'true') {
      try {
        var extractPerf = require('./perf-extract');
        await extractPerf(browser, {
          isAndroid: (capabilities.platformName || '').toLowerCase() === 'android',
          bundleId: '__BUNDLE_ID__',
          outDir: process.env.DEVICEFARM_LOG_DIR || process.env.DEVICEFARM_TEST_PACKAGE_PATH || '.',
        });
      } catch (err) {
        console.log('[perf-extract] top-level error: ' + err.message);
      }
    }

    // Finalize test-results.json — mark any still-running test as skipped
    // (indicates a crash killed it mid-execution) and stamp completedAt.
    if (global.testResults) {
      global.testResults.completedAt = new Date().toISOString();
      global.testResults.tests.forEach(function (t) {
        if (t.status === 'running') {
          t.status = 'skipped';
          global.testResults.summary.skipped += 1;
        }
      });
      global.flushTestResults();
    }

    // Consumer-supplied extension point for addon-specific artifact pulls.
    // Runs inside this async function with access to browser/capabilities/specs.
    __AFTER_HOOK_EXTRA__
  },

  beforeTest: async function (test) {
    if (global.appCrashed) return;
    if (global.testResults) {
      global.testResults.tests.push({
        title: test.title,
        suite: test.parent || '',
        fullTitle: test.fullTitle || test.title,
        status: 'running',
        duration: 0,
        error: null,
      });
      global.testResults.summary.total += 1;
      global.flushTestResults();
    }
  },

  afterTest: async function (test, context, { error, duration, passed }) {
    if (global.testResults) {
      var entry = global.testResults.tests[global.testResults.tests.length - 1];
      if (entry && entry.title === test.title) {
        entry.status = passed ? 'passed' : 'failed';
        entry.duration = duration || 0;
        if (error) {
          entry.error = {
            message: error.message || String(error),
            stack: (error.stack || '').slice(0, 2000),
          };
        }
        global.testResults.summary[entry.status] += 1;
      }
      global.flushTestResults();
    }
    if (global.appCrashed) return;
    await global.checkAppCrash('after-test:' + test.title);
  },
};
