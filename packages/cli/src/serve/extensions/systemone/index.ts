import type { ServeExtension } from '@/serve/core/extensions'
import routes from '@/serve/extensions/systemone/routes'
import { createSystemOneState, type SystemOneOptions } from '@/serve/extensions/systemone/state'

const systemoneExtension: ServeExtension = {
  name: 'systemone',
  description: 'System One decision API',
  tags: { Decision: 'Typed decisions with confidence and probability values.' },
  errorCodes: { state: 'invalid_state', questions: 'invalid_questions' },
  // lunte-disable-next-line require-await
  setup: async (_ctx, options) => createSystemOneState(options as SystemOneOptions | undefined),
  register: async (app) => {
    await app.register(routes)
  }
}

export default systemoneExtension
