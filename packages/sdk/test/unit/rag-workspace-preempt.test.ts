// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  getActiveRagRequest,
  setActiveRagRequest,
  clearActiveRagRequest,
} from "@/server/bare/rag-hyperdb/rag-operation-manager";

// -----------------------------------------------------------------------------
// RAG workspace → requestId map.
//
// The dispatcher-level pre-emption rule in `server/rpc/handlers/rag.ts`
// (cancel any existing RAG request on the same workspace before
// beginning a new one) is built on three small helpers in
// `rag-operation-manager.ts`:
//
//   - `getActiveRagRequest(workspace)` — returns the currently-tracked
//     `requestId` (or `undefined`)
//   - `setActiveRagRequest(workspace, requestId)` — replaces it
//   - `clearActiveRagRequest(workspace, requestId)` — clears iff the
//     map still holds the same id (the "still mine?" guard)
//
// The "still mine?" guard is what makes pre-emption safe: an older
// op's scope-deferred cleanup must not wipe out a newer op's mapping.
// These tests pin that contract in isolation from the registry so a
// refactor that loses the guard will fail here before the integration
// surface breaks.
// -----------------------------------------------------------------------------

type T = {
  is: (actual: unknown, expected: unknown, msg?: string) => void;
  ok: (value: unknown, msg?: string) => void;
};

const WS = "ws-test";
const WS_OTHER = "ws-other";

test("rag workspace map: get returns undefined before set", (t: T) => {
  clearActiveRagRequest(WS, "unused");
  t.is(getActiveRagRequest(WS), undefined);
});

test("rag workspace map: set / get round-trip", (t: T) => {
  setActiveRagRequest(WS, "r-1");
  t.is(getActiveRagRequest(WS), "r-1");
  clearActiveRagRequest(WS, "r-1");
  t.is(getActiveRagRequest(WS), undefined);
});

test("rag workspace map: set replaces (pre-emption write path)", (t: T) => {
  setActiveRagRequest(WS, "r-1");
  setActiveRagRequest(WS, "r-2");
  t.is(getActiveRagRequest(WS), "r-2", "newer requestId replaces the older");
  clearActiveRagRequest(WS, "r-2");
});

test("rag workspace map: clear is a no-op for stale requestId (still-mine guard)", (t: T) => {
  setActiveRagRequest(WS, "r-current");
  // Older op's scope unwind fires after a newer op has already
  // installed its mapping. The stale clear must not stomp.
  clearActiveRagRequest(WS, "r-stale");
  t.is(
    getActiveRagRequest(WS),
    "r-current",
    "stale clear leaves the current mapping intact",
  );
  clearActiveRagRequest(WS, "r-current");
});

test("rag workspace map: workspaces are isolated", (t: T) => {
  setActiveRagRequest(WS, "r-a");
  setActiveRagRequest(WS_OTHER, "r-b");
  t.is(getActiveRagRequest(WS), "r-a");
  t.is(getActiveRagRequest(WS_OTHER), "r-b");
  clearActiveRagRequest(WS, "r-a");
  t.is(getActiveRagRequest(WS), undefined);
  t.is(
    getActiveRagRequest(WS_OTHER),
    "r-b",
    "clearing one workspace must not touch the other",
  );
  clearActiveRagRequest(WS_OTHER, "r-b");
});
