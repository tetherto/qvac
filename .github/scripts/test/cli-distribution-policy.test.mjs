// These checks run without installing workspace dependencies or contacting a registry.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const read = (file) =>
  readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
const workflow = read(".github/workflows/trigger-reusable-lib-cli.yml");
const action = read(".github/actions/publish-library-to-gpr/action.yaml");

function step(source, name) {
  const marker = `- name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing step ${name}`);
  const rest = source.slice(start + marker.length);
  const end = rest.search(/\n\s*- (?:name:|uses:)/);
  return end < 0 ? rest : rest.slice(0, end);
}

function script(source, name) {
  const text = step(source, name);
  const match = text.match(/^([ ]*)run: \|\n([\s\S]*)/m);
  assert.ok(match, `${name} has a shell script`);
  const indent = match[1].length + 2;
  return match[2]
    .split("\n")
    .map((line) => line.slice(indent))
    .join("\n");
}

test("CLI installs from its lock and publishes validated archives on every stream", () => {
  assert.match(
    step(workflow, "Install dependencies"),
    /npm ci --ignore-scripts\n/,
  );
  assert.doesNotMatch(
    workflow,
    /sdk-source:workspace|cli-rewrite-sdk-scope-for-gpr/,
  );
  for (const stream of ["dev", "feature", "tmp"]) {
    assert.match(
      step(workflow, `Publish to GitHub Packages (${stream})`),
      /pack-script: pack:local/,
    );
  }
  const publish = script(workflow, "Assemble and publish verified archive");
  assert.match(publish, /npm run pack:local -- "\$archive_dir"/);
  assert.match(
    publish,
    /npm publish "\$\{archives\[0\]\}" --tag "\$PUBLISH_TAG" --access public --provenance/,
  );
  assert.ok(
    workflow.indexOf("Setup Node for trusted publishing") <
      workflow.indexOf("Assemble and publish verified archive"),
  );
  assert.match(
    step(workflow, "Setup Node for trusted publishing"),
    /node-version: 24/,
  );
});

test("GPR packs after normalization and keeps dependency registry scopes unchanged", () => {
  assert.ok(
    action.indexOf("id: normalize_name") < action.indexOf("id: pack_archive"),
  );
  assert.match(action, /scope: "@tetherto"/);
  assert.doesNotMatch(
    step(action, "Assemble distribution archive"),
    /@qvac|npm_config_registry|NPM_CONFIG_REGISTRY/,
  );
  assert.match(
    step(action, "Publish to GitHub Packages (GPR)"),
    /npm publish "\$\{PACKAGE_ARCHIVE:-\.\}" --tag "\$PUBLISH_TAG"/,
  );
});

for (const count of [0, 1, 2]) {
  test(`GPR archive assembly ${count === 1 ? "accepts one archive" : `rejects ${count} archives`}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "qvac-ci-pack-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const output = join(directory, "output");
    writeFileSync(
      join(directory, "npm"),
      '#!/bin/sh\n[ "$1" = run ] && [ "$2" = pack:local ] && [ "$3" = -- ] || exit 99\ni=0\nwhile [ "$i" -lt "$ARCHIVE_COUNT" ]; do touch "$4/fixture-$i.tgz"; i=$((i+1)); done\n',
      { mode: 0o755 },
    );
    const result = spawnSync(
      "bash",
      ["-c", script(action, "Assemble distribution archive")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: directory + ":" + process.env.PATH,
          RUNNER_TEMP: directory,
          GITHUB_OUTPUT: output,
          PACK_SCRIPT: "pack:local",
          ARCHIVE_COUNT: String(count),
        },
      },
    );
    assert.equal(result.status, count === 1 ? 0 : 1, result.stderr);
    if (count === 1)
      assert.match(readFileSync(output, "utf8"), /archive=.*fixture-0\.tgz\n/);
    else assert.match(result.stdout, /must produce exactly one archive/);
  });
}
