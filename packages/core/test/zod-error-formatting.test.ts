import test from 'brittle'
import { z } from 'zod'
import {
  createErrorResponse,
  loadBuiltinToRequestSchema,
  loadCustomPluginToRequestSchema,
  isBuiltInModelType
} from '../src/schemas'
import { LLAMA_3_2_1B_INST_Q4_0 } from '../src/models/registry'
import { formatZodError } from '../src/utils/zod-error'
import { parseClientInput } from '../src/api/parse-input'
import { validateConfig } from '../src/config/config-utils'
import {
  ConfigValidationFailedError,
  RequestValidationFailedError
} from '../src/utils/errors-client'

// A raw ZodError serialises its `.message` as a JSON array of issues; a friendly
// message does not. Validation errors shown to consumers must never be JSON.
function isJson(value: string): boolean {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

// The message a consumer sees when their input fails client-side validation.
function inputError(schema: typeof loadBuiltinToRequestSchema, value: unknown) {
  try {
    parseClientInput(schema, value)
    return null
  } catch (error) {
    if (error instanceof RequestValidationFailedError) return error.message
    throw error
  }
}

// --- Validation errors are readable strings, never raw ZodError JSON ---

test('formatZodError produces a readable, field-named, non-JSON message', function (t) {
  const schema = z.object({ modelConfig: z.object({ nCtx: z.number() }).strict() })
  const result = schema.safeParse({ modelConfig: { nCtxx: 4096 } })
  if (result.success) return t.fail('expected invalid input')
  const message = formatZodError(result.error)
  t.absent(isJson(message), 'not JSON')
  t.ok(message.includes('modelConfig'), 'names the path')
})

test('createErrorResponse never puts raw ZodError JSON on the wire', function (t) {
  const result = z.object({ modelId: z.string() }).safeParse({ modelId: 1 })
  if (result.success) return t.fail('expected invalid input')
  const envelope = createErrorResponse(result.error)
  t.is(envelope.type, 'error')
  t.is(envelope.message, formatZodError(result.error))
  t.absent(isJson(envelope.message), 'not JSON')
})

test('validateConfig throws a readable ConfigValidationFailedError', function (t) {
  try {
    validateConfig(42)
    t.fail('expected validateConfig to throw')
  } catch (error) {
    t.ok(error instanceof ConfigValidationFailedError)
    t.absent(isJson((error as ConfigValidationFailedError).message), 'not JSON')
  }
})

// --- loadModel: errors name the offending config field ---

test('loadModel: an unknown config key is named', function (t) {
  const message = inputError(loadBuiltinToRequestSchema, {
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: 'llamacpp-completion',
    modelConfig: { ctx_sizee: 4096 }
  })
  t.ok(message?.includes('ctx_sizee'), 'names the field')
  t.ok(message?.includes('modelConfig'), 'points at modelConfig')
})

test('loadModel: a wrong value type is named with its exact path', function (t) {
  const message = inputError(loadBuiltinToRequestSchema, {
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: 'llamacpp-completion',
    modelConfig: { ctx_size: 'big' }
  })
  t.ok(message?.includes('modelConfig.ctx_size'), 'names the exact field')
  t.ok(message?.includes('number'), 'explains the expected type')
})

test('loadModel: field-level for any model type, and through aliases', function (t) {
  const nonLlm = inputError(loadBuiltinToRequestSchema, {
    modelSrc: 'some-model.gguf',
    modelType: 'sdcpp-generation',
    modelConfig: { hieght: 512 }
  })
  t.ok(nonLlm?.includes('hieght'), 'non-LLM model type is field-level')

  const viaAlias = inputError(loadBuiltinToRequestSchema, {
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: 'llm',
    modelConfig: { ctx_sizee: 4096 }
  })
  t.ok(viaAlias?.includes('ctx_sizee'), 'alias resolves to the right branch')
})

test('loadModel: a custom plugin modelType is accepted', function (t) {
  t.absent(isBuiltInModelType('my-custom-plugin'), 'not a built-in type')
  const result = loadCustomPluginToRequestSchema.safeParse({
    modelSrc: 'some-model.gguf',
    modelType: 'my-custom-plugin',
    modelConfig: { anything: 1 }
  })
  t.ok(result.success, 'custom plugin config is accepted')
})

// --- tts: its config is itself discriminated, so errors are field-level too ---

test('tts: an unknown config key is named', function (t) {
  const message = inputError(loadBuiltinToRequestSchema, {
    modelSrc: 'some-model.gguf',
    modelType: 'tts-ggml',
    modelConfig: { ttsEngine: 'chatterbox', language: 'en', voicee: 'x' }
  })
  t.ok(message?.includes('voicee'), 'names the field')
})

test('tts: a wrong value type is named', function (t) {
  const message = inputError(loadBuiltinToRequestSchema, {
    modelSrc: 'some-model.gguf',
    modelType: 'tts-ggml',
    modelConfig: { ttsEngine: 'supertonic', language: 'en', ttsSpeed: 'fast' }
  })
  t.ok(message?.includes('ttsSpeed'), 'names the field')
  t.ok(message?.includes('number'), 'explains the expected type')
})

test('tts: a missing engine points at the ttsEngine discriminator', function (t) {
  const message = inputError(loadBuiltinToRequestSchema, {
    modelSrc: 'some-model.gguf',
    modelType: 'tts-ggml',
    modelConfig: { language: 'en' }
  })
  t.ok(message?.includes('ttsEngine'), 'names the discriminator')
})
