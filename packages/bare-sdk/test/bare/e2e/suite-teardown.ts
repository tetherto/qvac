import test from "brittle";
import { closeWorker } from "../_lib/resources.js";

// Closes the worker so the process exits. Not a *.test.ts so the capability
// glob skips it; make:test:bare:e2e appends it as the last glob arg to run last.
test("bare-sdk e2e: close the bare worker (suite teardown)", async (t) => {
  await closeWorker();
  t.pass("bare worker closed");
});
