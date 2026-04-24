// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { resolveClearStorageTarget } from "@/server/utils/clear-storage";

const CACHE = "/home/user/.qvac/models";

test("companion set path deletes parent directory", (t: { is: Function }) => {
  const result = resolveClearStorageTarget(
    `${CACHE}/sets/abc123/model.onnx`,
    CACHE,
  );
  t.is(result.kind, "directory");
  t.is(result.path, `${CACHE}/sets/abc123`);
});

test("legacy onnx path deletes parent directory", (t: { is: Function }) => {
  const result = resolveClearStorageTarget(
    `${CACHE}/onnx/def456/encoder.onnx`,
    CACHE,
  );
  t.is(result.kind, "directory");
  t.is(result.path, `${CACHE}/onnx/def456`);
});

test("flat cache file deletes file only", (t: { is: Function }) => {
  const result = resolveClearStorageTarget(
    `${CACHE}/abc123-model.gguf`,
    CACHE,
  );
  t.is(result.kind, "file");
  t.is(result.path, `${CACHE}/abc123-model.gguf`);
});

test("path outside cache always deletes file only", (t: { is: Function }) => {
  const result = resolveClearStorageTarget(
    "/Users/me/models/sets/foo/model.gguf",
    CACHE,
  );
  t.is(result.kind, "file");
  t.is(result.path, "/Users/me/models/sets/foo/model.gguf");
});

test("deeply nested cache path deletes file only", (t: { is: Function }) => {
  const result = resolveClearStorageTarget(
    `${CACHE}/sets/abc123/subdir/model.onnx`,
    CACHE,
  );
  t.is(result.kind, "file");
  t.is(result.path, `${CACHE}/sets/abc123/subdir/model.onnx`);
});

test("cache dir with trailing slash is normalized", (t: { is: Function }) => {
  const result = resolveClearStorageTarget(
    `${CACHE}/sets/abc123/model.onnx`,
    `${CACHE}/`,
  );
  t.is(result.kind, "directory");
  t.is(result.path, `${CACHE}/sets/abc123`);
});

test("windows backslash paths are handled correctly", (t: { is: Function }) => {
  const winCache = "C:\\Users\\me\\.qvac\\models";
  const result = resolveClearStorageTarget(
    `${winCache}\\sets\\abc123\\model.onnx`,
    winCache,
  );
  t.is(result.kind, "directory");
  t.is(result.path, "C:/Users/me/.qvac/models/sets/abc123");
});
