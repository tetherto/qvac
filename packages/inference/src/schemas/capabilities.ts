import { z } from 'zod'
import { sessionScopedRequestSchema } from '@/schemas/request-base'

// One segment of a capability ID: lowercase words joined by hyphens.
const CAPABILITY_ID_SEGMENT = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*'

/** IDs QVAC defines. They never contain a dot. */
export const QVAC_CAPABILITY_ID_PATTERN = new RegExp(`^${CAPABILITY_ID_SEGMENT}$`)

/**
 * Every valid capability ID. A contract QVAC does not define is named with a
 * dotted ID such as `acme.diarization`, so it can never collide with a QVAC ID.
 */
export const CAPABILITY_ID_PATTERN = new RegExp(
  `^${CAPABILITY_ID_SEGMENT}(?:\\.${CAPABILITY_ID_SEGMENT})*$`
)

/**
 * A capability contract: a semantic ID, its major version, and the operations
 * (handler names) a provider serves. A provider implements every operation in
 * `operations` and may implement any in `optionalOperations`.
 *
 * The major changes only on an incompatible change to an operation's schema
 * or behaviour, so a consumer that requires `id@version` matches only that
 * exact pair. Adding an optional operation keeps the major.
 */
export interface CapabilityContract {
  readonly id: string
  readonly version: number
  readonly operations: readonly string[]
  readonly optionalOperations: readonly string[]
}

/**
 * A contract a plugin declares in `QvacPlugin.provides`.
 *
 * For a QVAC ID the runtime takes the operations from its own
 * `CAPABILITY_CONTRACTS` entry and ignores any lists given here, so a plugin
 * built against an earlier table keeps registering after QVAC adds an optional
 * operation. Pass the `CAPABILITY_CONTRACTS` entry itself.
 *
 * A dotted ID names a contract the plugin defines, so `operations` is
 * required. Providers of one dotted ID and major must list the same required
 * operations; their optional operations may differ.
 */
export interface CapabilityDeclaration {
  readonly id: string
  readonly version: number
  readonly operations?: readonly string[] | undefined
  readonly optionalOperations?: readonly string[] | undefined
}

function contract(
  id: string,
  operations: readonly string[],
  optionalOperations: readonly string[] = []
): CapabilityContract {
  return Object.freeze({
    id,
    version: 1,
    operations: Object.freeze([...operations]),
    optionalOperations: Object.freeze([...optionalOperations])
  })
}

/**
 * The contracts QVAC defines. Operations share a contract only when their
 * schemas share a core, so a change to one schema family does not bump the
 * major of an unrelated one. Tool calling, thinking, input types and model
 * modes are features of a contract, not contracts of their own.
 *
 * A plugin names the contracts it provides in `QvacPlugin.provides` by
 * referencing these entries.
 */
export const CAPABILITY_CONTRACTS = Object.freeze({
  completion: contract('completion', ['completionStream'], ['batchCompletionStream', 'calcTokens']),
  fineTuning: contract('fine-tuning', ['finetune']),
  translation: contract('translation', ['translate']),
  embedding: contract('embedding', ['embed', 'embedBatch']),
  reranking: contract('reranking', ['rerank']),
  decision: contract('decision', ['decide']),
  classification: contract('classification', ['classify']),
  transcription: contract('transcription', ['transcribe'], ['transcribeStream']),
  bciTranscription: contract('bci-transcription', ['bciTranscribe'], ['bciTranscribeStream']),
  textToSpeech: contract('text-to-speech', ['textToSpeech'], ['textToSpeechStream']),
  ocr: contract('ocr', ['ocrStream']),
  imageGeneration: contract('image-generation', ['diffusionStream']),
  imageUpscaling: contract('image-upscaling', ['upscaleStream']),
  videoGeneration: contract('video-generation', ['videoStream']),
  worldSimulation: contract('world-simulation', ['worldStepStream', 'worldSceneStream']),
  audioGeneration: contract('audio-generation', ['audioGenStream'], ['audioEditStream']),
  audioUnderstanding: contract('audio-understanding', ['audioUnderstand']),
  visionLanguageAction: contract('vision-language-action', [
    'vlaRun',
    'vlaHparams',
    'vlaSetEmbodiment'
  ])
} satisfies Record<string, CapabilityContract>)

/** The QVAC contract with this ID and major, if QVAC defines one. */
export function findQvacCapabilityContract(
  id: string,
  version: number
): CapabilityContract | undefined {
  return Object.values(CAPABILITY_CONTRACTS).find(
    (entry) => entry.id === id && entry.version === version
  )
}

const operationNameSchema = z.string().min(1, 'operation names must be non-empty strings')

export const capabilityContractRuntimeSchema = z.object({
  id: z
    .string({ error: 'capability id must be a string' })
    .regex(
      CAPABILITY_ID_PATTERN,
      'capability id must be lowercase words joined by hyphens, with dots between namespaces'
    ),
  version: z
    .number({ error: 'capability version must be a number' })
    .int('capability version must be an integer')
    .min(1, 'capability version must be at least 1'),
  operations: z
    .array(operationNameSchema)
    .min(1, 'a capability contract needs at least one required operation')
    .optional(),
  optionalOperations: z.array(operationNameSchema).optional()
})

export const runtimeCapabilitySchema = z.object({
  id: z
    .string()
    .describe(
      'Capability contract ID, such as `transcription`. IDs without a dot are defined by QVAC; ' +
        'a dotted ID names a contract a third-party plugin defines.'
    ),
  version: z
    .number()
    .int()
    .min(1)
    .describe(
      'Major version of the contract. A consumer that requires `id@version` matches only this exact pair. ' +
        'An entry means a registered plugin declares this major; when two majors of one ID are listed, ' +
        'a call reaches whichever one the plugin of the selected model serves.'
    ),
  operations: z
    .array(z.string())
    .describe(
      "Operations every registered provider of this contract implements. Always includes the contract's required operations."
    ),
  partialOperations: z
    .array(z.string())
    .describe(
      'Optional operations that only some registered providers implement. A call uses the plugin of the selected model, so it fails when that plugin lacks the operation.'
    )
})

export const getRuntimeCapabilitiesRequestSchema = z
  .object({
    type: z.literal('getRuntimeCapabilities')
  })
  .extend(sessionScopedRequestSchema.shape)

export const getRuntimeCapabilitiesResponseSchema = z.object({
  type: z.literal('getRuntimeCapabilities'),
  capabilities: z
    .array(runtimeCapabilitySchema)
    .describe(
      'Capability contracts the registered plugins declare, sorted by ID and then version. ' +
        'Built from plugin registration only: it does not load models or check addons, model files, resources or permissions. ' +
        'An empty list means no registered plugin declares a contract.'
    )
})

export type RuntimeCapability = z.infer<typeof runtimeCapabilitySchema>
export type GetRuntimeCapabilitiesRequest = z.infer<typeof getRuntimeCapabilitiesRequestSchema>
export type GetRuntimeCapabilitiesResponse = z.infer<typeof getRuntimeCapabilitiesResponseSchema>
