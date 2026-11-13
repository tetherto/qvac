import Buffer from 'bare-buffer'

// Model bytes shared by the cross-process download tests and their child processes.
export const MODEL_CONTENT = Buffer.alloc(400_000)
for (let i = 0; i < MODEL_CONTENT.length; i++) MODEL_CONTENT[i] = (i * 7) % 251
