import { unsupported } from '../unsupported'

const stub = unsupported('bare-subprocess')

export default stub
export const spawnSync = stub.spawnSync
