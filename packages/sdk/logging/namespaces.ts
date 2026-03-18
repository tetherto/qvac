import { type CanonicalModelType } from "@/schemas/model-types";

export const RAG_NAMESPACE = "rag:hyperdb" as const;

export type AddonNamespace = CanonicalModelType | typeof RAG_NAMESPACE;

// Reserved ID for SDK server logs
export const SDK_LOG_ID = "__sdk__";

// Namespace for all SDK server logs
export const SDK_SERVER_NAMESPACE = "sdk:server";
