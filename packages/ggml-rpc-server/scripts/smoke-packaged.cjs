"use strict";

const { spawnSync } = require("node:child_process");
const {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} = require("node:path");

const packageRoot = resolve(__dirname, "..");
const manifest = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
);
const tempRoot = mkdtempSync(join(tmpdir(), "qvac-rpc-packaged-smoke-"));
const packagedRoot = join(tempRoot, "package");
const dependenciesLink = join(packagedRoot, "node_modules");
let dependenciesLinked = false;

function copyIntoPackage(path) {
  const source = join(packageRoot, path);
  const destination = join(packagedRoot, path);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function isInside(path, root) {
  const difference = relative(root, resolve(path));
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
}

function smokeEnvironment() {
  const env = { ...process.env };
  const blockedRoots = [
    join(packageRoot, "build"),
    join(packageRoot, "prebuilds"),
  ];
  if (env.VCPKG_ROOT) blockedRoots.push(env.VCPKG_ROOT);
  for (const pathKey of Object.keys(env).filter(
    (key) => key.toLowerCase() === "path",
  )) {
    env[pathKey] = env[pathKey]
      .split(delimiter)
      .filter(
        (entry) =>
          entry && blockedRoots.every((root) => !isInside(entry, root)),
      )
      .join(delimiter);
  }
  delete env.NODE_PATH;
  delete env.LD_LIBRARY_PATH;
  delete env.DYLD_LIBRARY_PATH;
  delete env.VCPKG_ROOT;
  return env;
}

function run(command, args, env, shell = false) {
  const result = spawnSync(command, args, {
    cwd: packagedRoot,
    env,
    shell,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.signal})`,
    );
  }
}

try {
  copyIntoPackage("package.json");
  for (const path of manifest.files) copyIntoPackage(path);
  // The probes are CI-only; they are not included in the published package.
  for (const path of [
    "test/node/prebuild-smoke.cjs",
    "test/bare/prebuild-smoke.js",
    "test/mobile/rpc-protocol.cjs",
  ]) {
    copyIntoPackage(path);
  }

  // Reuse JS dependencies without making the original build tree, prebuilds,
  // or package source part of the isolated package's search path.
  symlinkSync(
    join(packageRoot, "node_modules"),
    dependenciesLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  dependenciesLinked = true;
  if (existsSync(join(packagedRoot, "build"))) {
    throw new Error("Isolated package unexpectedly contains a build directory");
  }

  const env = smokeEnvironment();
  run(process.execPath, ["test/node/prebuild-smoke.cjs"], env);
  run(
    "bare",
    ["test/bare/prebuild-smoke.js"],
    env,
    process.platform === "win32",
  );
} finally {
  // Remove the dependency junction before recursively removing the temp tree.
  if (dependenciesLinked) unlinkSync(dependenciesLink);
  rmSync(tempRoot, { recursive: true, force: true });
}
