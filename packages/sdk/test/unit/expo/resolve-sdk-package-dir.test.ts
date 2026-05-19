import test from "brittle";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveSDKPackageDir } from "@/expo/plugins/resolve-sdk-package-dir";
import {
  SDKNotFoundInNodeModulesError,
  MultipleSDKInstallationsError,
} from "@/utils/errors-client";

function makeTempProject(packageNames: string[] = []): {
  root: string;
  cleanup: () => void;
} {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "resolve-sdk-test-")),
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "test-project" }),
  );
  for (const name of packageNames) {
    const pkgDir = path.join(root, "node_modules", ...name.split("/"));
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {}");
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name, main: "index.js" }),
    );
  }
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("resolves @qvac/sdk when present in projectRoot/node_modules", (t) => {
  const { root, cleanup } = makeTempProject(["@qvac/sdk"]);
  try {
    const result = resolveSDKPackageDir(root);
    t.is(result.name, "@qvac/sdk");
    t.is(result.dir, path.join(root, "node_modules", "@qvac", "sdk"));
  } finally {
    cleanup();
  }
});

test("resolves @tetherto/sdk-mono when present", (t) => {
  const { root, cleanup } = makeTempProject(["@tetherto/sdk-mono"]);
  try {
    const result = resolveSDKPackageDir(root);
    t.is(result.name, "@tetherto/sdk-mono");
    t.is(result.dir, path.join(root, "node_modules", "@tetherto", "sdk-mono"));
  } finally {
    cleanup();
  }
});

test("resolves package hoisted to a parent directory (monorepo)", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "resolve-sdk-mono-")),
  );
  const projectRoot = path.join(root, "mobile");
  try {
    fs.mkdirSync(projectRoot);
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "mobile" }),
    );
    // Package is hoisted to root, not in mobile/node_modules
    const pkgDir = path.join(root, "node_modules", "@qvac", "sdk");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {}");
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@qvac/sdk", main: "index.js" }),
    );

    const result = resolveSDKPackageDir(projectRoot);
    t.is(result.name, "@qvac/sdk");
    t.is(result.dir, pkgDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("throws SDKNotFoundInNodeModulesError when no SDK package is present", (t) => {
  const { root, cleanup } = makeTempProject([]);
  try {
    let threw: unknown;
    try {
      resolveSDKPackageDir(root);
    } catch (err) {
      threw = err;
    }
    t.ok(threw instanceof SDKNotFoundInNodeModulesError, "should throw SDKNotFoundInNodeModulesError");
  } finally {
    cleanup();
  }
});

test("throws MultipleSDKInstallationsError when more than one SDK package is present", (t) => {
  const { root, cleanup } = makeTempProject(["@qvac/sdk", "@tetherto/sdk-mono"]);
  try {
    let threw: unknown;
    try {
      resolveSDKPackageDir(root);
    } catch (err) {
      threw = err;
    }
    t.ok(threw instanceof MultipleSDKInstallationsError, "should throw MultipleSDKInstallationsError");
    t.ok(
      threw instanceof MultipleSDKInstallationsError &&
        threw.message.includes("@qvac/sdk") &&
        threw.message.includes("@tetherto/sdk-mono"),
      "error message should list conflicting package names",
    );
  } finally {
    cleanup();
  }
});
