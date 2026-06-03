import test from "brittle";

// -----------------------------------------------------------------------------
// Server-side path security — Bare runtime tests.
//
// Tests `validateAndJoinPath`, `isPathWithinBase` from the server utils, and
// `extractTarStream` archive extraction. These require the Bare runtime
// (bare-path, bare-fs, bare-process) and run via `npm run test:bare`.
//
// The shared/client-side path security tests (sanitizePathComponent,
// checkPathWithinBase) live in test/unit/path-security.test.ts.
// -----------------------------------------------------------------------------


test("validateAndJoinPath: joins clean components", async (t) => {
  const { validateAndJoinPath } = await import("@/server/utils/path-security");
  const result = validateAndJoinPath("/base/dir", "subdir", "file.gguf");
  t.ok(result.endsWith("/base/dir/subdir/file.gguf"), `result: ${result}`);
});

test("validateAndJoinPath: neutralizes traversal", async (t) => {
  const { validateAndJoinPath, isPathWithinBase } =
    await import("@/server/utils/path-security");
  const result = validateAndJoinPath("/base/dir", "../../../etc/passwd");
  t.ok(
    isPathWithinBase("/base/dir", result),
    `result "${result}" must be within /base/dir`,
  );
});

test("validateAndJoinPath: throws on null byte", async (t) => {
  const { validateAndJoinPath } = await import("@/server/utils/path-security");
  t.exception(() => validateAndJoinPath("/base/dir", "foo\0bar.gguf"));
});

test("isPathWithinBase: rejects escaped paths", async (t) => {
  const { isPathWithinBase } = await import("@/server/utils/path-security");
  t.absent(isPathWithinBase("/safe/dir", "/etc/passwd"));
  t.absent(isPathWithinBase("/safe/dir", "/safe/dir/../../../etc/passwd"));
  t.absent(isPathWithinBase("/safe/dir", "/safe/directory/file.txt"));
});

test("isPathWithinBase: accepts contained paths", async (t) => {
  const { isPathWithinBase } = await import("@/server/utils/path-security");
  t.ok(isPathWithinBase("/safe/dir", "/safe/dir/file.txt"));
  t.ok(isPathWithinBase("/safe/dir", "/safe/dir"));
});

test(
  "extractTarStream: malicious entries do not escape extractDir",
  async (t) => {
    const { extractTarStream } = await import("@/server/utils/archive");
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

      const files = bareFs.readdirSync(extractDir) as string[];
      const legit = files.filter((f: string) => f.startsWith("legit-model-"));
      t.is(legit.length, 2, "legitimate shard files must be extracted");
    } finally {
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
