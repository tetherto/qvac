"use strict";

const { spawnSync } = require("node:child_process");
const {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
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
const { runWithRetry } = require("./run-with-timeout.cjs");

const packageRoot = resolve(__dirname, "..");
const manifest = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
);
const tempRoot = mkdtempSync(join(tmpdir(), "qvac-rpc-packaged-smoke-"));
const packagedRoot = join(tempRoot, "package");
const dependenciesRoot = join(packagedRoot, "node_modules");

function copyIntoPackage(path) {
  const source = join(packageRoot, path);
  const destination = join(packagedRoot, path);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

// The directory a package named `name` resolves to from `from`, following links to its real location.
function findPackage(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json")))
      return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

// Bare specifiers an imports map points at, such as fabric's #host-addon platform packages.
function importTargets(map) {
  if (typeof map === "string") return /^[^./#]/.test(map) ? [map] : [];
  if (!map || typeof map !== "object") return [];
  return Object.values(map).flatMap(importTargets);
}

// Installs the runtime dependency closure as real directories in npm's flat layout, so resolution never crosses the
// links pnpm uses. Each dependency resolves from the real directory of the package that needs it.
function installDependencies(manifestRoot, required) {
  const pending = [{ from: manifestRoot, names: required }];
  const installed = new Set();
  while (pending.length) {
    const { from, names } = pending.shift();
    for (const name of names) {
      if (installed.has(name)) continue;
      const source = findPackage(name, from);
      if (!source) continue;
      installed.add(name);
      const pkg = JSON.parse(
        readFileSync(join(source, "package.json"), "utf8"),
      );
      const destination = join(dependenciesRoot, ...name.split("/"));
      mkdirSync(destination, { recursive: true });
      // A glob in files copies its top-level directory.
      const entries = pkg.files
        ? [
            ...new Set([
              "package.json",
              ...pkg.files.map((f) => (/[*?[]/.test(f) ? f.split("/")[0] : f)),
            ]),
          ]
        : readdirSync(source).filter((entry) => entry !== "node_modules");
      for (const entry of entries) {
        if (existsSync(join(source, entry)))
          cpSync(join(source, entry), join(destination, entry), {
            recursive: true,
            dereference: true,
          });
      }
      pending.push({
        from: source,
        names: [
          ...Object.keys(pkg.dependencies || {}),
          ...Object.keys(pkg.optionalDependencies || {}),
          ...importTargets(pkg.imports),
        ],
      });
    }
  }
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

// libibverbs lists RDMA devices from this sysfs class, one uverbs entry each.
function rdmaDevicePresent() {
  try {
    return readdirSync("/sys/class/infiniband_verbs").some((name) =>
      name.startsWith("uverbs"),
    );
  } catch {
    return false;
  }
}

function libibverbsInstalled() {
  for (const ldconfig of ["ldconfig", "/sbin/ldconfig"]) {
    const result = spawnSync(ldconfig, ["-p"], { encoding: "utf8" });
    if (result.status === 0) return /\blibibverbs\.so\.1\b/.test(result.stdout);
  }
  throw new Error("ldconfig is not available to look up libibverbs.so.1");
}

// Fabric's Linux RPC backend tries RDMA only when it can load libibverbs, the
// host has an RDMA device, and GGML_RPC_NO_RDMA is unset, so the rdmaCapable the
// smoke test expects depends on this host.
function rdmaExpected() {
  if (process.platform !== "linux" || process.env.GGML_RPC_NO_RDMA) {
    return false;
  }
  // Check for a device first, so hosts without RDMA never need ldconfig.
  return rdmaDevicePresent() && libibverbsInstalled();
}

// Loading Fabric initialises every GPU backend, even for a CPU server. On the
// paravirtual GPU of GitHub's Intel macOS runners the Metal shader compile
// takes about a minute and occasionally never finishes, so a stalled attempt
// is killed and retried rather than left to hold the job until its timeout.
const SMOKE_TIMEOUT_MS = 5 * 60 * 1000;
const SMOKE_ATTEMPTS = 2;

async function main() {
  try {
    copyIntoPackage("package.json");
    for (const path of manifest.files) copyIntoPackage(path);
    // The probes are CI-only; they are not included in the published package.
    for (const path of [
      "test/bare/prebuild-smoke.js",
      "test/mobile/rpc-protocol.cjs",
    ]) {
      copyIntoPackage(path);
    }

    // Copy the JS dependencies in, without making the original build tree, prebuilds, or package source part of the
    // isolated package's search path.
    installDependencies(packageRoot, [
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.optionalDependencies || {}),
    ]);
    if (existsSync(join(packagedRoot, "build"))) {
      throw new Error(
        "Isolated package unexpectedly contains a build directory",
      );
    }

    await runWithRetry(
      "bare",
      ["test/bare/prebuild-smoke.js", `--expect-rdma=${rdmaExpected()}`],
      {
        cwd: packagedRoot,
        env: smokeEnvironment(),
        shell: process.platform === "win32",
        attempts: SMOKE_ATTEMPTS,
        timeoutMs: SMOKE_TIMEOUT_MS,
      },
    );
  } finally {
    // Windows can hold a just-killed process's loaded addon open briefly.
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
