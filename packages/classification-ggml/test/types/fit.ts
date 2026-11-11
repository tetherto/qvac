import {
  assessFit,
  type ClassificationFitDevice,
  type ClassificationFitRequest,
  type ClassificationFitResult,
  type ClassificationFitStatus,
} from "../../index";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

export type Result = Assert<Equal<ReturnType<typeof assessFit>, Promise<ClassificationFitResult>>>;
export type Request = Assert<Equal<Parameters<typeof assessFit>[0], ClassificationFitRequest>>;
export type Status = Assert<Equal<ClassificationFitStatus, "fits" | "does-not-fit" | "unknown">>;
export type Rows = Assert<Equal<ClassificationFitResult["devices"], ClassificationFitDevice[]>>;
export type Stats = Assert<Equal<ClassificationFitResult["stats"], Record<string, never>>>;

export const request: ClassificationFitRequest = {
  modelPath: "/models/bridgedepth.gguf",
  backend: "CPU",
  threads: 4,
  marginBytes: 0,
  workload: { width: 1280, height: 720 },
};
