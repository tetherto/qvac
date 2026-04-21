import { type GetModelInfoRequest, type GetModelInfoParams } from "@/schemas";
import { send } from "@/client/rpc/rpc-client";
import { InvalidResponseError } from "@/utils/errors-client";

export async function getModelInfo(params: GetModelInfoParams) {
  const request: GetModelInfoRequest = {
    type: "getModelInfo",
    name: params.name,
  };

  const response = await send(request);
  if (response.type !== "getModelInfo") {
    throw new InvalidResponseError("getModelInfo");
  }

  return response.modelInfo;
}
