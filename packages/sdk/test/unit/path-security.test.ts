import test from "brittle";
import { resolve, sep } from "path";
import {
  sanitizePathComponent,
  checkPathWithinBase,
} from "@/utils/path-sanitize";

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

