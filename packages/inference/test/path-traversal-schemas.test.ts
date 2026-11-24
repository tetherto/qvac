import test from 'brittle'
import { audioInputSchema } from '@/schemas/transcription'
import { imageInputSchema } from '@/schemas/ocr'
import { attachmentSchema } from '@/schemas/completion-stream'

// ============== Category B schemas (absolute user paths) ==============
// These MUST continue to accept all paths — the user intentionally points
// us at files on their filesystem. These are regression guards:
// if someone adds blanket .. rejection to these schemas, these tests break.

test('audioInputSchema filePath accepts user paths (no-regression)', (t) => {
  const paths = [
    '/Users/me/audio.wav',
    '/opt/media/file.mp3',
    'C:\\Users\\me\\audio.wav',
    './audio.wav',
    '../recordings/file.mp3',
    'relative/path/audio.wav'
  ]
  for (const p of paths) {
    const result = audioInputSchema.safeParse({ type: 'filePath', value: p })
    t.ok(result.success, `must accept user path: ${p}`)
  }
})

test('imageInputSchema filePath accepts user paths (no-regression)', (t) => {
  const paths = ['/Users/me/image.png', '/opt/media/photo.jpg', './image.png', '../photos/pic.jpg']
  for (const p of paths) {
    const result = imageInputSchema.safeParse({ type: 'filePath', value: p })
    t.ok(result.success, `must accept user path: ${p}`)
  }
})

test('attachmentSchema accepts user paths (no-regression)', (t) => {
  const paths = ['/Users/me/doc.pdf', '/tmp/attachment.txt', './doc.pdf', '../documents/report.pdf']
  for (const p of paths) {
    const result = attachmentSchema.safeParse({ path: p })
    t.ok(result.success, `must accept user path: ${p}`)
  }
})
