// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { createErrorResponse } from "@/schemas/error";
import {
  RequestIdConflictError,
  RequestNotFoundError,
  RequestRejectedByPolicyError,
  InferenceCancelledError,
  ModelNotLoadedError,
} from "@/utils/errors-server";

test("createErrorResponse: RequestRejectedByPolicyError carries its named fields on typedFields", (t) => {
  const err = new RequestRejectedByPolicyError(
    "rid-1",
    "completion",
    "model-1",
    "oneAtATimePerModel",
  );
  const response = createErrorResponse(err);

  t.is(response.type, "error");
  // `QvacErrorBase.name` is the SCREAMING_SNAKE error-code name from
  // sdk-errors-server.ts, not the JS class name — the rpc-error.ts
  // reconstructor map keys off this value.
  t.is(response.name, "REQUEST_REJECTED_BY_POLICY");
  t.is(response.code, 52420);
  t.alike(response.typedFields, {
    requestId: "rid-1",
    kind: "completion",
    modelId: "model-1",
    reason: "oneAtATimePerModel",
  });
});

test("createErrorResponse: RequestIdConflictError carries requestId on typedFields", (t) => {
  const err = new RequestIdConflictError("rid-2");
  const response = createErrorResponse(err);

  t.is(response.name, "REQUEST_ID_CONFLICT");
  t.is(response.code, 52417);
  t.alike(response.typedFields, { requestId: "rid-2" });
});

test("createErrorResponse: RequestNotFoundError carries requestId on typedFields", (t) => {
  const err = new RequestNotFoundError("rid-3");
  const response = createErrorResponse(err);

  t.is(response.name, "REQUEST_NOT_FOUND");
  t.is(response.code, 52418);
  t.alike(response.typedFields, { requestId: "rid-3" });
});

test("createErrorResponse: QvacError without toErrorResponseFields omits typedFields", (t) => {
  // ModelNotLoadedError is a QvacError but doesn't opt into typed-field
  // serialisation — the response carries name/code/message but no
  // typedFields envelope.
  const err = new ModelNotLoadedError("model-1");
  const response = createErrorResponse(err);

  t.is(response.name, "MODEL_NOT_LOADED");
  t.is(response.typedFields, undefined);
});

test("createErrorResponse: plain Error produces a non-typed envelope", (t) => {
  const err = new Error("something broke");
  const response = createErrorResponse(err);

  t.is(response.type, "error");
  t.is(response.message, "something broke");
  t.is(response.name, undefined);
  t.is(response.code, undefined);
  t.is(response.typedFields, undefined);
});

test("createErrorResponse: InferenceCancelledError does NOT round-trip via typedFields (client-constructed)", (t) => {
  // InferenceCancelledError is built client-side in completion-stream.ts
  // when the event stream ends with stopReason: "cancelled". Even if the
  // server happens to throw one (rare — e.g. a fixture), the reconstructor
  // map deliberately has no entry for its name, so a `typedFields` value
  // here would be inert. We assert the envelope shape is sane and explicitly
  // does not declare typed fields the client wasn't asked to reconstruct.
  const err = new InferenceCancelledError("rid-4");
  const response = createErrorResponse(err);

  t.is(response.name, "INFERENCE_CANCELLED");
  t.is(response.code, 52419);
  // No `toErrorResponseFields()` method on this class — typedFields stays
  // undefined.
  t.is(response.typedFields, undefined);
});
