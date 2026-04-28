import test from "brittle";
import {
  registerModel,
  unregisterModel,
} from "@/server/bare/registry/model-registry";
import { handleGetLoadedModelInfo } from "@/server/rpc/handlers/get-loaded-model-info";
import { ModelNotFoundError } from "@/utils/errors-server";
import { SDK_SERVER_ERROR_CODES } from "@/schemas";

let idCounter = 0;
function makeId(prefix: string) {
  idCounter++;
  return `${prefix}-${idCounter}`;
}

test("getLoadedModelInfo: delegated entry returns providerInfo + empty handlers", function (t) {
  const modelId = makeId("delegated-loaded-info");
  const topic = "test-topic-deadbeef";
  const providerPublicKey = "test-provider-public-key-deadbeef";

  registerModel(modelId, { topic, providerPublicKey });

  try {
    const response = handleGetLoadedModelInfo({
      type: "getLoadedModelInfo",
      modelId,
    });

    t.is(response.type, "getLoadedModelInfo");
    t.is(response.info.modelId, modelId);
    t.is(response.info.isDelegated, true);

    if (!response.info.isDelegated) {
      t.fail("Expected delegated branch");
      return;
    }

    t.alike(response.info.handlers, []);
    t.is(response.info.providerInfo.topic, topic);
    t.is(response.info.providerInfo.providerPublicKey, providerPublicKey);
  } finally {
    unregisterModel(modelId);
  }
});

test("getLoadedModelInfo: unknown modelId throws ModelNotFoundError", function (t) {
  const modelId = makeId("nonexistent-loaded-info");

  try {
    handleGetLoadedModelInfo({ type: "getLoadedModelInfo", modelId });
    t.fail("Expected handleGetLoadedModelInfo to throw");
  } catch (error) {
    t.ok(error instanceof ModelNotFoundError);
    t.is(
      (error as ModelNotFoundError).code,
      SDK_SERVER_ERROR_CODES.MODEL_NOT_FOUND,
    );
  }
});
