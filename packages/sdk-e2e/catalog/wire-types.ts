// The shapes the catalog shares with the SDK wire contract
// (packages/sdk/contract/schema.json), declared here rather than imported from a
// client so the catalog compiles without one. Two checks keep them in step with the
// SDK: `check:contract` compares the value lists and the decision params with the
// contract, and each JS executor that hands them to the SDK is type-checked against
// the SDK's own types.

/** The contract's `toolDialect` enum. */
export const TOOL_DIALECTS = [
  'hermes',
  'pythonic',
  'json',
  'harmony',
  'qwen35',
  'gemma4',
  'dsml'
] as const
export type ToolDialect = (typeof TOOL_DIALECTS)[number]

/** The contract's `constants.VectorIndexStorage`. */
export const VECTOR_INDEX_STORAGES = ['f32', 'q8', 'q4', 'turbovec-q4', 'turbovec-q2'] as const
export type VectorIndexStorage = (typeof VECTOR_INDEX_STORAGES)[number]

/** A decision state, question instruction or criterion: any JSON value. */
export type DecisionState = string | number | boolean | Record<string, unknown> | unknown[]

interface DecisionQuestionBase {
  instructions: DecisionState
  optionOrder?: number[]
}

export type DecisionQuestion =
  | (DecisionQuestionBase & {
      type: 'choice'
      criteria: (string | number | boolean)[] | Record<string, DecisionState | null>
    })
  | (DecisionQuestionBase & { type: 'score'; criteria: DecisionState[] })
  | (DecisionQuestionBase & {
      type: 'noul'
      criteria?: { true?: DecisionState | null; false?: DecisionState | null } | null
      labels?: { false: string; true: string }
    })

interface DecisionFields {
  questions: Record<string, DecisionQuestion>
  maxLen?: number
  headMaxLen?: number
}

/** `decide.request` for one state, without the `modelId` a client adds. */
export type DecisionSingleRequest = DecisionFields & { state: DecisionState }

/** `decide.request` for a batch of states, without the `modelId` a client adds. */
export type DecisionBatchRequest = DecisionFields & { states: DecisionState[] }

interface DecisionAnswerBase {
  answerConfidence: number
  confidence: number
  action: { actProbability: number }
}

export type DecisionAnswer =
  | (DecisionAnswerBase & {
      type: 'choice'
      choice: string | number | boolean
      probabilities: Record<string, number>
    })
  | (DecisionAnswerBase & {
      type: 'score'
      score: number
      legend: Record<string, string>
      probabilities: Record<string, number>
    })
  | (DecisionAnswerBase & { type: 'noul'; noul: number })

/** One result of `decide.response`. */
export interface DecisionResult {
  model: string
  answers: Record<string, DecisionAnswer>
  usage: {
    inputTokens: number
    outputTokens: number
    stateTokens: number
    stateTokensDropped: number
    truncated: boolean
    truncatedQuestions: string[]
    options?: Record<string, { total: number; distinct: number; tokensPerOption: number | null }>
  }
}
