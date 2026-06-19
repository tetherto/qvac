import test from "brittle";
import { getClientLogger } from "@/logging/client-logger";
import { createBaseLogger } from "@/logging/base-logger";
import { logLevelSchema } from "@/schemas/logging-stream";

test("logLevelSchema: accepts off alongside the standard levels", (t) => {
  for (const level of ["error", "warn", "info", "debug", "off"]) {
    t.is(logLevelSchema.safeParse(level).success, true, level);
  }
  t.is(logLevelSchema.safeParse("verbose").success, false);
});

test("getClientLogger: silent console by default, still feeds transports", (t) => {
  const original = console.info;
  let printed = 0;
  console.info = () => {
    printed++;
  };
  t.teardown(() => {
    console.info = original;
  });

  const received: string[] = [];
  const logger = getClientLogger({
    transports: [(_level, _namespace, message) => received.push(message)],
  });
  logger.info("hello");

  t.is(printed, 0, "nothing printed to console");
  t.alike(received, ["hello"], "transport still receives the log");
});

test("getClientLogger: enableConsole opts back into console output", (t) => {
  const original = console.info;
  let printed = 0;
  console.info = () => {
    printed++;
  };
  t.teardown(() => {
    console.info = original;
  });

  getClientLogger({ enableConsole: true }).info("hi");

  t.ok(printed > 0, "console prints when explicitly enabled");
});

test("level off: silences console, stream, and transports together", (t) => {
  const originals = {
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };
  let printed = 0;
  console.error = console.warn = console.info = console.debug = () => {
    printed++;
  };
  t.teardown(() => {
    console.error = originals.error;
    console.warn = originals.warn;
    console.info = originals.info;
    console.debug = originals.debug;
  });

  const streamed: string[] = [];
  const transported: string[] = [];
  const logger = createBaseLogger(
    "test:off",
    {
      level: "off",
      enableConsole: true,
      transports: [(_l, _n, message) => transported.push(message)],
    },
    { onLog: (_l, _n, message) => streamed.push(message) },
  );

  logger.error("e");
  logger.warn("w");
  logger.info("i");
  logger.debug("d");

  t.is(printed, 0, "nothing printed to console at off");
  t.alike(streamed, [], "stream callback receives nothing at off");
  t.alike(transported, [], "transports receive nothing at off");
});
