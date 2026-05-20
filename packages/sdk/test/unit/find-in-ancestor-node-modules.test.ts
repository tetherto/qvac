// @ts-expect-error brittle has no type declarations
import test from "brittle";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findInAncestorNodeModules } from "@/expo/plugins/find-in-ancestor-node-modules";

type BrittleAssert = {
  is: Function;
  ok: Function;
};

function makePackage(parentDir: string, name: string) {
  const pkgDir = path.join(parentDir, "node_modules", ...name.split("/"));
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name }));
  return pkgDir;
}

function withTempProject(
  fn: (projectRoot: string, workspaceRoot: string) => void,
) {
  const workspaceRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "qvac-find-ancestor-")),
  );
  const projectRoot = path.join(workspaceRoot, "mobile");
  fs.mkdirSync(projectRoot);
  try {
    fn(projectRoot, workspaceRoot);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

test("findInAncestorNodeModules: finds a package at the start directory", (t: BrittleAssert) => {
  withTempProject((projectRoot) => {
    const expected = makePackage(projectRoot, "react-native-bare-kit");
    t.is(
      findInAncestorNodeModules(projectRoot, "react-native-bare-kit"),
      expected,
    );
  });
});

test("findInAncestorNodeModules: walks up and finds a hoisted package", (t: BrittleAssert) => {
  withTempProject((projectRoot, workspaceRoot) => {
    const expected = makePackage(workspaceRoot, "react-native-bare-kit");
    t.is(
      findInAncestorNodeModules(projectRoot, "react-native-bare-kit"),
      expected,
    );
  });
});

test("findInAncestorNodeModules: prefers the install closest to startDir", (t: BrittleAssert) => {
  withTempProject((projectRoot, workspaceRoot) => {
    const closer = makePackage(projectRoot, "@qvac/cli");
    makePackage(workspaceRoot, "@qvac/cli");
    t.is(findInAncestorNodeModules(projectRoot, "@qvac/cli"), closer);
  });
});

test("findInAncestorNodeModules: returns null when package is nowhere in the tree", (t: BrittleAssert) => {
  withTempProject((projectRoot) => {
    t.is(findInAncestorNodeModules(projectRoot, "@qvac/cli"), null);
  });
});

test("findInAncestorNodeModules: handles scoped package names", (t: BrittleAssert) => {
  withTempProject((projectRoot) => {
    const expected = makePackage(projectRoot, "@some-scope/some-pkg");
    t.is(
      findInAncestorNodeModules(projectRoot, "@some-scope/some-pkg"),
      expected,
    );
  });
});
