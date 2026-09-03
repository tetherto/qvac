// Pulls the model-fit calibration run out of a producer results report and
// writes the fixture the way it should be committed:
//
//   node extract-calibration-fixture.mjs <reports-dir> <out-dir>
//
// The e2e test `calibration-model-fit` returns the whole run as its output, so
// the results JSON is the channel off the device — no logcat parsing. Exits
// non-zero when there is no run to extract or the held-out check failed, so
// the job cannot go green on a fixture that must not ship; the fixture is still
// written in the second case because a failed gate is worth auditing.

import fs from "node:fs";
import path from "node:path";

const TEST_ID = "calibration-model-fit";
const [reportsDir = "./reports", outDir = "./calibration-fixture"] =
  process.argv.slice(2);

function annotate(level, message) {
  console.log(`::${level}::${message}`);
}

function fail(message) {
  annotate("error", message);
  process.exit(1);
}

const files = fs.existsSync(reportsDir)
  ? fs
      .readdirSync(reportsDir)
      .filter((f) => f.startsWith("results-") && f.endsWith(".json"))
  : [];
if (files.length === 0) {
  fail(
    `no results-*.json under ${reportsDir}: the producer did not write a report`,
  );
}

let entry;
for (const file of files) {
  const report = JSON.parse(
    fs.readFileSync(path.join(reportsDir, file), "utf8"),
  );
  const tests = Array.isArray(report.tests) ? report.tests : [];
  entry = tests.find((test) => test.testId === TEST_ID);
  if (entry) break;
}
if (!entry) {
  fail(
    `${TEST_ID} is not in the producer results; the producer needs QVAC_E2E_CALIBRATION=1 and filter=calibration`,
  );
}
if (!entry.output) {
  fail(
    `${TEST_ID} finished ${entry.outcome} without output: ${entry.error ?? "no error recorded"}`,
  );
}

let payload;
try {
  payload = JSON.parse(entry.output);
} catch {
  fail(`${TEST_ID} output is not JSON: ${entry.output.slice(0, 300)}`);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "calibration-run.json"),
  `${JSON.stringify(payload, null, 2)}\n`,
);

if (payload.aborted) {
  fail(
    `calibration aborted (${payload.aborted.reason}): ${payload.aborted.message}`,
  );
}
if (!payload.fixtureSource || !payload.platform) {
  fail("calibration output carries no fixture source");
}

// A GPU pass names its fixture `<platform>-<backend>`; mobile runs are always
// system-memory, so `platform` is the fallback rather than the usual case.
const fixturePath = path.join(
  outDir,
  `${payload.fixtureKey ?? payload.platform}.ts`,
);
fs.writeFileSync(fixturePath, payload.fixtureSource);
console.log(`wrote ${fixturePath}`);

const heldOut = payload.heldOut;
if (heldOut) {
  const gib = (bytes) => (bytes / 2 ** 30).toFixed(2);
  console.log(
    `held-out ${heldOut.model}: worst ${gib(heldOut.worstTotalBytes)} GiB vs predicted upper ${gib(heldOut.predictedUpperBytes)} GiB — ${heldOut.holds ? "PASS" : "FAIL"}`,
  );
}

const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
for (const warning of warnings) {
  annotate("warning", `calibration: ${warning}`);
}
if (warnings.length > 0) {
  annotate(
    "warning",
    "busy-host warnings above: re-run on an idle device before shipping this fixture",
  );
}
if (!payload.calibration?.validated) {
  fail(
    "held-out check failed: the fixture is uploaded for auditing but must not ship",
  );
}
console.log(
  `validated fixture for ${payload.platform} (${payload.backend}${payload.device ? `, ${payload.device}` : ""})`,
);
