import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractBlockScalar, repoRoot } from "../lib/sdk-e2e-rerun.mjs";

const source = readFileSync(
  join(repoRoot, ".github/actions/setup-llvm/action.yml"),
  "utf8",
);
const install = extractBlockScalar(source, {
  anchor: "- if: ${{ runner.os == 'Linux' }}",
  key: "run",
});
const realCurl = execFileSync("which", ["curl"], { encoding: "utf8" }).trim();
const key = "fixture signing key";
const installer = "fixture installer: must never be executed by this test";

function respond(request, response, state) {
  const name = request.url.slice(1);
  state.calls[name] = (state.calls[name] || 0) + 1;
  if (state.calls[name] <= (state.disconnects[name] || 0)) {
    response.destroy();
    return;
  }
  if (state.calls[name] <= (state.failures[name] || 0)) {
    response.writeHead(503).end("temporarily unavailable");
    return;
  }
  response.end(name === "llvm.sh" ? installer : key);
}

function writeExecutable(path, body) {
  writeFileSync(path, `#!${process.execPath}\n${body}`, { mode: 0o755 });
}

function writeCommands(directory) {
  writeExecutable(
    join(directory, "curl"),
    String.raw`
const { spawnSync } = require('node:child_process')
const prefix = 'https://apt.llvm.org/'
const args = process.argv.slice(2).map(arg => arg.startsWith(prefix)
  ? process.env.TEST_LLVM_ORIGIN + arg.slice(prefix.length) : arg)
const result = spawnSync(process.env.TEST_REAL_CURL, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`,
  );
  writeExecutable(
    join(directory, "sudo"),
    String.raw`
const { copyFileSync, appendFileSync } = require('node:fs')
const { join } = require('node:path')
const [command, ...args] = process.argv.slice(2)
if (command === 'install') {
  copyFileSync(args.at(-2), join(process.env.RUNNER_TEMP, 'installed-key'))
} else if (command === './llvm.sh') {
  appendFileSync(join(process.env.RUNNER_TEMP, 'installer-calls'), JSON.stringify(args) + '\n')
} else {
  process.exit(64)
}
`,
  );
  writeExecutable(join(directory, "wget"), "process.exit(4)\n");
}

async function fixture(t, { failures = {}, disconnects = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "setup-llvm-test-"));
  const state = { calls: {}, failures, disconnects };
  const server = createServer((request, response) =>
    respond(request, response, state),
  );
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  writeCommands(directory);
  return {
    directory,
    state,
    origin: `http://127.0.0.1:${server.address().port}/`,
  };
}

function runInstall(f, retries = "5") {
  const child = spawn("bash", ["--noprofile", "--norc", "-c", install], {
    cwd: f.directory,
    env: {
      ...process.env,
      PATH: `${f.directory}:${process.env.PATH}`,
      RUNNER_TEMP: f.directory,
      LLVM_VERSION: "22",
      LLVM_DOWNLOAD_RETRIES: retries,
      LLVM_DOWNLOAD_RETRY_DELAY: "0",
      TEST_REAL_CURL: realCurl,
      TEST_LLVM_ORIGIN: f.origin,
    },
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  return once(child, "close").then(([status]) => ({ status, stderr }));
}

test("LLVM downloads retain the approved retry policy and toolchain pins", () => {
  assert.match(source, /LLVM_DOWNLOAD_RETRIES: "5"/);
  assert.match(source, /LLVM_DOWNLOAD_RETRY_DELAY: "15"/);
  assert.match(source, /default: "22"/);
  assert.match(source, /default: "22\.1\.0"/);
});

test("Linux setup recovers from connection loss and HTTP download failures", async (t) => {
  const f = await fixture(t, {
    disconnects: { "llvm-snapshot.gpg.key": 2 },
    failures: { "llvm.sh": 1 },
  });
  const result = await runInstall(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.state.calls, { "llvm-snapshot.gpg.key": 3, "llvm.sh": 2 });
  assert.equal(readFileSync(join(f.directory, "installed-key"), "utf8"), key);
  assert.equal(readFileSync(join(f.directory, "llvm.sh"), "utf8"), installer);
  assert.equal(
    readFileSync(join(f.directory, "installer-calls"), "utf8"),
    '["22","all"]\n',
  );
});

test("a failed key download preserves the existing trusted key and stops installation", async (t) => {
  const f = await fixture(t, {
    failures: { "llvm-snapshot.gpg.key": Infinity },
  });
  writeFileSync(join(f.directory, "installed-key"), "existing trusted key");
  const result = await runInstall(f, "1");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /503/);
  assert.deepEqual(f.state.calls, { "llvm-snapshot.gpg.key": 2 });
  assert.equal(
    readFileSync(join(f.directory, "installed-key"), "utf8"),
    "existing trusted key",
  );
  assert.equal(existsSync(join(f.directory, "installer-calls")), false);
});

test("a failed installer download reports the error and never invokes the installer", async (t) => {
  const f = await fixture(t, { failures: { "llvm.sh": Infinity } });
  const result = await runInstall(f, "1");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /503/);
  assert.deepEqual(f.state.calls, { "llvm-snapshot.gpg.key": 1, "llvm.sh": 2 });
  assert.equal(existsSync(join(f.directory, "installer-calls")), false);
});
