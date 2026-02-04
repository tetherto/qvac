import type {
  QvacModelRegistryListRequest,
  QvacModelRegistryListResponse,
  QvacModelRegistrySearchRequest,
  QvacModelRegistrySearchResponse,
  QvacModelRegistryGetModelRequest,
  QvacModelRegistryGetModelResponse,
  QvacModelRegistryEntry,
  QvacModelRegistryEntryAddon,
} from "@/schemas";
import { send } from "@/client/rpc/rpc-client";
import { QvacModelRegistryQueryFailedError } from "@/utils/errors-client";

export type { QvacModelRegistryEntry, QvacModelRegistryEntryAddon };

export interface QvacModelRegistrySearchParams {
  filter?: string;
  engine?: string;
  quantization?: string;
  modelType?: QvacModelRegistryEntryAddon;
  addon?: QvacModelRegistryEntryAddon;
}

async function qvacModelRegistryList(): Promise<QvacModelRegistryEntry[]> {
  const request: QvacModelRegistryListRequest = {
    type: "qvacModelRegistryList",
  };

  const response = (await send(request)) as QvacModelRegistryListResponse;

  if (!response.success || !response.models) {
    throw new QvacModelRegistryQueryFailedError(response.error);
  }

  return response.models;
}

async function qvacModelRegistrySearch(
  params: QvacModelRegistrySearchParams = {},
): Promise<QvacModelRegistryEntry[]> {
  const { modelType, ...rest } = params;
  const request: QvacModelRegistrySearchRequest = {
    type: "qvacModelRegistrySearch",
    ...rest,
    addon: modelType ?? rest.addon,
  };

  const response = (await send(request)) as QvacModelRegistrySearchResponse;

  if (!response.success || !response.models) {
    throw new QvacModelRegistryQueryFailedError(response.error);
  }

  return response.models;
}

async function qvacModelRegistryFindByEngine(
  engine: string,
): Promise<QvacModelRegistryEntry[]> {
  return qvacModelRegistrySearch({ engine });
}

async function qvacModelRegistryFindByName(
  name: string,
): Promise<QvacModelRegistryEntry[]> {
  return qvacModelRegistrySearch({ filter: name });
}

async function qvacModelRegistryFindByQuantization(
  quantization: string,
): Promise<QvacModelRegistryEntry[]> {
  return qvacModelRegistrySearch({ quantization });
}

async function qvacModelRegistryFindByModelType(
  modelType: QvacModelRegistryEntryAddon,
): Promise<QvacModelRegistryEntry[]> {
  return qvacModelRegistrySearch({ addon: modelType });
}

async function qvacModelRegistryGetModel(
  registryPath: string,
  registrySource: string,
): Promise<QvacModelRegistryEntry> {
  const request: QvacModelRegistryGetModelRequest = {
    type: "qvacModelRegistryGetModel",
    registryPath,
    registrySource,
  };

  const response = (await send(request)) as QvacModelRegistryGetModelResponse;

  if (!response.success || !response.model) {
    throw new QvacModelRegistryQueryFailedError(
      response.error ?? `Model not found: ${registrySource}/${registryPath}`,
    );
  }

  return response.model;
}

export {
  qvacModelRegistryList,
  qvacModelRegistrySearch,
  qvacModelRegistryFindByEngine,
  qvacModelRegistryFindByName,
  qvacModelRegistryFindByQuantization,
  qvacModelRegistryFindByModelType,
  qvacModelRegistryGetModel,
};
