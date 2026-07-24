/* global Bare */
// Stow fixture: echoes ipc data; 'die' → hard exit, argv 'die-early' → exit before ready.
export default async function start(ipc, ready) {
  Bare.IPC.on('end', () => Bare.exit(0)).on('close', () => Bare.exit(0))
  if (Bare.argv[2] === 'die-early') Bare.exit(3)
  ipc.on('data', (data) => {
    if (data.toString() === 'die') Bare.exit(7)
    else ipc.write(data)
  })
  ready()
  return noop
}

function noop() {}
