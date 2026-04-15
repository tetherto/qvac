import type { ResumeResponse } from "@/schemas";
import { resumeRuntime } from "@/server/bare/runtime-lifecycle";
import { LifecycleResumeFailedError } from "@/utils/errors-server";

export async function handleResume(): Promise<ResumeResponse> {
  try {
    await resumeRuntime();
    return { type: "resume" };
  } catch (error) {
    throw new LifecycleResumeFailedError(
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}
