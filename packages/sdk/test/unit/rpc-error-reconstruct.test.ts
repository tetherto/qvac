// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { reconstructError, RPCError } from "@/client/rpc/rpc-error";
import { createErrorResponse } from "@/schemas/error";
import {
  RequestIdConflictError,
  RequestNotFoundError,
  RequestRejectedByPolicyError,
  ModelNotLoadedError,
} from "@/utils/errors-server";

test("reconstructError: RequestRejectedByPolicyError round-trips via name + typedFields", (t) => {
  const original = new RequestRejectedByPolicyError(
    "rid-1",
    "completion",
    "model-1",
    "oneAtATimePerModel",
  );
  const envelope = createErrorResponse(original);

  const reconstructed = reconstructError(envelope);

  t.ok(
    reconstructed instanceof RequestRejectedByPolicyError,
    "instanceof RequestRejectedByPolicyError must hold across the envelope",
  );
  // Type narrows after the instanceof check above; cast is for noUncheckedIndexedAccess + strict TS.
  const r = reconstructed as RequestRejectedByPolicyError;
  t.is(r.requestId, "rid-1");
  t.is(r.kind, "completion");
  t.is(r.modelId, "model-1");
  t.is(r.reason, "oneAtATimePerModel");
  t.is(r.code, 52420);
  t.ok(r instanceof Error, "reconstructed must still satisfy instanceof Error");
});

test("reconstructError: RequestIdConflictError round-trips", (t) => {
  const original = new RequestIdConflictError("rid-2");
  const envelope = createErrorResponse(original);

  const reconstructed = reconstructError(envelope);

  t.ok(reconstructed instanceof RequestIdConflictError);
  t.is((reconstructed as RequestIdConflictError).requestId, "rid-2");
  t.is((reconstructed as RequestIdConflictError).code, 52417);
});

test("reconstructError: RequestNotFoundError round-trips", (t) => {
  const original = new RequestNotFoundError("rid-3");
  const envelope = createErrorResponse(original);

  const reconstructed = reconstructError(envelope);

  t.ok(reconstructed instanceof RequestNotFoundError);
  t.is((reconstructed as RequestNotFoundError).requestId, "rid-3");
  t.is((reconstructed as RequestNotFoundError).code, 52418);
});

test("reconstructError: unknown error name falls through to RPCError", (t) => {
  // A QvacError with no entry in the reconstructor map round-trips name +
  // code via the legacy RPCError wrapper — instanceof RPCError must hold;
  // the original class is NOT recovered (and isn't expected to be — the
  // class isn't re-exported / registered for cross-RPC use).
  const original = new ModelNotLoadedError("model-1");
  const envelope = createErrorResponse(original);

  const reconstructed = reconstructError(envelope);

  t.ok(
    reconstructed instanceof RPCError,
    "unknown names must fall through to RPCError",
  );
  t.absent(
    reconstructed instanceof ModelNotLoadedError,
    "an unregistered class is NOT magically rebuilt",
  );
  const rpc = reconstructed as RPCError;
  // `name` comes from the SCREAMING_SNAKE error-code name (the reconstructor
  // map keys off this exact value).
  t.is(rpc.name, "MODEL_NOT_LOADED");
  t.is(rpc.isQvacError, true);
});

test("reconstructError: non-typed error envelope falls through to RPCError", (t) => {
  const envelope = createErrorResponse(new Error("plain"));

  const reconstructed = reconstructError(envelope);

  t.ok(reconstructed instanceof RPCError);
  t.is(reconstructed.message, "plain");
  t.is((reconstructed as RPCError).isQvacError, false);
});

test("reconstructError: missing typedFields on a known name does not throw", (t) => {
  // Defensive fall-through: if the server forgot to populate typedFields
  // for a registered class (e.g. an older worker hasn't been redeployed),
  // the reconstructor must coerce missing fields to defensible defaults
  // rather than throwing inside the catch — the consumer never sees a
  // "couldn't reconstruct" obscuring the real error.
  const envelope = {
    type: "error" as const,
    name: "REQUEST_REJECTED_BY_POLICY",
    code: 52420,
    message: "policy rejection",
  };

  const reconstructed = reconstructError(envelope);

  t.ok(reconstructed instanceof RequestRejectedByPolicyError);
  // Missing fields coerce to "" via readStringField; `reason` falls back
  // to the envelope message to preserve human-readable context.
  const r = reconstructed as RequestRejectedByPolicyError;
  t.is(r.requestId, "");
  t.is(r.kind, "");
  t.is(r.modelId, "");
  t.is(r.reason, "policy rejection");
});

test("reconstructError: remote stack/timestamp attach onto the reconstructed instance", (t) => {
  const original = new RequestRejectedByPolicyError(
    "rid-4",
    "embeddings",
    "model-2",
    "oneAtATimePerModel",
  );
  const envelope = createErrorResponse(original);

  const reconstructed = reconstructError(envelope) as RequestRejectedByPolicyError & {
    remoteStack?: string;
    timestamp?: string;
  };

  // timestamp is populated by createErrorResponse; remoteStack only when
  // the server included a stack (it does for QvacErrors).
  t.ok(reconstructed.timestamp, "remote timestamp should attach");
  t.ok(reconstructed.stack && reconstructed.stack.includes("Worker Stack"));
});
