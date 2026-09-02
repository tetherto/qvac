import type { ServeExtension } from '@/serve/core/extensions'

const defaultExtension: ServeExtension = {
  name: 'default',
  description: 'QVAC-native REST API',
  // lunte-disable-next-line require-await
  async register() {}
}

export default defaultExtension
