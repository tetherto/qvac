import { QvacResponse, createJobHandler } from '@qvac/infer-base'

async function cancelHandler() {}

const signal = new AbortController().signal
const response = new QvacResponse<string>({ cancelHandler, signal })
const handler = createJobHandler({ cancel: cancelHandler })

handler.start({ signal })

void [response, handler]
