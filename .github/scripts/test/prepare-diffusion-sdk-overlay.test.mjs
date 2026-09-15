import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { linkDiffusionOverlay } from "../prepare-diffusion-sdk-overlay.mjs";

function fixture(t, range = "^0.25.0") {
  const root = mkdtempSync(join(tmpdir(), "qvac-diffusion-sdk-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function write(path, value) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  }
  const dep = { "@qvac/diffusion-cpp": range };
  write(
    "packages/diffusion-cpp/package.json",
    JSON.stringify({ name: "@qvac/diffusion-cpp", version: "0.25.0" }),
  );
  write("packages/sdk/package.json", JSON.stringify({ dependencies: dep }));
  write(
    "packages/inference/package.json",
    JSON.stringify({ devDependencies: dep, peerDependencies: dep }),
  );
  write("addon.tgz", "fixture");
  return { root, write, tarball: join(root, "addon.tgz") };
}

test("published registry configuration leaves dependency manifests intact", (t) => {
  const { root, tarball } = fixture(t);
  const before = readFileSync(join(root, "packages/sdk/package.json"), "utf8");
  assert.equal(linkDiffusionOverlay(root, tarball), false);
  assert.equal(
    readFileSync(join(root, "packages/sdk/package.json"), "utf8"),
    before,
  );
});

test("overlay uses the same PR tarball for SDK and inference, idempotently", (t) => {
  const { root, write, tarball } = fixture(t);
  write(
    "packages/diffusion-cpp/vcpkg-overlay/ports/stable-diffusion-cpp/portfile.cmake",
    "# pin",
  );
  assert.equal(linkDiffusionOverlay(root, tarball), true);
  assert.equal(linkDiffusionOverlay(root, tarball), true);
  const spec = `file:${resolve(tarball).replaceAll("\\", "/")}`;
  for (const pkg of ["sdk", "inference"]) {
    const manifest = JSON.parse(
      readFileSync(join(root, "packages", pkg, "package.json")),
    );
    for (const values of Object.values(manifest))
      assert.equal(values["@qvac/diffusion-cpp"], spec);
  }
});

test("release range mismatch fails before any manifest is rewritten", (t) => {
  const { root, write, tarball } = fixture(t, "^0.24.0");
  write(
    "packages/diffusion-cpp/vcpkg-overlay/ports/stable-diffusion-cpp/portfile.cmake",
    "# pin",
  );
  const before = readFileSync(join(root, "packages/sdk/package.json"), "utf8");
  assert.throws(() => linkDiffusionOverlay(root, tarball), /expected \^0.25.0/);
  assert.equal(
    readFileSync(join(root, "packages/sdk/package.json"), "utf8"),
    before,
  );
});
