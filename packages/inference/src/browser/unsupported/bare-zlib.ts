import { unsupported } from '../unsupported'

const stub = unsupported('bare-zlib')

export default stub
export const createGunzip = stub.createGunzip
