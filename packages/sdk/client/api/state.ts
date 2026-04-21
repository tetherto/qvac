import { send } from "@/client/rpc/rpc-client";
import type { LifecycleState } from "@/schemas";
import { InvalidResponseError } from "@/utils/errors-client";

export async function state(): Promise<LifecycleState> {
  const response = await send({ type: "state" });
  if (response.type !== "state") {
    throw new InvalidResponseError("state");
  }
  return response.state;
}
