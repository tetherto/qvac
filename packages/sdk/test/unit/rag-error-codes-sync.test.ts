// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { ERR_CODES } from "@qvac/rag";
import { RAG_ERROR_CODES } from "@/schemas/sdk-errors-rag";

test("RAG_ERROR_CODES: OPERATION_CANCELLED matches @qvac/rag ERR_CODES", (t) => {
  t.is(
    RAG_ERROR_CODES.OPERATION_CANCELLED,
    ERR_CODES.OPERATION_CANCELLED,
    "SDK-exported RAG cancellation code must stay in sync with @qvac/rag",
  );
});
