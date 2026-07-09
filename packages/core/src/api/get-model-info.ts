import {
  getModelInfoParamsSchema,
  type GetModelInfoRequest,
  type GetModelInfoParams
} from '../schemas'
import { send } from '../dispatch'
import { InvalidResponseError } from '../errors'
import { parseClientInput } from './parse-input'

/**
 * Returns status information for a catalog model, including cache state and loaded instances.
 *
 * @param params - Query parameters.
 * @param params.name - The model's registry name (as found in QVAC's built-in catalog) to look up.
 * @returns A promise resolving to the model's status information (cache presence, loaded instances, size on disk, etc.).
 * @throws {QvacErrorBase} When the response type is invalid (`InvalidResponseError`) or the RPC layer fails.
 */
export async function getModelInfo(params: GetModelInfoParams) {
  const parsed = parseClientInput(getModelInfoParamsSchema, params)
  const request: GetModelInfoRequest = {
    type: 'getModelInfo',
    name: parsed.name
  }

  const response = await send(request)
  if (response.type !== 'getModelInfo') {
    throw new InvalidResponseError('getModelInfo')
  }

  return response.modelInfo
}
