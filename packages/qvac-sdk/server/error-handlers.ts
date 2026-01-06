import type RPC from "bare-rpc";
import { createErrorResponse, responseSchema } from "@/schemas";

export function sendErrorResponse(req: RPC.IncomingRequest, error: unknown) {
  try {
    const errorResponse = createErrorResponse(error);

    const responseData = JSON.stringify(responseSchema.parse(errorResponse));
    req.reply(responseData, "utf-8");
  } catch (responseError) {
    console.error("Failed to create error response:", responseError);
    const fallbackError = createErrorResponse(
      new Error("Internal server error"),
    );
    req.reply(JSON.stringify(fallbackError), "utf-8");
  }
}
export function sendStreamErrorResponse(
  stream: ReturnType<RPC.IncomingRequest["createResponseStream"]>,
  error: unknown,
) {
  try {
    const errorResponse = createErrorResponse(error);

    const responseData = JSON.stringify(responseSchema.parse(errorResponse));
    stream.write(responseData + "\n", "utf-8");
    stream.end();
  } catch (responseError) {
    console.error("Failed to create stream error response:", responseError);
    const fallbackError = createErrorResponse(
      new Error("Internal server error"),
    );
    stream.write(JSON.stringify(fallbackError) + "\n", "utf-8");
    stream.end();
  }
}
