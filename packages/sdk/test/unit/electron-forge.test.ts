import test from "brittle";
import path from "path";

const PLUGIN_PATH = path.join(
  __dirname,
  "../../electron-forge/index.cjs",
);

const {
  createIgnore,
  diffAddons,
  detectTargetHosts,
  QvacForgePluginError,
  setLogLevel,
} = require(PLUGIN_PATH);

setLogLevel("off");

// ============================================
// diffAddons
// ============================================

test("diffAddons: required is subset → exclusions are the diff", (t) => {
  const installed = [
    "@qvac/llm-llamacpp",
    "@qvac/ocr-onnx",
    "@qvac/embed-llamacpp",
  ];
  const required = ["@qvac/llm-llamacpp"];
  const result = diffAddons(installed, required).sort();
  t.alike(result, ["@qvac/embed-llamacpp", "@qvac/ocr-onnx"]);
});

test("diffAddons: empty required → all installed are exclusions", (t) => {
  const installed = ["@qvac/llm-llamacpp", "@qvac/ocr-onnx"];
  t.alike(diffAddons(installed, []).sort(), [
    "@qvac/llm-llamacpp",
    "@qvac/ocr-onnx",
  ]);
});

test("diffAddons: required matches all installed → no exclusions", (t) => {
  const installed = ["@qvac/llm-llamacpp"];
  t.alike(diffAddons(installed, ["@qvac/llm-llamacpp"]), []);
});

test("diffAddons: empty installed → no exclusions", (t) => {
  t.alike(diffAddons([], ["@qvac/llm-llamacpp"]), []);
});

// ============================================
// createIgnore: composition with user ignore
// ============================================

test("createIgnore: composes with user function (user OR addon OR mobile prebuild OR out/)", (t) => {
  const userFn = (filePath: string) => filePath.includes("/.git/");
  const ignore = createIgnore(["@qvac/ocr-onnx"], userFn);

  t.is(typeof ignore, "function", "function input → function output");
  t.ok(ignore("/x/.git/HEAD"), "user fn match");
  t.ok(
    ignore("/x/node_modules/@qvac/ocr-onnx/package.json"),
    "excluded addon match",
  );
  t.ok(
    ignore("/x/node_modules/anything/prebuilds/android-arm64/native.bare"),
    "android prebuild match",
  );
  t.ok(
    ignore("/x/node_modules/anything/prebuilds/ios-arm64/native.bare"),
    "ios prebuild match",
  );
  t.ok(
    ignore("/out/test-electron-app-darwin-arm64/foo.bin"),
    "out/ excluded in function-form too (parity with array form)",
  );
  t.absent(
    ignore("/x/node_modules/@qvac/llm-llamacpp/package.json"),
    "non-excluded addon kept",
  );
  t.absent(ignore("/x/index.js"), "regular file kept");
});

test("createIgnore: composes with user array", (t) => {
  const userPattern = /^\/secret\//;
  const ignore = createIgnore(["@qvac/ocr-onnx"], [userPattern]);

  t.ok(Array.isArray(ignore), "array input → array output");
  t.ok(
    ignore.some((re: RegExp) => re.source === userPattern.source),
    "user pattern preserved",
  );
  t.ok(
    ignore.some((re: RegExp) =>
      re.test("/x/node_modules/@qvac/ocr-onnx/package.json"),
    ),
    "excluded addon pattern present",
  );
  t.ok(
    ignore.some((re: RegExp) =>
      re.test("/x/node_modules/x/prebuilds/ios-arm64/native.bare"),
    ),
    "ios prebuild pattern present",
  );
  t.ok(
    ignore.some((re: RegExp) =>
      re.test("/x/node_modules/x/prebuilds/android-arm64/native.bare"),
    ),
    "android prebuild pattern present",
  );
});

test("createIgnore: undefined existing → array form with no user patterns", (t) => {
  const ignore = createIgnore([], undefined);
  t.ok(Array.isArray(ignore));
  t.is(
    ignore.filter((re: unknown) => re instanceof RegExp).length,
    ignore.length,
    "all entries are regexes",
  );
});

test("createIgnore: empty exclusions still excludes mobile prebuilds", (t) => {
  const ignore = createIgnore([], undefined);
  t.ok(Array.isArray(ignore));
  t.ok(
    ignore.some((re: RegExp) =>
      re.test("/x/node_modules/x/prebuilds/android-arm64/native.bare"),
    ),
    "mobile prebuild excluded even with no addon exclusions",
  );
});

// ============================================
// detectTargetHosts
// ============================================

test("detectTargetHosts: no flags → null (caller falls back to defaultHosts)", (t) => {
  t.is(detectTargetHosts({}, []), null);
  t.is(detectTargetHosts({ packagerConfig: {} }, []), null);
});

test("detectTargetHosts: --platform + --arch (=value form) → single host", (t) => {
  t.alike(
    detectTargetHosts({}, ["--platform=win32", "--arch=x64"]),
    ["win32-x64"],
  );
});

test("detectTargetHosts: --platform + --arch (space form) → single host", (t) => {
  t.alike(
    detectTargetHosts({}, ["--platform", "linux", "--arch", "arm64"]),
    ["linux-arm64"],
  );
});

test("detectTargetHosts: comma-separated --arch expands to multiple hosts", (t) => {
  t.alike(
    detectTargetHosts({}, ["--platform=darwin", "--arch=arm64,x64"]),
    ["darwin-arm64", "darwin-x64"],
  );
});

test("detectTargetHosts: CLI overrides packagerConfig", (t) => {
  const cfg = { packagerConfig: { platform: "darwin", arch: "x64" } };
  t.alike(detectTargetHosts(cfg, ["--arch=arm64"]), ["darwin-arm64"]);
});

test("detectTargetHosts: only --arch given → uses host platform", (t) => {
  const result = detectTargetHosts({}, ["--arch=arm64"]);
  t.alike(result, [`${process.platform}-arm64`]);
});

// ============================================
// QvacForgePluginError
// ============================================

test("QvacForgePluginError: trimmed stack for cleaner Forge unhandled-rejection", (t) => {
  const err = new QvacForgePluginError("boom");
  t.is(err.name, "QvacForgePluginError");
  t.is(err.message, "boom");
  t.is(
    err.stack,
    "QvacForgePluginError: boom",
    "stack is exactly name+message — Forge unhandled-rejection block stays focused",
  );
  t.ok(err instanceof Error);
});
