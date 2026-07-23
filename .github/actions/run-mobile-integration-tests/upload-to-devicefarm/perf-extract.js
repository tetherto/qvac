'use strict';

// Device-side performance report extraction for QVAC mobile integration tests.
//
// Deployed alongside the WDIO config to AWS Device Farm. Called from the
// wdio.template.js `after:` hook while the Appium session is still alive,
// giving access to browser.pullFile() and mobile:shell.
//
// Usage (from wdio.template.js):
//   const extractPerf = require('./perf-extract');
//   await extractPerf(browser, { isAndroid, bundleId, outDir });

const fs = require('fs');

// ── Path constants ─────────────────────────────────────────────────────────
// Known filesystem locations where the app may write perf-report.json.
// Ordered by likelihood; bundle-prefixed paths are expanded at call time.

function androidShellPaths(bid) {
  return [
    `/sdcard/Android/data/${bid}/files/perf-report.json`,
    `/storage/emulated/0/Android/data/${bid}/files/perf-report.json`,
    `/data/local/tmp/perf-report.json`,
    `/tmp/perf-report.json`,
    `/data/data/${bid}/files/perf-report.json`,
    `/data/user/0/${bid}/files/perf-report.json`,
  ];
}

function androidPullFilePaths(bid) {
  return [
    `@${bid}/files/perf-report.json`,
    `/sdcard/Android/data/${bid}/files/perf-report.json`,
    `/storage/emulated/0/Android/data/${bid}/files/perf-report.json`,
    `/data/user/0/${bid}/files/perf-report.json`,
    `/data/user/0/${bid}/cache/perf-report.json`,
    `/data/data/${bid}/files/perf-report.json`,
    `/data/data/${bid}/cache/perf-report.json`,
    `/data/local/tmp/perf-report.json`,
    `/tmp/perf-report.json`,
  ];
}

function iosPullFilePaths(bid) {
  return [
    `@${bid}:documents/perf-report.json`,
    `@${bid}:library/perf-report.json`,
    `@${bid}:tmp/perf-report.json`,
    `@${bid}:documents/Documents/perf-report.json`,
  ];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractJsonFromRaw(raw) {
  if (!raw || raw.length < 10) return null;
  const braceIndex = raw.indexOf('{');
  if (braceIndex < 0) return null;
  const candidate = raw.substring(braceIndex);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch (_) {
    return null;
  }
}

// ── Android extraction phases ──────────────────────────────────────────────

// Phase 1: Poll device paths via `mobile: shell` until the result count
// stabilises. The app writes results incrementally during perf runs, so
// we wait for the count to stop growing before grabbing the final data.
async function pollUntilStable(browser, bundleId) {
  const paths = androidShellPaths(bundleId);
  let lastResultCount = 0;
  let stableRounds = 0;
  let bestJson = null;

  // Cap at 6 rounds (~30s). The old limit of 48 (~4 min of shell calls,
  // ~13 min wall-clock with API overhead) ran uselessly on non-perf shards.
  // 6 rounds is enough for the app to finish writing if perf data exists.
  for (let round = 0; round < 6; round++) {
    let found = false;
    for (const path of paths) {
      try {
        const raw = await browser.execute('mobile: shell', {
          command: 'cat',
          args: [path],
        });
        const json = extractJsonFromRaw(raw);
        if (json) {
          const parsed = JSON.parse(json);
          const count = parsed.results ? parsed.results.length : 0;
          console.log(`[perf-extract] poll ${round}: ${count} results from ${path}`);
          stableRounds = count > 0 && count === lastResultCount ? stableRounds + 1 : 0;
          lastResultCount = count;
          bestJson = json;
          found = true;
          break;
        }
      } catch (_) { /* path doesn't exist yet */ }
    }

    if (!found && round === 5) {
      console.log(`[perf-extract] poll ${round}: no file found after ${round + 1} rounds`);
    }
    if (stableRounds >= 2) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  console.log(`[perf-extract] poll done: ${lastResultCount} results (stable=${stableRounds})`);
  if (bestJson) {
    console.log(`[perf-extract] using poll result (${lastResultCount} results, ${bestJson.length}b)`);
  }
  return bestJson;
}

// Phase 2: browser.pullFile() from known paths.
async function tryPullFile(browser, paths) {
  for (const path of paths) {
    try {
      const b64 = await browser.pullFile(path);
      const text = Buffer.from(b64, 'base64').toString();
      if (text.length > 10 && text[0] === '{') {
        console.log(`[perf-extract] pullFile OK: ${path} (${text.length}b)`);
        return text;
      }
    } catch (_) { /* not found at this path */ }
  }
  return null;
}

// Phase 3: Parse logcat entries for [PERF_REPORT_START]/[PERF_REPORT_END]
// markers, falling back to [PERF_CHUNK] reassembly.
async function extractFromLogcat(browser) {
  let logEntries;
  try {
    logEntries = await browser.getLogs('logcat');
  } catch (err) {
    console.log(`[perf-extract] getLogs error: ${err.message}`);
    return null;
  }
  console.log(`[perf-extract] logcat: ${logEntries.length} entries`);

  const allText = logEntries.map(e => (e && e.message) || '').join('\n');

  // Try bracketed markers first (fastest/cleanest)
  const markerPos = allText.lastIndexOf('[PERF_REPORT_START]');
  if (markerPos >= 0) {
    const jsonStart = markerPos + '[PERF_REPORT_START]'.length;
    const markerEnd = allText.indexOf('[PERF_REPORT_END]', jsonStart);
    if (markerEnd >= 0) {
      const raw = allText.substring(jsonStart, markerEnd).trim();
      try {
        JSON.parse(raw);
        console.log(`[perf-extract] logcat markers OK (${raw.length}b)`);
        return raw;
      } catch (err) {
        console.log(`[perf-extract] logcat marker parse fail: ${err.message}`);
      }
    }
  }

  // Fall back to PERF_CHUNK reassembly (app splits large payloads)
  const chunkGroups = {};
  for (const entry of logEntries) {
    let msg = (entry && entry.message) || '';
    // Strip Bare runtime wrapper noise
    msg = msg.replace(/^'\[Bare\]',\s*'/, '').replace(/'$/, '');
    const match = msg.match(/\[PERF_CHUNK:([^:]+):(\d+):(\d+)\](.+)/);
    if (!match) continue;

    const [, chunkId, indexStr, totalStr, data] = match;
    const index = parseInt(indexStr, 10);
    const total = parseInt(totalStr, 10);

    if (!chunkGroups[chunkId]) chunkGroups[chunkId] = { total, parts: {} };
    const existing = chunkGroups[chunkId].parts[index];
    if (!existing || data.length > existing.length) {
      chunkGroups[chunkId].parts[index] = data;
    }
  }

  for (const chunkId of Object.keys(chunkGroups)) {
    const { total, parts } = chunkGroups[chunkId];
    if (Object.keys(parts).length !== total) continue;

    let assembled = '';
    for (let i = 0; i < total; i++) assembled += parts[i];
    // Strip non-printable characters injected by Device Farm's log pipeline
    assembled = assembled.replace(/[^\x20-\x7e\u00a0-\uffff]/g, '');
    const bracePos = assembled.indexOf('{');
    if (bracePos > 0) assembled = assembled.substring(bracePos);

    try {
      JSON.parse(assembled);
      console.log(`[perf-extract] logcat chunks OK (${assembled.length}b)`);
      return assembled;
    } catch (_) {
      console.log(`[perf-extract] chunk ${chunkId}: reassembly parse fail`);
    }
  }

  return null;
}

// Phase 4: `mobile: shell cat` single-shot (no polling).
async function shellCat(browser, bundleId) {
  for (const path of androidShellPaths(bundleId)) {
    try {
      const raw = await browser.execute('mobile: shell', {
        command: 'cat',
        args: [path],
      });
      const json = extractJsonFromRaw(raw);
      if (json) {
        console.log(`[perf-extract] shell cat OK: ${path}`);
        return json;
      }
    } catch (_) { /* not found */ }
  }
  return null;
}

// Phase 5: `run-as <bundleId> cat <relative>` for sandboxed app data.
async function runAs(browser, bundleId) {
  const relativePaths = ['files/perf-report.json', 'cache/perf-report.json'];
  for (const rel of relativePaths) {
    try {
      const raw = await browser.execute('mobile: shell', {
        command: 'run-as',
        args: [bundleId, 'cat', rel],
      });
      const json = extractJsonFromRaw(raw);
      if (json) {
        console.log(`[perf-extract] run-as OK: ${rel}`);
        return json;
      }
    } catch (_) { /* not found */ }
  }
  return null;
}

// ── Main entry point ───────────────────────────────────────────────────────

module.exports = async function extractPerfReport(browser, { isAndroid, bundleId, outDir }) {
  const outFile = `${outDir}/perf-report-extract.json`;
  let json = null;

  if (isAndroid) {
    json = await pollUntilStable(browser, bundleId);
    if (!json) json = await tryPullFile(browser, androidPullFilePaths(bundleId));
    if (!json) json = await extractFromLogcat(browser);
    if (!json) json = await shellCat(browser, bundleId);
    if (!json) json = await runAs(browser, bundleId);
  } else {
    // iOS needs a brief pause for the app to finish writing
    await browser.pause(3000);
    json = await tryPullFile(browser, iosPullFilePaths(bundleId));
  }

  if (json) {
    try {
      fs.writeFileSync(outFile, json);
      console.log(`[perf-extract] Written to ${outFile}`);
    } catch (err) {
      console.log(`[perf-extract] write failed: ${err.message}`);
    }
    console.log(`[PERF_REPORT_START]${json}[PERF_REPORT_END]`);
  } else {
    console.log('[perf-extract] ALL extraction methods failed');
  }

  return json;
};
