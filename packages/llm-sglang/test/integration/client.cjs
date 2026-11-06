const LlmSglang = require('../..')

async function main() {
  const scenario = Bare.argv[Bare.argv.length - 2]
  const addon = new LlmSglang({
    config: {
      baseUrl: Bare.argv[Bare.argv.length - 1] + '/',
      ...(scenario === 'authenticated' ? { apiKey: 'integration-test-key' } : {})
    }
  })
  const results = []
  await addon.load()
  try {
    const runs = scenario === 'cancel' || scenario === 'sequential' ? 2 : 1
    for (let run = 0; run < runs; run++) {
      const response = addon.run(
        [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hello 🌍\n"quoted" \\ text' }
        ],
        {
          generationParams: {
            temp: 0,
            predict: 8,
            top_p: 0.9,
            top_k: 20,
            seed: 0,
            repeat_penalty: 1.1
          }
        }
      )
      const tokens = []
      let cancellation
      response.onUpdate((token) => {
        tokens.push(token)
        console.log('TOKEN ' + JSON.stringify(token))
        if (scenario === 'cancel' && run === 0 && tokens.length === 1) {
          cancellation = response.cancel()
        }
      })
      try {
        const result = await response.await()
        if (cancellation) await cancellation
        const iterated = []
        for await (const token of response.iterate()) iterated.push(token)
        results.push({ tokens, result, iterated })
      } catch (error) {
        results.push({ tokens, error: error.message })
      }
    }
  } finally {
    await addon.unload()
  }
  console.log('RESULT ' + JSON.stringify(results))
}

main().catch((error) => {
  console.error(error.stack || error)
  Bare.exit(1)
})
