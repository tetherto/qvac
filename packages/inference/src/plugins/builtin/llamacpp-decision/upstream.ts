import { ModelLoadFailedError, RequestValidationFailedError } from '@/errors/index'
import type {
  DecisionAnswer,
  DecisionQuestion,
  DecisionResult,
  DecisionState
} from '@/schemas/index'
import { readGgufArchitecture } from '@/utils/gguf-architecture'

// Decision models (QVAC-26667): upstream llama.cpp decision models, Laya
// included, run on @qvac/decision-ggml's DecisionEngine. decision-ggml is
// loaded when a model loads, never at import: without it this module still
// imports, and a load fails with an actionable error. The boundary types live
// here rather than being imported from the addon.
//
// It is not yet declared in package.json. It is unpublished, and with
// linkWorkspacePackages any declared range (even an optional peer) links the
// workspace copy, whose @qvac/fabric is the unbuilt workspace one: Bare then
// fails to link this module in the inference checks. Declare it as an optional
// peer, like the other addons, once it is published.

/** The engine's capabilities, as DecisionEngine.info() reports them. */
export interface UpstreamDecisionInfo {
  decision_type: string
  noul: 'probability' | 'expected_rating'
  joint: boolean
  shared_prefix: boolean
  images: boolean
  audio: boolean
  score_levels: { min: number; max: number }
  max_json_depth: number
  n_ctx: number
  model: string
}

type UpstreamPayload = DecisionState | null

/** Upstream's /v1/systemone request for one state. */
export interface UpstreamRequest {
  state: DecisionState
  questions: Record<
    string,
    | { type: 'choice'; instructions: DecisionState; criteria: Record<string, UpstreamPayload> }
    | { type: 'score'; instructions: DecisionState; criteria: DecisionState[] }
    | {
        type: 'noul'
        instructions: DecisionState
        criteria?: { true?: UpstreamPayload; false?: UpstreamPayload }
      }
  >
}

type UpstreamAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: 'score'
      score: number
      legend: Record<string, unknown>
      probabilities: Record<string, number>
      confidence: number
    }
  | { type: 'noul'; noul: number; confidence?: number }

/** Upstream's /v1/systemone response for one state. */
export interface UpstreamResult {
  model: string
  answers: Record<string, UpstreamAnswer>
  usage: { input_tokens: number; output_tokens: number }
}

/** `code` of a DecisionEngine run error for a request the model rejected. */
export const DECISION_INVALID_REQUEST = 'DECISION_INVALID_REQUEST'

interface ResponseLike<T> {
  await(): Promise<T[]>
}

interface UpstreamEngine {
  load(): Promise<void>
  unload(): Promise<void>
  cancel(): Promise<void>
  run(request: UpstreamRequest): Promise<ResponseLike<UpstreamResult>>
  info(): UpstreamDecisionInfo
}

export type UpstreamEngineConstructor = new (args: {
  files: { model: string[] }
  config: Record<string, unknown>
  logger?: unknown
}) => UpstreamEngine

/** What DecisionModel uses from @qvac/decision-ggml. */
export interface DecisionAddon {
  DecisionEngine: UpstreamEngineConstructor
}

const DECISION_ADDON = '@qvac/decision-ggml'

export function isMissingDecisionAddon(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
  return (
    (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') &&
    typeof message === 'string' &&
    message.includes(DECISION_ADDON)
  )
}

/**
 * @qvac/decision-ggml, or undefined when it is not installed. Any other load
 * failure (a broken install, a missing native prebuild) is thrown.
 */
export async function loadDecisionAddon(): Promise<DecisionAddon | undefined> {
  try {
    return (await import('@qvac/decision-ggml')) as unknown as DecisionAddon
  } catch (error) {
    if (isMissingDecisionAddon(error)) return undefined
    throw error
  }
}

function missingAddonError(): ModelLoadFailedError {
  return new ModelLoadFailedError(
    `decision models run on ${DECISION_ADDON}; install it to load one`
  )
}

/**
 * decision-ggml's native logging module, which the plugin registry wires before
 * a decision model loads. Without decision-ggml the load fails here, with an
 * actionable error; any other load failure is thrown as is.
 */
export async function loadDecisionAddonLogging(): Promise<unknown> {
  try {
    return await import('@qvac/decision-ggml/addonLogging')
  } catch (error) {
    if (isMissingDecisionAddon(error)) throw missingAddonError()
    throw error
  }
}

/** DecisionEngine's load options, from the validated plugin config. */
export function toUpstreamConfig(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, key === 'device' ? value : String(value)])
  )
}

interface DecisionModelOptions {
  modelPath: string
  files: string[]
  /** The validated plugin config. */
  config: Record<string, unknown>
  logger?: unknown
  /** Loads @qvac/decision-ggml; loadDecisionAddon by default (tests stub it). */
  loadAddon?: (() => Promise<DecisionAddon | undefined>) | undefined
}

/**
 * A decision model on decision-ggml's DecisionEngine. A GGUF without upstream
 * decision metadata fails to load; a fabric-format Laya file
 * (`general.architecture` "laya") gets an error that names the conversion.
 */
export class DecisionModel {
  info: UpstreamDecisionInfo | undefined
  private inner: UpstreamEngine | undefined
  private readonly options: DecisionModelOptions

  constructor(options: DecisionModelOptions) {
    this.options = options
  }

  async load(): Promise<void> {
    if (this.inner) return
    if ((await readGgufArchitecture(this.options.modelPath)) === 'laya') {
      throw new ModelLoadFailedError(
        "this is a fabric-format Laya file (general.architecture 'laya'), which decision models no longer load; use the upstream-format conversion of its Hugging Face checkpoint (convert_hf_to_gguf.py)"
      )
    }
    const addon = await (this.options.loadAddon ?? loadDecisionAddon)()
    if (!addon) throw missingAddonError()
    const engine = new addon.DecisionEngine({
      files: { model: this.options.files },
      config: toUpstreamConfig(this.options.config),
      logger: this.options.logger
    })
    await engine.load()
    this.inner = engine
    this.info = engine.info()
  }

  /** The loaded engine. */
  get engine(): UpstreamEngine {
    if (!this.inner) throw new Error('the decision model is not loaded')
    return this.inner
  }

  async cancel(): Promise<void> {
    await this.inner?.cancel()
  }

  async unload(): Promise<void> {
    const inner = this.inner
    this.inner = undefined
    this.info = undefined
    await inner?.unload()
  }
}

// ---------------------------------------------------------------------------
// Request and result conversion.
// ---------------------------------------------------------------------------

/**
 * Per choice-array question: upstream option key → the caller's value. A Map,
 * not an object: question names are caller-chosen (`toString`, `constructor`).
 */
export type ChoiceKeyMaps = Map<string, Map<string, string | number | boolean>>

function reject(message: string): never {
  throw new RequestValidationFailedError(message)
}

function convertQuestion(
  id: string,
  question: DecisionQuestion,
  info: UpstreamDecisionInfo,
  keyMaps: ChoiceKeyMaps
): UpstreamRequest['questions'][string] {
  if (question.type === 'choice') {
    if (Array.isArray(question.criteria)) {
      const keys = new Map<string, string | number | boolean>()
      for (const value of question.criteria) {
        const key = String(value)
        if (keys.has(key)) {
          const other = keys.get(key)
          reject(
            other === value
              ? `questions.${id}: duplicate option ${JSON.stringify(value)}`
              : `questions.${id}: options ${JSON.stringify(other)} and ${JSON.stringify(value)} are the same as text; use a criteria object with distinct keys`
          )
        }
        keys.set(key, value)
      }
      keyMaps.set(id, keys)
      return {
        type: 'choice',
        instructions: question.instructions,
        criteria: Object.fromEntries([...keys.keys()].map((key) => [key, null]))
      }
    }
    return { type: 'choice', instructions: question.instructions, criteria: question.criteria }
  }
  if (question.type === 'score') {
    const { min, max } = info.score_levels
    if (question.criteria.length < min || question.criteria.length > max) {
      reject(
        `questions.${id}: score criteria must have ${min} to ${max} levels, got ${question.criteria.length}`
      )
    }
    return { type: 'score', instructions: question.instructions, criteria: question.criteria }
  }
  if (question.requireProbability === true && info.noul !== 'probability') {
    reject(
      `questions.${id}: this ${info.decision_type} model answers noul with an ${info.noul.replace('_', ' ')}, not a probability`
    )
  }
  const criteria = question.criteria
  return {
    type: 'noul',
    instructions: question.instructions,
    ...(criteria === undefined || criteria === null
      ? {}
      : {
          criteria: {
            ...(criteria.true === undefined ? {} : { true: criteria.true }),
            ...(criteria.false === undefined ? {} : { false: criteria.false })
          }
        })
  }
}

/** Builds upstream's request for one state, and the keys to map answers back. */
export function toUpstreamRequest(
  request: { questions: Record<string, DecisionQuestion> },
  state: DecisionState,
  info: UpstreamDecisionInfo
): { body: UpstreamRequest; keyMaps: ChoiceKeyMaps } {
  const keyMaps: ChoiceKeyMaps = new Map()
  const questions = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => [
      id,
      convertQuestion(id, question, info, keyMaps)
    ])
  )
  return { body: { state, questions }, keyMaps }
}

// Object keys sorted, recursively: upstream's canonical legend form.
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])])
          )
        : v
  return JSON.stringify(sort(value))
}

function convertAnswer(id: string, answer: UpstreamAnswer, keyMaps: ChoiceKeyMaps): DecisionAnswer {
  if (answer.type === 'choice') {
    const keys = keyMaps.get(id)
    let choice: string | number | boolean = answer.choice
    if (keys) {
      const value = keys.get(answer.choice)
      if (value === undefined) {
        throw new Error(`questions.${id}: the model chose an unknown option '${answer.choice}'`)
      }
      choice = value
    }
    return {
      type: 'choice',
      choice,
      probabilities: answer.probabilities,
      confidence: answer.confidence
    }
  }
  if (answer.type === 'score') {
    const legend: Record<string, string> = {}
    for (const [level, description] of Object.entries(answer.legend)) {
      if (description === null || description === undefined) continue
      legend[level] = typeof description === 'string' ? description : canonicalJson(description)
    }
    return {
      type: 'score',
      score: answer.score,
      legend,
      probabilities: answer.probabilities,
      confidence: answer.confidence
    }
  }
  return {
    type: 'noul',
    noul: answer.noul,
    ...(answer.confidence === undefined ? {} : { confidence: answer.confidence })
  }
}

/** Maps upstream's result for one state to the SDK result. */
export function fromUpstreamResult(result: UpstreamResult, keyMaps: ChoiceKeyMaps): DecisionResult {
  return {
    model: result.model,
    answers: Object.fromEntries(
      Object.entries(result.answers).map(([id, answer]) => [id, convertAnswer(id, answer, keyMaps)])
    ),
    usage: {
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens
    }
  }
}

/** True for a DecisionEngine run error that rejected the request. */
export function isInvalidRequestError(error: unknown): error is Error {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === DECISION_INVALID_REQUEST
  )
}
