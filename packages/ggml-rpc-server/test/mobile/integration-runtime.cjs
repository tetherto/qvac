"use strict";

// Bare may report addon-load failures as unhandled worklet errors. Keep the
// device run red even when the error only reaches a runtime event handler.
let fatalError = null;
if (typeof Bare !== "undefined" && typeof Bare.on === "function") {
  Bare.on("unhandledRejection", (reason) => {
    fatalError ??= reason || new Error("unhandledRejection");
    console.error("[integration-runner] Unhandled rejection:", reason);
  });
  Bare.on("uncaughtException", (error) => {
    fatalError ??= error || new Error("uncaughtException");
    console.error("[integration-runner] Uncaught exception:", error);
  });
  Bare.on("beforeExit", () => {
    if (!fatalError) return;
    if (typeof Bare.exit === "function") Bare.exit(1);
    else Bare.exitCode = 1;
  });
}
