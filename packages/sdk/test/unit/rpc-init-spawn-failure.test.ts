import test from "brittle";
import { getRPC, close } from "@/client/rpc/node-rpc-client";
import { BareRuntimeBinaryNotFoundError } from "@/utils/errors-client";

const FAKE_PLATFORM = "commodore64";

function defineProcessValue(name: "platform", value: string) {
  Object.defineProperty(process, name, {
    configurable: true,
    value,
  });
}

function restoreProcessProperty(
  name: "platform",
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(process, name, descriptor);
}

void test("RPC init maps bare-runtime binary resolution failures", async function (t) {
  t.timeout(10_000);

  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  const originalArch = process.arch;

  t.teardown(async function () {
    restoreProcessProperty("platform", platformDescriptor);
    try {
      await close();
    } catch {}
  });

  defineProcessValue("platform", FAKE_PLATFORM);

  let thrown: Error | undefined;
  try {
    await getRPC();
  } catch (error) {
    thrown = error as Error;
  }

  t.ok(
    thrown instanceof BareRuntimeBinaryNotFoundError,
    `expected BareRuntimeBinaryNotFoundError, got ${thrown?.name}`,
  );
  t.is(thrown?.name, "BARE_RUNTIME_BINARY_NOT_FOUND");
  t.ok(
    thrown?.message.includes(`bare-runtime-${FAKE_PLATFORM}-${originalArch}`),
    `expected target package in error message, got: ${thrown?.message}`,
  );
});
