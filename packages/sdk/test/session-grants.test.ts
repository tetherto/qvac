import test from 'brittle'

// Real worker with the default plugin set. A session opened with a grant runs
// only the operations the grant names; the worker refuses the rest before any
// model work, so the calls below name a model that is never loaded.

test('a session with a grant is refused operations outside it', async function (t) {
  t.timeout(30_000)

  delete process.env['QVAC_WORKER_PATH']

  const { openSession } = await import('@/client/session')
  const { close } = await import('@/client/rpc/rpc-client')
  const { resetSessionRegistry } = await import('@/client/session-registry')
  const { CapabilityNotGrantedError } = await import('@/utils/errors-server')

  t.teardown(async () => {
    resetSessionRegistry()
    await close()
  })

  const session = openSession({ name: 'grants', grant: ['transcription/transcribe'] })
  await session.opened
  t.alike(session.grant, ['transcription/transcribe'])

  const capabilities = await session.getRuntimeCapabilities()
  t.ok(capabilities.length > 1, 'the capability report is not filtered by the grant')

  let refused: unknown
  try {
    await session.loadModel({ modelSrc: '/no/such/model.gguf', modelType: 'llamacpp-completion' })
  } catch (error) {
    refused = error
  }
  t.ok(refused instanceof CapabilityNotGrantedError, 'loadModel needs runtime/loadModel')
  t.is((refused as InstanceType<typeof CapabilityNotGrantedError>).required, 'runtime/loadModel')
  t.is((refused as InstanceType<typeof CapabilityNotGrantedError>).sessionId, session.sessionId)

  refused = undefined
  try {
    await session.embed({ modelId: 'never-loaded', text: 'hello' })
  } catch (error) {
    refused = error
  }
  t.ok(refused instanceof CapabilityNotGrantedError, 'embed is outside the grant')
  t.is((refused as InstanceType<typeof CapabilityNotGrantedError>).required, 'embedding/embed')

  await session.close()
})

test('openSession fails for a permission the worker does not have', async function (t) {
  t.timeout(30_000)

  delete process.env['QVAC_WORKER_PATH']

  const { openSession } = await import('@/client/session')
  const { close } = await import('@/client/rpc/rpc-client')
  const { resetSessionRegistry } = await import('@/client/session-registry')
  const { SessionGrantInvalidError } = await import('@/utils/errors-server')

  t.teardown(async () => {
    resetSessionRegistry()
    await close()
  })

  const session = openSession({ grant: ['transcription/teleport'] })
  let error: unknown
  try {
    await session.opened
  } catch (caught) {
    error = caught
  }
  t.ok(error instanceof SessionGrantInvalidError)
  t.is(
    (error as InstanceType<typeof SessionGrantInvalidError>).permission,
    'transcription/teleport'
  )
})
