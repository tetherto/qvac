// Bare worker that sends back every chunk it receives.

export default function start(ipc) {
  ipc.on('data', (data) => ipc.write(data))
}
