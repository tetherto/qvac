'use strict'

const test = require('brittle')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isWindowsX64 = os.platform() === 'win32' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const useCpu = isLinuxArm64

const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

async function setupReasoningModel (t, toolsEnabled) {
  const [modelName, dirPath] = await ensureModel({
    modelName: MODEL.name,
    downloadUrl: MODEL.url
  })

  const loader = new FilesystemDL({ dirPath })
  const specLogger = attachSpecLogger({ forwardToConsole: true })

  const config = {
    ctx_size: '4096',
    seed: '50',
    gpu_layers: '999',
    temp: '0.8',
    top_p: '0.9',
    device: useCpu ? 'cpu' : 'gpu',
    verbosity: '2',
    tools: toolsEnabled ? 'true' : 'false'
  }

  const inference = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    projectionPath: '',
    opts: { stats: true }
  }, config)

  await inference.load()

  t.teardown(async () => {
    try {
      specLogger.release()
      if (loader) await loader.close()
      if (inference) await inference.unload()
    } catch (err) {
      // Ignore cleanup errors
    }
  })

  return { inference, loader }
}

// Shared helper: Run a completion and collect response
async function runCompletion (inference, messages) {
  const result = await inference.run(messages)
  let response = ''
  await result
    .onUpdate(token => {
      response += token
    })
    .await()
  return response
}

// Shared helper: Verify reasoning tags in response
function verifyReasoningTags (t, response, testName) {
  // Qwen3 models use <think> tags in output
  const hasOpeningTag = response.includes('<think>')
  const hasClosingTag = response.includes('</think>')
  t.ok(hasOpeningTag,
    `${testName} should contain opening reasoning tag`)
  t.ok(hasClosingTag,
    `${testName} should contain closing reasoning tag`)
  t.ok(response.length > 100,
    `${testName} should generate substantial output`)
}

// Shared helper: Verify generation continued after reasoning
function verifyContinuedAfterReasoning (t, response, testName) {
  const thinkCloseIndex = response.indexOf('</think>')
  if (thinkCloseIndex === -1) {
    t.fail(`No </think> tag found in ${testName}`)
    return false
  }

  const textAfterThink = response.substring(thinkCloseIndex + '</think>'.length).trim()
  t.ok(textAfterThink.length > 0,
    `Generation should continue after </think> tag (${testName})`)
  return textAfterThink.length > 0
}

// Shared helper: Create initial messages for reasoning test
function createInitialMessages () {
  return [
    {
      role: 'system',
      content: 'You are an AI assistant. Always provide a clear answer after thinking'
    },
    {
      role: 'user',
      content: 'what are you thinking'
    }
  ]
}

// Shared helper: Create follow-up messages
function createFollowUpMessages (initialMessages, previousResponse) {
  return [
    ...initialMessages,
    {
      role: 'assistant',
      content: previousResponse
    },
    {
      role: 'user',
      content: 'what is new'
    }
  ]
}
test('reasoning tag EOS replacement works with tools=false', {
  skip: isDarwinX64 || isWindowsX64, // TODO: unskip isWindowsX64 once we have GPU, takes too long
  timeout: 600_000
}, async t => {
  const { inference } = await setupReasoningModel(t, false)

  // First completion - should work correctly
  const messages1 = createInitialMessages()
  const response1 = await runCompletion(inference, messages1)
  verifyReasoningTags(t, response1, 'First completion')

  // Second completion - this is where the fix should activate
  const messages2 = createFollowUpMessages(messages1, response1)
  const response2 = await runCompletion(inference, messages2)

  verifyReasoningTags(t, response2, 'Second completion')

  // Verify the fix worked: generation continued after reasoning
  verifyContinuedAfterReasoning(t, response2, 'tools=false')
  t.comment(`Second completion output length: ${response2.length}`)
})

test('reasoning tag EOS replacement works with tools=true', {
  skip: isDarwinX64 || isWindowsX64, // TODO: unskip isWindowsX64 once we have GPU, takes too long
  timeout: 600_000
}, async t => {
  const { inference } = await setupReasoningModel(t, true)

  // First completion - should work correctly
  const messages1 = createInitialMessages()
  const response1 = await runCompletion(inference, messages1)
  verifyReasoningTags(t, response1, 'First completion (tools=true)')

  // Second completion - this is where the fix should activate
  const messages2 = createFollowUpMessages(messages1, response1)
  const response2 = await runCompletion(inference, messages2)

  verifyReasoningTags(t, response2, 'Second completion (tools=true)')

  // Verify the fix worked: generation continued after reasoning
  verifyContinuedAfterReasoning(t, response2, 'tools=true')
  t.comment(`Second completion output length: ${response2.length}`)
})
