// @ts-expect-error brittle has no type declarations
import test from "brittle";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveSDKPackageDir } from "@/expo/plugins/resolve-sdk-package-dir";
import {
  SDKNotFoundInNodeModulesError,
  MultipleSDKInstallationsError,
} from "@/utils/errors-client";

type BrittleAssert = {
  is: Function;
  ok: Function;
  alike: Function;
  exception: Function;
  absent: Function;
};

function installPackage(parentDir: string, name: string) {
  const pkgDir = path.join(parentDir, "node_modules", ...name.split("/"));
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {}");
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name, main: "index.js" }),
  );
  return pkgDir;
}

function withTempProject(
  fn: (projectRoot: string, workspaceRoot: string) => void,
) {
  const workspaceRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "qvac-resolve-sdk-")),
  );
  const projectRoot = path.join(workspaceRoot, "mobile");
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ name: "mobile" }),
  );
  try {
    fn(projectRoot, workspaceRoot);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function captureWarnings(fn: () => void) {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test("resolveSDKPackageDir: resolves @qvac/sdk when installed at projectRoot", (t: BrittleAssert) => {
  withTempProject((projectRoot) => {
    const expected = installPackage(projectRoot, "@qvac/sdk");
    const warnings = captureWarnings(() => {
      const result = resolveSDKPackageDir(projectRoot);
      t.is(result.name, "@qvac/sdk");
      t.is(result.dir, expected);
    });
    t.is(warnings.length, 0, "no warnings when only one install is present");
  });
});

test("resolveSDKPackageDir: resolves @tetherto/sdk-mono when installed at projectRoot", (t: BrittleAssert) => {
  withTempProject((projectRoot) => {
    const expected = installPackage(projectRoot, "@tetherto/sdk-mono");
    const result = resolveSDKPackageDir(projectRoot);
    t.is(result.name, "@tetherto/sdk-mono");
    t.is(result.dir, expected);
  });
});

test("resolveSDKPackageDir: walks ancestors and resolves a hoisted install", (t: BrittleAssert) => {
  withTempProject((projectRoot, workspaceRoot) => {
    const expected = installPackage(workspaceRoot, "@qvac/sdk");
    const warnings = captureWarnings(() => {
      const result = resolveSDKPackageDir(projectRoot);
      t.is(result.name, "@qvac/sdk");
      t.is(result.dir, expected);
    });
    t.is(warnings.length, 0, "no warnings when only the hoisted copy exists");
  });
});

test("resolveSDKPackageDir: prefers projectRoot copy over a hoisted ancestor copy and warns", (t: BrittleAssert) => {
  withTempProject((projectRoot, workspaceRoot) => {
    const expected = installPackage(projectRoot, "@qvac/sdk");
    const shadowed = installPackage(workspaceRoot, "@qvac/sdk");
    const warnings = captureWarnings(() => {
      const result = resolveSDKPackageDir(projectRoot);
      t.is(result.name, "@qvac/sdk");
      t.is(result.dir, expected, "returns the install closest to projectRoot");
    });
    t.is(warnings.length, 1, "warns once about the shadowed install");
    t.ok(
      warnings[0]!.includes(shadowed),
      "warning names the shadowed directory path",
    );
    t.ok(
      warnings[0]!.includes(expected),
      "warning names the winning directory path",
    );
  });
});

test("resolveSDKPackageDir: prefers the closest install when two different SDK packages live at different depths", (t: BrittleAssert) => {
  withTempProject((projectRoot, workspaceRoot) => {
    const expected = installPackage(projectRoot, "@qvac/sdk");
    installPackage(workspaceRoot, "@tetherto/sdk-dev");
    const warnings = captureWarnings(() => {
      const result = resolveSDKPackageDir(projectRoot);
      t.is(result.name, "@qvac/sdk");
      t.is(result.dir, expected);
    });
    t.is(warnings.length, 1, "warns about the ignored hoisted package");
    t.ok(
      warnings[0]!.includes("@tetherto/sdk-dev"),
      "warning lists the ignored package name",
    );
  });
});

test("resolveSDKPackageDir: throws MultipleSDKInstallationsError when two different SDK packages share the closest depth", (t: BrittleAssert) => {
  withTempProject((projectRoot) => {
    installPackage(projectRoot, "@qvac/sdk");
    installPackage(projectRoot, "@tetherto/sdk-dev");
    let threw: unknown;
    try {
      resolveSDKPackageDir(projectRoot);
    } catch (err) {
      threw = err;
    }
    t.ok(
      threw instanceof MultipleSDKInstallationsError,
      "throws MultipleSDKInstallationsError",
    );
    const err = threw as MultipleSDKInstallationsError;
    t.ok(
      err.message.includes("@qvac/sdk") &&
        err.message.includes("@tetherto/sdk-dev"),
      "error message names both conflicting packages",
    );
  });
});

test("resolveSDKPackageDir: throws SDKNotFoundInNodeModulesError when no SDK is installed anywhere", (t: BrittleAssert) => {
  withTempProject((projectRoot) => {
    let threw: unknown;
    try {
      resolveSDKPackageDir(projectRoot);
    } catch (err) {
      threw = err;
    }
    t.ok(
      threw instanceof SDKNotFoundInNodeModulesError,
      "throws SDKNotFoundInNodeModulesError",
    );
  });
});
