// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  loadModelOptionsToRequestSchema,
  downloadAssetOptionsToRequestSchema,
} from "@/schemas";
import { ragRequestSchema } from "@/schemas/rag";
import { ModelType } from "@/schemas/model-types";

// -----------------------------------------------------------------------------
// requestId wire-shape round-trip — schema half.
//
// The decorated-promise contract says: the client generates a
// `requestId` once, the request envelope carries it on the wire, and
// the server uses that same value as the registry-entry key. These
// tests pin the **envelope half** — that the request schemas accept
// and preserve `requestId` for `loadModel`, `downloadAsset`, and `rag`.
//
// The handler-side half (server keys the registry on the client's
// `requestId`) is exercised by the per-handler tests in
// `request-registry.test.ts` + the dispatcher-level cancel arm in
// `cancelHandler.ts`.
// -----------------------------------------------------------------------------

type T = {
  is: (actual: unknown, expected: unknown, msg?: string) => void;
  ok: (value: unknown, msg?: string) => void;
};

test("loadModelOptionsToRequestSchema: forwards requestId onto the wire envelope", (t: T) => {
  const parsed = loadModelOptionsToRequestSchema.parse({
    modelType: ModelType.llamacppCompletion,
    modelSrc: "/tmp/model.gguf",
    requestId: "client-uuid-load",
  });
  t.is(
    (parsed as { requestId?: string }).requestId,
    "client-uuid-load",
    "loadModel envelope must carry the client-generated requestId",
  );
});

test("loadModelOptionsToRequestSchema: requestId is optional (legacy clients)", (t: T) => {
  const parsed = loadModelOptionsToRequestSchema.parse({
    modelType: ModelType.llamacppCompletion,
    modelSrc: "/tmp/model.gguf",
  });
  t.is(
    (parsed as { requestId?: string }).requestId,
    undefined,
    "missing requestId stays undefined on the envelope — server falls back to server-generated id",
  );
});

test("downloadAssetOptionsToRequestSchema: forwards requestId onto the wire envelope", (t: T) => {
  const parsed = downloadAssetOptionsToRequestSchema.parse({
    assetSrc: "/tmp/asset.bin",
    requestId: "client-uuid-dl",
  });
  t.is(
    (parsed as { requestId?: string }).requestId,
    "client-uuid-dl",
    "downloadAsset envelope must carry the client-generated requestId",
  );
});

test("downloadAssetOptionsToRequestSchema: requestId is optional", (t: T) => {
  const parsed = downloadAssetOptionsToRequestSchema.parse({
    assetSrc: "/tmp/asset.bin",
  });
  t.is((parsed as { requestId?: string }).requestId, undefined);
});

test("ragRequestSchema: forwards requestId for ingest", (t: T) => {
  const parsed = ragRequestSchema.parse({
    type: "rag",
    operation: "ingest",
    workspace: "ws-a",
    modelId: "model-a",
    documents: "hello",
    requestId: "client-uuid-rag",
  });
  t.is(
    (parsed as { requestId?: string }).requestId,
    "client-uuid-rag",
    "rag ingest envelope must carry the client-generated requestId",
  );
});

test("ragRequestSchema: requestId is optional for ingest", (t: T) => {
  const parsed = ragRequestSchema.parse({
    type: "rag",
    operation: "ingest",
    workspace: "ws-a",
    modelId: "model-a",
    documents: "hello",
  });
  t.is((parsed as { requestId?: string }).requestId, undefined);
});

test("ragRequestSchema: forwards requestId for reindex (storage-only op)", (t: T) => {
  const parsed = ragRequestSchema.parse({
    type: "rag",
    operation: "reindex",
    workspace: "ws-a",
    requestId: "client-uuid-reindex",
  });
  t.is((parsed as { requestId?: string }).requestId, "client-uuid-reindex");
});
