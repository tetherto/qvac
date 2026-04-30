// @ts-ignore brittle has no type declarations
import test from "brittle";
import { resolve, sep } from "path";
import {
  sanitizePathComponent,
  checkPathWithinBase,
} from "@/utils/path-sanitize";

// Bun may expose `globalThis.Bare` for compatibility, but bare-* packages (e.g.
// bare-path) expect a real Bare global binding — only run these under the Bare
// test runner (`brittle-bare` / test:security:bare), not `bun run` unit tests.
const isBunUnitTestRunner =
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
// @ts-ignore Bare global only exists in Bare runtime
const isBareRuntime =
  !isBunUnitTestRunner && typeof globalThis.Bare !== "undefined";

function bareTest(name: string, fn: (t: unknown) => void) {
  if (isBareRuntime) {
    test(name, fn);
  } else {
    test.skip(`[bare-only] ${name}`, () => {});
  }
}

// ============== sanitizePathComponent ==============

test("sanitizePathComponent: strips ../ sequences", (t) => {
  t.is(sanitizePathComponent("../../../etc/passwd"), "etc/passwd");
  t.is(sanitizePathComponent("foo/../../../bar"), "foo/bar");
});

test("sanitizePathComponent: strips ..\\ sequences", (t) => {
  t.is(
    sanitizePathComponent("..\\..\\..\\Windows\\System32"),
    "Windows/System32",
  );
});

test("sanitizePathComponent: strips leading absolute path prefixes", (t) => {
  t.is(sanitizePathComponent("/etc/passwd"), "etc/passwd");
  t.is(sanitizePathComponent("C:\\Windows\\System32"), "Windows/System32");
  t.is(sanitizePathComponent("D:\\data\\file.txt"), "data/file.txt");
});

test("sanitizePathComponent: rejects null bytes", (t) => {
  t.exception(
    () => sanitizePathComponent("foo\0bar"),
    "should throw on null byte",
  );
  t.exception(
    () => sanitizePathComponent("foo%00bar"),
    "should throw on URL-encoded null byte",
  );
});

test("sanitizePathComponent: handles mixed separator attacks", (t) => {
  const result = sanitizePathComponent("..\\../mixed");
  t.ok(!result.includes(".."), `result "${result}" should not contain ..`);
});

test("sanitizePathComponent: handles URL-encoded traversal", (t) => {
  const result = sanitizePathComponent("%2e%2e%2f%2e%2e%2f");
  t.ok(!result.includes(".."), `result "${result}" should not contain ..`);
});

test("sanitizePathComponent: passes through clean names unchanged", (t) => {
  t.is(sanitizePathComponent("model.gguf"), "model.gguf");
  t.is(
    sanitizePathComponent("my-model-00001-of-00002.gguf"),
    "my-model-00001-of-00002.gguf",
  );
  t.is(sanitizePathComponent("workspace-name"), "workspace-name");
  t.is(sanitizePathComponent("abc123_def456"), "abc123_def456");
});

test("sanitizePathComponent: handles empty string", (t) => {
  t.is(sanitizePathComponent(""), "");
});

// ============== checkPathWithinBase ==============

test("checkPathWithinBase: returns true for contained paths", (t) => {
  t.ok(checkPathWithinBase("/safe/dir", "/safe/dir/file.txt", resolve, sep));
  t.ok(
    checkPathWithinBase(
      "/safe/dir",
      "/safe/dir/sub/deep/file.txt",
      resolve,
      sep,
    ),
  );
  t.ok(checkPathWithinBase("/safe/dir/", "/safe/dir/file.txt", resolve, sep));
});

test("checkPathWithinBase: returns false for escaped paths", (t) => {
  t.absent(
    checkPathWithinBase(
      "/safe/dir",
      "/safe/dir/../../../etc/passwd",
      resolve,
      sep,
    ),
  );
  t.absent(checkPathWithinBase("/safe/dir", "/etc/passwd", resolve, sep));
  t.absent(checkPathWithinBase("/safe/dir", "/safe/di", resolve, sep));
  t.absent(
    checkPathWithinBase("/safe/dir", "/safe/directory/file.txt", resolve, sep),
  );
});

test("checkPathWithinBase: handles the base path itself", (t) => {
  t.ok(checkPathWithinBase("/safe/dir", "/safe/dir", resolve, sep));
  t.ok(checkPathWithinBase("/safe/dir", "/safe/dir/", resolve, sep));
});

// ============== Server-side functions (Bare runtime only) ==============

bareTest("validateAndJoinPath: joins clean components", async (t: any) => {
  const { validateAndJoinPath } = await import("@/server/utils/path-security");
  const result = validateAndJoinPath("/base/dir", "subdir", "file.gguf");
  t.ok(result.endsWith("/base/dir/subdir/file.gguf"), `result: ${result}`);
});

bareTest("validateAndJoinPath: neutralizes traversal", async (t: any) => {
  const { validateAndJoinPath, isPathWithinBase } =
    await import("@/server/utils/path-security");
  const result = validateAndJoinPath("/base/dir", "../../../etc/passwd");
  t.ok(
    isPathWithinBase("/base/dir", result),
    `result "${result}" must be within /base/dir`,
  );
});

bareTest("validateAndJoinPath: throws on null byte", async (t: any) => {
  const { validateAndJoinPath } = await import("@/server/utils/path-security");
  t.exception(() => validateAndJoinPath("/base/dir", "foo\0bar.gguf"));
});

bareTest("isPathWithinBase: rejects escaped paths", async (t: any) => {
  const { isPathWithinBase } = await import("@/server/utils/path-security");
  t.absent(isPathWithinBase("/safe/dir", "/etc/passwd"));
  t.absent(isPathWithinBase("/safe/dir", "/safe/dir/../../../etc/passwd"));
  t.absent(isPathWithinBase("/safe/dir", "/safe/directory/file.txt"));
});

bareTest("isPathWithinBase: accepts contained paths", async (t: any) => {
  const { isPathWithinBase } = await import("@/server/utils/path-security");
  t.ok(isPathWithinBase("/safe/dir", "/safe/dir/file.txt"));
  t.ok(isPathWithinBase("/safe/dir", "/safe/dir"));
});

// ============== Archive extraction (Bare runtime only) ==============

bareTest(
  "extractTarStream: malicious entries do not escape extractDir",
  async (t: any) => {
    const { extractTarStream } = await import("@/server/utils/archive");
    const { isPathWithinBase } = await import("@/server/utils/path-security");
    const barePath = await import("bare-path");
    const bareFs = await import("bare-fs");
    const bareProcess = await import("bare-process");

    const cwd = bareProcess.default.cwd();
    const fixturePath = barePath.join(
      cwd,
      "test",
      "fixtures",
      "malicious-zipslip.tar.gz",
    );
    const extractDir = barePath.join(
      cwd,
      "test",
      "fixtures",
      "tmp-extract-bare",
    );

    bareFs.mkdirSync(extractDir, { recursive: true });

    try {
      await extractTarStream(fixturePath, extractDir, true);

      // Check that no files escaped
      const resolvedExtractDir = barePath.resolve(extractDir);
      const escapedPaths = [
        barePath.resolve(barePath.join(extractDir, "../../../escape.gguf")),
        barePath.resolve(
          barePath.join(extractDir, "../../../../tmp/pwned.gguf"),
        ),
        barePath.resolve(
          barePath.join(
            extractDir,
            "models/../../../../../../escape-nested.gguf",
          ),
        ),
      ];

      for (const p of escapedPaths) {
        let exists = false;
        try {
          bareFs.accessSync(p);
          exists = true;
        } catch {}
        t.absent(exists, `file must not exist outside extractDir: ${p}`);
      }

      // Legitimate files should still be extracted
      const files = bareFs.readdirSync(extractDir) as string[];
      const legit = files.filter((f: string) => f.startsWith("legit-model-"));
      t.is(legit.length, 2, "legitimate shard files must be extracted");
    } finally {
      // Cleanup
      try {
        bareFs.rmSync(extractDir, { recursive: true });
      } catch {}
      const escapedCleanup = [
        barePath.resolve(barePath.join(extractDir, "../../../escape.gguf")),
        barePath.resolve(
          barePath.join(extractDir, "../../../../tmp/pwned.gguf"),
        ),
        barePath.resolve(
          barePath.join(
            extractDir,
            "models/../../../../../../escape-nested.gguf",
          ),
        ),
      ];
      for (const p of escapedCleanup) {
        try {
          bareFs.rmSync(p);
        } catch {}
      }
    }
  },
);
