// @ts-expect-error brittle has no type declarations
import test from "brittle";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  MOBILE_HOSTS,
  buildVerifyBundleCommand,
  resolveCliCommand,
} from "@/expo/plugins/withMobileBundle";

type BrittleAssert = {
  is: Function;
  ok: Function;
  alike: Function;
  exception: Function;
  absent: Function;
};

function withTempProjectRoot(
  fn: (projectRoot: string, cliDir: string, cliEntry: string) => void,
): void {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "qvac-expo-wiring-"),
  );
  const cliDir = path.join(projectRoot, "node_modules", "@qvac", "cli", "dist");
  const cliEntry = path.join(cliDir, "index.js");
  try {
    fn(projectRoot, cliDir, cliEntry);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

test("MOBILE_HOSTS: canonical mobile host set", (t: BrittleAssert) => {
  t.alike(MOBILE_HOSTS, [
    "android-arm64",
    "ios-arm64",
    "ios-arm64-simulator",
    "ios-x64-simulator",
  ]);
});

test("buildVerifyBundleCommand: emits a --host flag per host", (t: BrittleAssert) => {
  const cmd = buildVerifyBundleCommand({
    cliCommand: 'node "/abs/cli/dist/index.js"',
    bundlePath: "/abs/qvac/worker.bundle.js",
    hosts: MOBILE_HOSTS,
  });
  for (const host of MOBILE_HOSTS) {
    t.ok(cmd.includes(`--host ${host}`), `command includes --host ${host}`);
  }
});

test("buildVerifyBundleCommand: omits --config when not provided", (t: BrittleAssert) => {
  const cmd = buildVerifyBundleCommand({
    cliCommand: 'node "/abs/cli/dist/index.js"',
    bundlePath: "/abs/qvac/worker.bundle.js",
    hosts: MOBILE_HOSTS,
  });
  t.absent(cmd.includes("--config"));
  t.absent(cmd.includes("--bare-runtime-version"));
});

test("buildVerifyBundleCommand: passes --config when provided", (t: BrittleAssert) => {
  const cmd = buildVerifyBundleCommand({
    cliCommand: 'node "/abs/cli/dist/index.js"',
    bundlePath: "/abs/qvac/worker.bundle.js",
    hosts: ["ios-arm64"],
    configPath: "/abs/proj/qvac.config.json",
  });
  t.ok(cmd.includes('--config "/abs/proj/qvac.config.json"'));
});

test("buildVerifyBundleCommand: quotes a config path containing spaces", (t: BrittleAssert) => {
  const cmd = buildVerifyBundleCommand({
    cliCommand: 'node "/abs/cli/dist/index.js"',
    bundlePath: "/abs/qvac/worker.bundle.js",
    hosts: ["ios-arm64"],
    configPath: "/abs path with spaces/qvac.config.json",
  });
  t.ok(cmd.includes('--config "/abs path with spaces/qvac.config.json"'));
});

test("buildVerifyBundleCommand: quotes the bundle path", (t: BrittleAssert) => {
  const cmd = buildVerifyBundleCommand({
    cliCommand: 'node "/abs/cli/dist/index.js"',
    bundlePath: "/abs path with spaces/qvac/worker.bundle.js",
    hosts: ["ios-arm64"],
  });
  t.ok(
    cmd.includes('--addons-source "/abs path with spaces/qvac/worker.bundle.js"'),
  );
});

test("buildVerifyBundleCommand: invokes the verify bundle subcommand", (t: BrittleAssert) => {
  const cmd = buildVerifyBundleCommand({
    cliCommand: 'node "/abs/cli/dist/index.js"',
    bundlePath: "/abs/qvac/worker.bundle.js",
    hosts: ["ios-arm64"],
  });
  t.ok(cmd.includes(" verify bundle "));
});

test("resolveCliCommand: returns node-invocation when local CLI exists", (t: BrittleAssert) => {
  withTempProjectRoot((projectRoot, cliDir, cliEntry) => {
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(cliEntry, "// stub", "utf8");
    const cmd = resolveCliCommand(projectRoot);
    t.is(cmd, `node "${cliEntry}"`);
  });
});

test("resolveCliCommand: warns and falls back to npx when CLI missing", (t: BrittleAssert) => {
  withTempProjectRoot((projectRoot) => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const cmd = resolveCliCommand(projectRoot);
      t.is(cmd, "npx --package=@qvac/cli qvac");
      t.ok(
        logs.some((m) => m.includes("@qvac/cli not found")),
        "warns about missing @qvac/cli",
      );
      t.ok(
        logs.some((m) => m.includes("falling back to npx")),
        "warning surfaces the fallback",
      );
    } finally {
      console.log = originalLog;
    }
  });
});
